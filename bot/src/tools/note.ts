import { ToolContext, ToolResult } from "../types";

/**
 * Acknowledges pinned-memory notes for clients that accidentally dispatch this to the bot.
 * The Python brain owns memory and applies the actual note mutation locally.
 */
export async function noteTool(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
  return { status: "success", detail: `note acknowledged: ${String(args.key)}=${String(args.value)}` };
}

