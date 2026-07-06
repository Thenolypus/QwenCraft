import { ToolContext, ToolResult } from "../types";
import { findInventoryItem } from "../utils";
import { resultFromError, success } from "./helpers";

const foodPriority = ["cooked_beef", "cooked_porkchop", "bread", "baked_potato", "cooked_chicken", "cooked_mutton", "apple", "carrot", "potato", "beef", "porkchop", "chicken", "mutton"];

/**
 * Eats a named food or the best available food according to a small survival priority list.
 * Fails when no edible item can be found or the bot cannot equip/eat it.
 */
export async function eatTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    const requested = typeof args.item === "string" ? args.item : null;
    const item = requested
      ? findInventoryItem(context.bot, requested)
      : (context.bot.inventory.items() as any[]).find((candidate) => foodPriority.includes(candidate.name) || candidate.foodPoints);
    if (!item) return { status: "failed", detail: requested ? `eat failed: missing ${requested}` : "eat failed: no food available" };
    await context.bot.equip(item, "hand");
    await context.bot.eat();
    return success(`ate ${item.name}`);
  } catch (error) {
    return resultFromError("eat", error);
  }
}

