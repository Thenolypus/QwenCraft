import { ToolContext, ToolResult } from "../types";
import { isHostile, nearestEntity } from "../utils";
import { gotoNear, resultFromError, success } from "./helpers";

const SAFE_DISTANCE = 12;

function nearestHostileEntity(context: ToolContext): any | null {
  return nearestEntity(context.bot, (entity) => isHostile(entity.name), context.config.entity_radius_blocks);
}

/**
 * Moves away from the nearest hostile in hops of `distance` blocks until no
 * hostile is within SAFE_DISTANCE or the hop budget runs out. A single fixed
 * hop evaporates while the planner is deciding its next move; hopping until
 * actually safe does not.
 */
export async function fleeFromNearestHostile(distance: number, context: ToolContext, maxHops = 3): Promise<ToolResult> {
  let hostile = nearestHostileEntity(context);
  if (!hostile) return { status: "failed", detail: "flee failed: no hostile entity nearby" };
  const firstName = hostile.name;
  let hops = 0;
  do {
    const pos = context.bot.entity.position;
    const away = pos.minus(hostile.position);
    const length = Math.max(1, Math.sqrt(away.x * away.x + away.z * away.z));
    const target = pos.offset((away.x / length) * distance, 0, (away.z / length) * distance);
    await gotoNear(context, Math.floor(target.x), Math.floor(pos.y), Math.floor(target.z), 3);
    hops += 1;
    hostile = nearestHostileEntity(context);
  } while (hostile && hops < maxHops && context.bot.entity.position.distanceTo(hostile.position) < SAFE_DISTANCE);

  const remaining = hostile ? context.bot.entity.position.distanceTo(hostile.position) : Number.POSITIVE_INFINITY;
  const closeness =
    remaining < SAFE_DISTANCE ? `; ${hostile.name} still ${remaining.toFixed(0)} blocks away` : "; no hostile within safe range";
  return success(`fled ${hops * distance} blocks from ${firstName}${closeness}`);
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
