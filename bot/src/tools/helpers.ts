import { Vec3 } from "vec3";
import { Movements, goals } from "mineflayer-pathfinder";
import { ToolContext, ToolResult } from "../types";
import { assertNotAborted, delay, findAnyInventoryItem, findInventoryItem, isAbortError, normalizeError } from "../utils";
import { logInfo } from "../logger";

const { GoalNear, GoalBlock } = goals;

export function success(detail: string): ToolResult {
  return { status: "success", detail };
}

export function failed(detail: string): ToolResult {
  return { status: "failed", detail };
}

export function interrupted(detail: string): ToolResult {
  return { status: "interrupted", detail };
}

export function resultFromError(tool: string, error: unknown): ToolResult {
  const message = normalizeError(error);
  if (isAbortError(error)) return interrupted(`${tool} interrupted: ${message}`);
  return failed(`${tool} failed: ${message}`);
}

export function configureMovements(context: ToolContext): any {
  const movements: any = new Movements(context.bot);
  movements.canDig = true;
  movements.allow1by1towers = true;
  movements.allowParkour = false;
  const scaffoldItems = context.bot.inventory
    ?.items?.()
    ?.filter((item: any) => ["dirt", "cobblestone", "stone"].includes(item.name))
    .map((item: any) => item.type);
  if (scaffoldItems?.length) movements.scafoldingBlocks = scaffoldItems;
  context.bot.pathfinder.setMovements(movements);
  // Dig-enabled A* at large radius allocates hundreds of MB per stuck search; keep the
  // budget small and rely on mine_block's next-candidate fallback instead of long thinks.
  context.bot.pathfinder.thinkTimeout = 2000;
  context.bot.pathfinder.tickTimeout = 25;
  context.bot.pathfinder.searchRadius = Math.max(48, context.config.scan_radius_blocks + 16);
  return movements;
}

// interruptible() used to be abandon-based: on abort it stopped visible bot behavior and
// settled our wrapper promise immediately, but walked away from `promise` itself. That
// promise (a pathfinder goto or a collectBlock.collect) keeps running underneath, pinning
// its Movements/targets/block state until it eventually settles on its own (or never does),
// and a fast-retrying caller can pile up more of these across dispatches. Cancel the
// collectBlock task explicitly and await `promise`'s actual settlement, bounded by a short
// grace period, before handing control back.
const DRAIN_GRACE_MS = 3000;

async function drainAbandoned(context: ToolContext, promise: Promise<unknown>): Promise<void> {
  const cancelled = context.bot.collectBlock?.cancelTask?.();
  const pending = [promise, cancelled].filter((candidate): candidate is Promise<unknown> => Boolean(candidate));
  const drained = Promise.allSettled(pending).then(() => "drained" as const);
  const timedOut = delay(DRAIN_GRACE_MS).then(() => "timed_out" as const);
  const outcome = await Promise.race([drained, timedOut]);
  if (outcome === "timed_out") {
    logInfo("tool abort drain timed out", {
      reason: String(context.signal.reason ?? "interrupted"),
      grace_ms: DRAIN_GRACE_MS,
      heap_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    });
  }
}

async function interruptible<T>(context: ToolContext, promise: Promise<T>): Promise<T> {
  assertNotAborted(context.signal);
  let aborting = false;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      aborting = true;
      context.bot.pathfinder?.stop?.();
      // stop() is graceful and leaves an in-flight path computation running to its
      // think budget; setGoal(null) drops the A* state immediately.
      context.bot.pathfinder?.setGoal?.(null);
      context.bot.pvp?.stop?.();
      void drainAbandoned(context, promise).then(() => {
        reject(new Error(String(context.signal.reason ?? "interrupted")));
      });
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        context.signal.removeEventListener("abort", onAbort);
        if (!aborting) resolve(value);
      },
      (error) => {
        context.signal.removeEventListener("abort", onAbort);
        if (!aborting) reject(error);
      }
    );
  });
}

export async function gotoNear(context: ToolContext, x: number, y: number, z: number, range = 1): Promise<void> {
  assertNotAborted(context.signal);
  configureMovements(context);
  await interruptible(context, context.bot.pathfinder.goto(new GoalNear(x, y, z, range)));
  assertNotAborted(context.signal);
}

export async function gotoBlock(context: ToolContext, pos: Vec3): Promise<void> {
  assertNotAborted(context.signal);
  configureMovements(context);
  await interruptible(context, context.bot.pathfinder.goto(new GoalBlock(pos.x, pos.y, pos.z)));
  assertNotAborted(context.signal);
}

export async function collectBlockInterruptible(context: ToolContext, block: any): Promise<void> {
  await interruptible(context, context.bot.collectBlock.collect(block));
}

export async function equipByName(context: ToolContext, name: string, destination: "hand" | "off-hand" = "hand"): Promise<boolean> {
  const item = findInventoryItem(context.bot, name);
  if (!item) return false;
  await context.bot.equip(item, destination);
  return true;
}

export async function equipAny(context: ToolContext, names: string[], destination: "hand" | "off-hand" = "hand"): Promise<any | null> {
  const item = findAnyInventoryItem(context.bot, names);
  if (!item) return null;
  await context.bot.equip(item, destination);
  return item;
}

export function itemDefinition(bot: any, name: string): any | null {
  return bot.registry?.itemsByName?.[name] ?? null;
}

export function blockDefinition(bot: any, name: string): any | null {
  return bot.registry?.blocksByName?.[name] ?? null;
}

export function blockAtName(bot: any, name: string, maxDistance: number): any | null {
  const def = blockDefinition(bot, name);
  if (!def) return null;
  const pos = bot.findBlock({ matching: def.id, maxDistance });
  return pos ? bot.blockAt(pos.position ?? pos) : null;
}

export function findBlocksByName(bot: any, name: string, maxDistance: number, count: number): any[] {
  const def = blockDefinition(bot, name);
  if (!def) return [];
  const positions = bot.findBlocks({ matching: def.id, maxDistance, count });
  return positions.map((pos: Vec3) => bot.blockAt(pos)).filter(Boolean);
}

export function findBlockMatching(bot: any, predicate: (block: any) => boolean, maxDistance: number, count = 1): any[] {
  const positions = bot.findBlocks({ matching: predicate, maxDistance, count });
  return positions.map((pos: Vec3) => bot.blockAt(pos)).filter(Boolean);
}

export async function placeHeldAt(context: ToolContext, target: Vec3): Promise<void> {
  const neighbors = [
    { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
    { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },
    { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
    { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
    { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
    { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) }
  ];
  for (const neighbor of neighbors) {
    const reference = context.bot.blockAt(target.plus(neighbor.offset));
    if (reference && reference.name !== "air" && reference.boundingBox === "block") {
      await context.bot.placeBlock(reference, neighbor.face);
      return;
    }
  }
  throw new Error("no adjacent solid reference block");
}

export function shelterDetail(style: string, pos: Vec3): string {
  return `built ${style} shelter at [${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}]`;
}
