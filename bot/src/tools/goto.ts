import { ToolContext, ToolResult } from "../types";
import { gotoNear, resultFromError, success } from "./helpers";

/**
 * Pathfinds to a coordinate with digging and simple dirt/cobblestone scaffolding enabled.
 * Fails when pathfinder cannot find or complete a path before timeout/interruption.
 */
export async function gotoTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    const x = Number(args.x);
    const y = Number(args.y);
    const z = Number(args.z);
    await gotoNear(context, x, y, z, 1);
    return success(`goto reached [${x}, ${y}, ${z}]`);
  } catch (error) {
    return resultFromError("goto", error);
  }
}

