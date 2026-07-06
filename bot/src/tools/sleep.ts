import { ToolContext, ToolResult } from "../types";
import { findBlockMatching, resultFromError, success } from "./helpers";

function isNight(bot: any): boolean {
  const time = Number(bot.time?.timeOfDay ?? 0);
  return time >= 12541 && time <= 23458;
}

/**
 * Sleeps in the nearest bed within 16 blocks when Minecraft allows sleeping.
 * Fails with a concrete cause for no bed, daytime, or unsafe/mob-blocked sleep.
 */
export async function sleepTool(_args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    if (!isNight(context.bot)) return { status: "failed", detail: "sleep failed: not night" };
    const beds = findBlockMatching(context.bot, (block) => block.name.endsWith("_bed"), 16, 1);
    if (!beds[0]) return { status: "failed", detail: "sleep failed: no bed within 16 blocks" };
    await context.bot.sleep(beds[0]);
    return success("slept until morning");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("monster") || message.toLowerCase().includes("mob")) {
      return { status: "failed", detail: "sleep failed: mobs nearby" };
    }
    return resultFromError("sleep", error);
  }
}

