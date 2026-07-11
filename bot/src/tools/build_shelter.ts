import { Vec3 } from "vec3";
import { ToolContext, ToolResult } from "../types";
import { findAnyInventoryItem, findInventoryItem, itemCount } from "../utils";
import { placeHeldAt, resultFromError, shelterDetail } from "./helpers";

async function placeMaterial(context: ToolContext, target: Vec3): Promise<boolean> {
  const material = findAnyInventoryItem(context.bot, ["dirt", "cobblestone"]);
  if (!material) return false;
  const existing = context.bot.blockAt(target);
  if (existing && existing.name !== "air" && existing.boundingBox !== "empty") return true;
  await context.bot.equip(material, "hand");
  await placeHeldAt(context, target);
  return true;
}

async function dirtBox(context: ToolContext): Promise<ToolResult> {
  const base = context.bot.entity.position.floored();
  const targets: Vec3[] = [];
  for (let x = -1; x <= 1; x += 1) {
    for (let z = -1; z <= 1; z += 1) {
      targets.push(base.offset(x, 2, z));
      if (Math.abs(x) === 1 || Math.abs(z) === 1) {
        targets.push(base.offset(x, 0, z));
        targets.push(base.offset(x, 1, z));
      }
    }
  }
  // Fail fast with the exact shortfall instead of burning material on a
  // half-built box that gives no cover and no way to finish.
  const unfilled = targets.filter((target) => {
    const existing = context.bot.blockAt(target);
    return !existing || existing.name === "air" || existing.boundingBox === "empty";
  });
  const available = itemCount(context.bot, "dirt") + itemCount(context.bot, "cobblestone");
  if (available < unfilled.length) {
    return {
      status: "failed",
      detail: `build_shelter failed: dirt_box needs ${unfilled.length} blocks (dirt/cobblestone), have ${available}; gather more or use style=dig_in`
    };
  }
  for (const target of targets) {
    if (!(await placeMaterial(context, target))) {
      return { status: "failed", detail: "build_shelter failed: missing dirt/cobblestone for dirt_box" };
    }
  }
  const torch = findInventoryItem(context.bot, "torch");
  if (torch) {
    try {
      await context.bot.equip(torch, "hand");
      await placeHeldAt(context, base.offset(0, 1, 0));
    } catch {
      // Torch is helpful, not required for shelter success.
    }
  }
  return { status: "success", detail: shelterDetail("dirt_box", base) };
}

async function digIn(context: ToolContext): Promise<ToolResult> {
  const base = context.bot.entity.position.floored();
  const forward = new Vec3(0, 0, 1);
  for (let i = 1; i <= 3; i += 1) {
    const head = context.bot.blockAt(base.plus(forward.scaled(i)).offset(0, 1, 0));
    const foot = context.bot.blockAt(base.plus(forward.scaled(i)));
    if (head && head.name !== "air") await context.bot.dig(head);
    if (foot && foot.name !== "air") await context.bot.dig(foot);
  }
  await placeMaterial(context, base);
  return { status: "success", detail: shelterDetail("dig_in", base) };
}

/**
 * Builds a small sealed shelter from dirt/cobblestone or digs a short tunnel and seals it.
 * Fails when there is not enough material or terrain placement/digging is blocked.
 */
export async function buildShelterTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    const style = String(args.style);
    if (style === "dirt_box") return await dirtBox(context);
    if (style === "dig_in") return await digIn(context);
    return { status: "failed", detail: `build_shelter failed: unknown style ${style}` };
  } catch (error) {
    return resultFromError("build_shelter", error);
  }
}

