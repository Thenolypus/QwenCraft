import type { Bot } from "mineflayer";
import type { Config, RuntimeState, ToolResult } from "./types";
import { fleeFromNearestHostile } from "./tools/flee";
import { isHostile, normalizeError } from "./utils";

interface ReflexOptions {
  bot: Bot;
  config: Config;
  isToolRunning: () => boolean;
  currentToolName: () => string | null;
  interruptCurrent: (reason?: string) => void;
  emitEvent: (name: string, data?: Record<string, unknown>) => void;
}

export function installReflexes(options: ReflexOptions): void {
  const { bot, config, isToolRunning, currentToolName, interruptCurrent, emitEvent } = options;
  let emergencyRunning = false;
  let nextEmergencyAt = 0;
  let keepAwayRunning = false;
  let nextKeepAwayAt = 0;
  let autoEatRunning = false;
  let nextAutoEatAt = 0;
  let lastHungerEventAt = 0;
  let lastHostileEventAt = 0;
  let lastNightEventAt = 0;
  let lastHealth = bot.health ?? 20;

  bot.on("health", async () => {
    const now = Date.now();
    if ((bot.health ?? 20) < lastHealth) {
      emitEvent("damage_taken", {
        health: bot.health,
        previous_health: lastHealth
      });
    }
    lastHealth = bot.health ?? lastHealth;

    if ((bot.food ?? 20) < 10 && now - lastHungerEventAt > 8000) {
      lastHungerEventAt = now;
      emitEvent("hunger_low", { hunger: bot.food });
    }

    if (
      (bot.health ?? 20) < 6 &&
      !emergencyRunning &&
      now >= nextEmergencyAt &&
      currentToolName() !== "flee"
    ) {
      emergencyRunning = true;
      interruptCurrent("health below 6");
      emitEvent("emergency", { health: bot.health, action: "auto_flee" });
      const controller = new AbortController();
      try {
        const result: ToolResult = await fleeFromNearestHostile(16, {
          bot,
          config,
          signal: controller.signal,
          emitEvent,
          recentEvents: [],
          stopCurrent: interruptCurrent
        });
        emitEvent("emergency", { health: bot.health, result: result.detail });
      } catch (error) {
        emitEvent("emergency", { health: bot.health, result: `auto_flee failed: ${normalizeError(error)}` });
      } finally {
        emergencyRunning = false;
        nextEmergencyAt = Date.now() + 10_000;
      }
    }
  });

  bot.on("physicsTick", () => {
    const now = Date.now();
    if (!isToolRunning() && !autoEatRunning && now >= nextAutoEatAt && (bot.food ?? 20) < 14 && "autoEat" in bot) {
      autoEatRunning = true;
      void (bot as unknown as { autoEat: { eat: () => Promise<void> } }).autoEat.eat().then(
        () => {
          autoEatRunning = false;
          nextAutoEatAt = Date.now() + 5000;
          emitEvent("hunger_low", { hunger: bot.food, reflex: "auto_eat" });
        },
        (error: unknown) => {
          autoEatRunning = false;
          nextAutoEatAt = Date.now() + 15000;
          emitEvent("hunger_low", { hunger: bot.food, reflex: "auto_eat_failed", error: String(error) });
        }
      );
    }

    const nearestHostile = Object.values(bot.entities)
      .filter((entity) => entity.position && entity.id !== bot.entity.id)
      .map((entity) => ({
        entity,
        dist: bot.entity.position.distanceTo(entity.position)
      }))
      .filter(({ entity, dist }) => dist <= 6 && isHostile(entity.name ?? entity.type))
      .sort((a, b) => a.dist - b.dist)[0];
    if (nearestHostile && now - lastHostileEventAt > 5000) {
      lastHostileEventAt = now;
      emitEvent("hostile_close", {
        type: nearestHostile.entity.name ?? nearestHostile.entity.type,
        dist: Number(nearestHostile.dist.toFixed(1))
      });
    }

    // Between tool calls the bot stands still while the planner thinks, letting
    // melee mobs walk up and land free hits. Only when idle (so it can never
    // fight a running tool), step away from a hostile in contact range.
    if (nearestHostile && nearestHostile.dist <= 4 && !isToolRunning() && !emergencyRunning && !keepAwayRunning && now >= nextKeepAwayAt) {
      keepAwayRunning = true;
      const controller = new AbortController();
      void fleeFromNearestHostile(
        8,
        { bot, config, signal: controller.signal, emitEvent, recentEvents: [], stopCurrent: interruptCurrent },
        1
      )
        .then(
          (result: ToolResult) => emitEvent("keep_away", { result: result.detail }),
          (error: unknown) => emitEvent("keep_away", { result: `keep_away failed: ${normalizeError(error)}` })
        )
        .then(() => {
          keepAwayRunning = false;
          nextKeepAwayAt = Date.now() + 5000;
        });
    }

    const timeOfDay = bot.time?.timeOfDay ?? 0;
    if (timeOfDay >= 12000 && timeOfDay < 13000 && now - lastNightEventAt > 20000) {
      lastNightEventAt = now;
      emitEvent("night_falling", { minutes_to_night: Number(((13000 - timeOfDay) / 20 / 60).toFixed(1)) });
    }
  });

  bot.on("death", () => emitEvent("death", { position: bot.entity?.position?.toString() ?? "unknown" }));
}

export function setupReflexes(
  bot: any,
  config: Config,
  state: RuntimeState,
  emitEvent: (name: string, data?: Record<string, unknown>) => void
): void {
  installReflexes({
    bot,
    config,
    isToolRunning: () => !!state.currentTool,
    currentToolName: () => state.currentTool?.name ?? null,
    interruptCurrent: (reason?: string) => {
      state.currentTool?.controller.abort(reason);
      bot.pathfinder?.stop?.();
      bot.pathfinder?.setGoal?.(null);
      bot.pvp?.stop?.();
    },
    emitEvent
  });
}
