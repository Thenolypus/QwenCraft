import { Vec3 } from "vec3";
import { ToolContext, ToolResult } from "../types";
import { findInventoryItem } from "../utils";
import { placeHeldAt, resultFromError, success } from "./helpers";

/**
 * Places an inventory block at the requested coordinate using an adjacent solid block as reference.
 * Fails when the block is missing, the target is occupied, or no reference face exists.
 */
export async function placeBlockTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    const type = String(args.type);
    const target = new Vec3(Number(args.x), Number(args.y), Number(args.z));
    const item = findInventoryItem(context.bot, type);
    if (!item) return { status: "failed", detail: `place_block failed: missing ${type}` };
    const existing = context.bot.blockAt(target);
    if (existing && existing.name !== "air" && existing.boundingBox !== "empty") {
      return { status: "failed", detail: `place_block failed: target occupied by ${existing.name}` };
    }
    await context.bot.equip(item, "hand");
    await placeHeldAt(context, target);
    return success(`placed ${type} at [${target.x}, ${target.y}, ${target.z}]`);
  } catch (error) {
    return resultFromError("place_block", error);
  }
}

