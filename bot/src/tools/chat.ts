import { ToolContext, ToolResult } from "../types";

/**
 * Sends a chat message to the Minecraft server.
 * Fails only if the server rejects chat or the bot connection is unavailable.
 */
export async function chatTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const message = String(args.message);
  context.bot.chat(message);
  return { status: "success", detail: `sent chat: ${message}` };
}

