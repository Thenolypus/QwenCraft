import { ToolContext, ToolResult } from "../types";

/**
 * Acknowledges goal updates for clients that accidentally dispatch this to the bot.
 * The Python brain owns memory and applies the actual goal mutation locally.
 */
export async function setGoalTool(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
  return { status: "success", detail: `goal noted: ${String(args.text)}` };
}

