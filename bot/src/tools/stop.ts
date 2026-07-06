import { ToolContext, ToolResult } from "../types";

/**
 * Cancels the current pathfinder/PVP action and aborts the running tool controller.
 * Always resolves successfully because stop is a control-plane operation.
 */
export async function stopTool(_args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  context.stopCurrent("stop requested");
  context.bot.pathfinder?.stop?.();
  context.bot.pvp?.stop?.();
  return { status: "success", detail: "stop requested" };
}

