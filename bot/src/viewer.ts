import type { Bot } from "mineflayer";
import type { Config } from "./types";

export async function maybeStartViewer(bot: Bot, config: Config): Promise<void> {
  if (!config.viewer_enabled) return;
  const viewer = await import("prismarine-viewer");
  viewer.mineflayer(bot, { port: 3007, firstPerson: true });
}
