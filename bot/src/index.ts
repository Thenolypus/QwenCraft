import fs from "node:fs";
import crypto from "node:crypto";
import Ajv from "ajv/dist/2020.js";
import mineflayer from "mineflayer";
import { loader as autoEat } from "mineflayer-auto-eat";
import { plugin as collectBlock } from "mineflayer-collectblock";
import { pathfinder } from "mineflayer-pathfinder";
import { plugin as pvp } from "mineflayer-pvp";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig, repoPath } from "./config";
import { logError, logInfo } from "./logger";
import { buildObservation } from "./observation";
import { setupReflexes } from "./reflexes";
import { ToolCallMessage, ToolResult, RuntimeState, MemorySnapshot } from "./types";
import { toolRegistry, timeoutSecondsForTool } from "./tools";
import { maybeStartViewer } from "./viewer";

const config = loadConfig();
const toolsSpec = JSON.parse(fs.readFileSync(repoPath("schemas", "tools.schema.json"), "utf8"));
const observationSchema = JSON.parse(fs.readFileSync(repoPath("schemas", "observation.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateObservation = ajv.compile(observationSchema);
const argValidators = new Map<string, ReturnType<Ajv["compile"]>>();

for (const tool of toolsSpec.tools) {
  argValidators.set(tool.function.name, ajv.compile(tool.function.parameters));
}

const state: RuntimeState = {
  currentTool: null,
  lastAction: null,
  recentEvents: []
};

const testedVersions = (mineflayer as any).testedVersions as string[] | undefined;
if (testedVersions && !testedVersions.includes(config.mc_version)) {
  console.warn(
    `warning: mineflayer ${String((mineflayer as any).latestSupportedVersion)} is the latest tested version; ${config.mc_version} is experimental`
  );
}

const bot = mineflayer.createBot({
  host: config.mc_host,
  port: config.mc_port,
  username: config.bot_username,
  version: config.mc_version,
  auth: "offline"
});

bot.loadPlugin(pathfinder);
bot.loadPlugin(collectBlock);
bot.loadPlugin(pvp);
bot.loadPlugin(autoEat);

const wss = new WebSocketServer({ host: "127.0.0.1", port: config.ws_port });
const clients = new Set<WebSocket>();

function positionString(): string {
  const pos = bot.entity?.position;
  if (!pos) return "unknown";
  return `[${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}]`;
}

function inventorySummary(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of bot.inventory?.items?.() ?? []) {
    counts[item.name] = (counts[item.name] ?? 0) + item.count;
  }
  return Object.fromEntries(Object.entries(counts).slice(0, 8));
}

function currentToolSummary(): string {
  if (!state.currentTool) return "idle";
  const age = Math.round((Date.now() - state.currentTool.startedAt) / 1000);
  return `${state.currentTool.name}:${age}s`;
}

function pushRecentEvent(text: string): void {
  state.recentEvents.push(text);
  while (state.recentEvents.length > 15) state.recentEvents.shift();
}

function send(socket: WebSocket, payload: Record<string, unknown>): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(payload: Record<string, unknown>): void {
  for (const client of clients) send(client, payload);
}

function emitEvent(name: string, data: Record<string, unknown> = {}): void {
  logInfo("event", { name, data });
  broadcast({ type: "event", name, data });
}

function haltActiveBehaviors(): void {
  bot.pathfinder?.stop?.();
  bot.pathfinder?.setGoal?.(null);
  bot.pvp?.stop?.();
}

function stopCurrent(reason = "interrupted"): void {
  state.currentTool?.controller.abort(reason);
  haltActiveBehaviors();
}

function timeoutResult(tool: string, seconds: number): ToolResult {
  return { status: "failed", detail: `${tool} failed: timed out after ${seconds}s` };
}

async function executeToolCall(message: ToolCallMessage, socket: WebSocket): Promise<void> {
  const handler = toolRegistry[message.tool];
  if (!handler) {
    logInfo("tool rejected", { tool: message.tool, reason: "unknown" });
    send(socket, { id: message.id, type: "tool_result", status: "failed", detail: `unknown tool ${message.tool}` });
    return;
  }

  const validateArgs = argValidators.get(message.tool);
  if (validateArgs && !validateArgs(message.args)) {
    const detail = ajv.errorsText(validateArgs.errors, { separator: "; " });
    logInfo("tool rejected", { tool: message.tool, detail });
    send(socket, { id: message.id, type: "tool_result", status: "failed", detail: `${message.tool} args invalid: ${detail}` });
    return;
  }

  if (message.tool === "stop") {
    const stopped = state.currentTool?.name ?? "idle";
    stopCurrent("stop requested");
    const result: ToolResult = { status: "success", detail: `stop requested (${stopped})` };
    state.lastAction = { tool: message.tool, args: message.args, ...result };
    pushRecentEvent(`stop success: ${result.detail}`);
    logInfo("tool result", { tool: message.tool, status: result.status, detail: result.detail });
    send(socket, { id: message.id, type: "tool_result", ...result });
    return;
  }

  if (state.currentTool && message.tool !== "stop") {
    logInfo("tool rejected", { tool: message.tool, reason: `busy with ${state.currentTool.name}` });
    send(socket, {
      id: message.id,
      type: "tool_result",
      status: "failed",
      detail: `bot busy: ${state.currentTool.name} already running`
    });
    return;
  }

  const controller = new AbortController();
  const seconds = timeoutSecondsForTool(message.tool);
  controller.signal.addEventListener("abort", haltActiveBehaviors, { once: true });
  const timer = setTimeout(() => {
    if (state.currentTool?.id === message.id) stopCurrent(`timeout after ${seconds}s`);
  }, seconds * 1000);
  state.currentTool = { id: message.id, name: message.tool, controller, startedAt: Date.now() };
  logInfo("tool start", { tool: message.tool, args: message.args, timeout_s: seconds, pos: positionString() });

  let result: ToolResult;
  try {
    result = await handler(message.args, {
      bot,
      config,
      signal: controller.signal,
      emitEvent,
      recentEvents: state.recentEvents,
      stopCurrent
    });
    if (controller.signal.aborted && String(controller.signal.reason).startsWith("timeout")) {
      result = timeoutResult(message.tool, seconds);
    } else if (controller.signal.aborted && result.status === "failed") {
      // Abort reasons like "stop requested" or "death" surface as plain errors inside
      // tools; report them as interruptions so the planner can tell them from real failures.
      result = {
        status: "interrupted",
        detail: result.detail.replace(`${message.tool} failed:`, `${message.tool} interrupted:`)
      };
    }
  } catch (error) {
    result = controller.signal.aborted
      ? { status: "interrupted", detail: `${message.tool} interrupted: ${String(controller.signal.reason ?? "interrupted")}` }
      : { status: "failed", detail: `${message.tool} failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", haltActiveBehaviors);
    if (state.currentTool?.id === message.id) state.currentTool = null;
  }

  state.lastAction = { tool: message.tool, args: message.args, ...result };
  pushRecentEvent(`${message.tool} ${result.status}: ${result.detail}`);
  logInfo("tool result", { tool: message.tool, status: result.status, detail: result.detail, pos: positionString() });
  send(socket, { id: message.id, type: "tool_result", ...result });
}

function handleObservationRequest(socket: WebSocket): void {
  const memory: MemorySnapshot = {
    goal: "survive as many nights as possible",
    pinned: {},
    recent_events: state.recentEvents.slice(-15)
  };
  const observation = buildObservation(bot, config, state.lastAction, state.recentEvents, memory);
  if (!validateObservation(observation)) {
    const detail = ajv.errorsText(validateObservation.errors, { separator: "; " });
    pushRecentEvent(`observation validation warning: ${detail}`);
    logInfo("observation validation warning", { detail });
  }
  logInfo("observation", {
    pos: observation.status.position,
    hp: observation.status.health,
    hunger: observation.status.hunger,
    time: observation.status.time,
    danger: observation.status.danger_flags,
    nearby: observation.entities.map((entity) => `${entity.type}@${entity.dist}`).slice(0, 3),
    blocks: observation.blocks_of_interest.map((block) => `${block.type}@${block.nearest_dist}`).slice(0, 4),
    last: observation.last_action?.tool ?? null
  });
  send(socket, { type: "observation", data: observation });
}

wss.on("connection", (socket) => {
  clients.add(socket);
  logInfo("brain connected", { clients: clients.size });
  socket.on("close", () => {
    clients.delete(socket);
    logInfo("brain disconnected", { clients: clients.size });
  });
  socket.on("message", (raw) => {
    let message: any;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: "error", detail: "invalid JSON" });
      return;
    }
    if (message.type === "get_observation") {
      handleObservationRequest(socket);
      return;
    }
    if (message.type === "tool_call") {
      void executeToolCall(message as ToolCallMessage, socket);
      return;
    }
    send(socket, { type: "error", detail: `unknown message type ${String(message.type)}` });
  });
  if (bot.entity) send(socket, { type: "event", name: "spawned", data: { username: bot.username } });
});

bot.once("spawn", () => {
  logInfo("bot spawned", { username: bot.username, server: `${config.mc_host}:${config.mc_port}`, version: config.mc_version });
  if (bot.autoEat) {
    (bot.autoEat as any).options = {
      priority: "foodPoints",
      startAt: 14,
      bannedFood: []
    };
  }
  emitEvent("spawned", { username: bot.username });
  void maybeStartViewer(bot, config);
});

bot.on("death", () => {
  stopCurrent("death");
  pushRecentEvent("death");
  emitEvent("death", {});
});

bot.on("kicked", (reason) => {
  logError("bot kicked", reason);
});

bot.on("error", (error) => {
  logError("bot error", error);
});

setupReflexes(bot, config, state, emitEvent);

setInterval(() => {
  const heap = process.memoryUsage();
  logInfo("status", {
    pos: positionString(),
    hp: bot.health ?? "unknown",
    hunger: bot.food ?? "unknown",
    tool: currentToolSummary(),
    clients: clients.size,
    heap_mb: Math.round(heap.heapUsed / 1024 / 1024),
    inv: inventorySummary()
  });
}, 10_000).unref();

logInfo("websocket listening", { url: `ws://127.0.0.1:${config.ws_port}` });
logInfo("run", { id: crypto.randomUUID() });
