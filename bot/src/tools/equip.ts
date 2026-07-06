import { ToolContext, ToolResult } from "../types";
import { assertNotAborted, findInventoryItem } from "../utils";
import { failed, resultFromError, success } from "./helpers";

type EquipDestination = "hand" | "head" | "torso" | "legs" | "feet";

function destinationForItem(item: string): EquipDestination {
  if (item.endsWith("_helmet")) return "head";
  if (item.endsWith("_chestplate") || item === "elytra") return "torso";
  if (item.endsWith("_leggings")) return "legs";
  if (item.endsWith("_boots")) return "feet";
  return "hand";
}

export async function equipTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    assertNotAborted(context.signal);
    const itemName = String(args.item);
    const item = findInventoryItem(context.bot, itemName);
    if (!item) return failed(`equip failed: ${itemName} not in inventory`);
    const destination = destinationForItem(itemName);
    await context.bot.equip(item, destination);
    return success(`equipped ${itemName} to ${destination}`);
  } catch (error) {
    return resultFromError("equip", error);
  }
}
