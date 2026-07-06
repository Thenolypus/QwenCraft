import { ToolContext, ToolResult } from "../types";
import { isHostile, nearestEntity } from "../utils";
import { gotoNear, resultFromError, success } from "./helpers";

/**
 * Moves away from the nearest hostile by projecting a target opposite its position.
 * Fails when no hostile is nearby or the escape target cannot be reached.
 */
export async function fleeFromNearestHostile(distance: number, context: ToolContext): Promise<ToolResult> {
  const hostile = nearestEntity(context.bot, (entity) => isHostile(entity.name), context.config.entity_radius_blocks);
  if (!hostile) return { status: "failed", detail: "flee failed: no hostile entity nearby" };
  const pos = context.bot.entity.position;
  const away = pos.minus(hostile.position);
  const length = Math.max(1, Math.sqrt(away.x * away.x + away.z * away.z));
  const target = pos.offset((away.x / length) * distance, 0, (away.z / length) * distance);
  await gotoNear(context, Math.floor(target.x), Math.floor(pos.y), Math.floor(target.z), 3);
  return success(`fled ${distance} blocks from ${hostile.name}`);
}

/**
 * Moves away from the nearest hostile by projecting a target opposite its position.
 * Fails when no hostile is nearby or the escape target cannot be reached.
 */
export async function fleeTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    const distance = Number(args.distance);
    return await fleeFromNearestHostile(distance, context);
  } catch (error) {
    return resultFromError("flee", error);
  }
}
