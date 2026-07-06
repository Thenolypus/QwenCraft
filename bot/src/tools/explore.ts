import { ToolContext, ToolResult, Direction } from "../types";
import { directionVector } from "../utils";
import { gotoNear, resultFromError, success } from "./helpers";

/**
 * Walks toward a coarse compass direction for the requested distance using pathfinder.
 * Fails when the projected target is unreachable or pathfinder is interrupted.
 */
export async function exploreTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    const direction = args.direction as Direction;
    const distance = Number(args.distance);
    const start = context.bot.entity.position;
    const vector = directionVector(direction);
    const target = start.offset(vector.x * distance, 0, vector.z * distance);
    await gotoNear(context, Math.floor(target.x), Math.floor(start.y), Math.floor(target.z), 3);
    return success(`explored ${direction} for about ${distance} blocks`);
  } catch (error) {
    return resultFromError("explore", error);
  }
}

