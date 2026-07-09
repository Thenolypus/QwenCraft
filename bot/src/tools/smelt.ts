import { ToolContext, ToolResult } from "../types";
import { findAnyInventoryItem, findInventoryItem, itemCount } from "../utils";
import { findBlockMatching, itemDefinition, placeHeldAt, resultFromError, success } from "./helpers";

export const fuelPriority = ["coal", "oak_planks", "spruce_planks", "birch_planks", "jungle_planks", "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks", "oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log"];

async function furnaceBlock(context: ToolContext): Promise<any | null> {
  const nearby = findBlockMatching(context.bot, (block) => block.name === "furnace", 16, 1);
  if (nearby[0]) return nearby[0];
  if (itemCount(context.bot, "furnace") <= 0) return null;
  const item = findInventoryItem(context.bot, "furnace");
  const pos = context.bot.entity.position.offset(1, 0, 0).floored();
  await context.bot.equip(item, "hand");
  await placeHeldAt(context, pos);
  return context.bot.blockAt(pos);
}

/**
 * Smelts a named input item in a nearby or placed furnace with the best available fuel.
 * Fails when no furnace, input, fuel, or output progress is available.
 */
export async function smeltTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    const itemName = String(args.item);
    const count = Number(args.count);
    const inputDef = itemDefinition(context.bot, itemName);
    if (!inputDef) return { status: "failed", detail: `smelt failed: unknown item ${itemName}` };
    const input = findInventoryItem(context.bot, itemName);
    if (!input || input.count < count) {
      return { status: "failed", detail: `smelt failed: missing ${count - (input?.count ?? 0)} ${itemName}` };
    }
    const fuel = findAnyInventoryItem(context.bot, fuelPriority);
    if (!fuel) return { status: "failed", detail: "smelt failed: no fuel (need coal, planks, or logs)" };
    const block = await furnaceBlock(context);
    if (!block) return { status: "failed", detail: "smelt failed: no furnace within 16 blocks or in inventory" };

    const furnace = await context.bot.openFurnace(block);
    try {
      await furnace.putInput(input.type, null, count);
      await furnace.putFuel(fuel.type, null, 1);
      const started = Date.now();
      while (Date.now() - started < 30000) {
        if (context.signal.aborted) throw new Error(String(context.signal.reason ?? "interrupted"));
        if (furnace.outputItem()) {
          await furnace.takeOutput();
          return success(`smelted ${count} ${itemName}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return { status: "failed", detail: `smelt failed: furnace produced no ${itemName} output within 30s` };
    } finally {
      furnace.close();
    }
  } catch (error) {
    return resultFromError("smelt", error);
  }
}

