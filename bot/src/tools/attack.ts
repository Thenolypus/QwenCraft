import { ToolContext, ToolResult } from "../types";
import { bestWeapon, delay, nearestEntity } from "../utils";
import { resultFromError, success } from "./helpers";

/**
 * Engages the nearest requested entity type using mineflayer-pvp and the best available weapon.
 * Returns interrupted if health drops below 8 while fighting.
 */
export async function attackTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    const entityType = String(args.entity_type);
    const health = context.bot.health ?? 20;
    if (health < 8) {
      return { status: "interrupted", detail: `attack refused: health ${health.toFixed(1)} below 8; flee instead` };
    }
    const entity = nearestEntity(context.bot, (candidate) => candidate.name === entityType, context.config.entity_radius_blocks);
    if (!entity) return { status: "failed", detail: `attack failed: no ${entityType} within ${context.config.entity_radius_blocks} blocks` };
    const weapon = bestWeapon(context.bot);
    if (weapon) await context.bot.equip(weapon, "hand");
    context.bot.pvp.attack(entity);
    const started = Date.now();
    while (Date.now() - started < 60000) {
      if (context.signal.aborted) throw new Error(String(context.signal.reason ?? "interrupted"));
      if ((context.bot.health ?? 20) < 8) {
        context.bot.pvp.stop();
        return { status: "interrupted", detail: `attack interrupted: health dropped below 8 while fighting ${entityType}` };
      }
      if (!context.bot.entities[entity.id]) {
        context.bot.pvp.stop();
        return success(`defeated ${entityType}`);
      }
      await delay(500, context.signal);
    }
    context.bot.pvp.stop();
    return { status: "failed", detail: `attack failed: timed out fighting ${entityType}` };
  } catch (error) {
    context.bot.pvp?.stop?.();
    return resultFromError("attack", error);
  }
}
