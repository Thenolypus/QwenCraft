import { ToolContext, ToolResult } from "../types";
import { inventoryCounts, itemCount } from "../utils";
import { blockDefinition, findBlockMatching, itemDefinition, placeHeldAt, resultFromError, success } from "./helpers";

interface RecipeCandidate {
  recipe: any;
  requiresTable: boolean;
  index: number;
}

const STONE_CRAFTING_MATERIALS = ["cobblestone", "cobbled_deepslate", "blackstone"];

export function missingMaterialsForRecipe(bot: any, recipe: any, crafts = 1): Record<string, number> {
  const counts = inventoryCounts(bot);
  const missing: Record<string, number> = {};
  for (const delta of recipe.delta ?? []) {
    if (delta.count >= 0) continue;
    const item = bot.registry.items[delta.id];
    const need = Math.abs(delta.count) * crafts;
    const have = counts[item.name] ?? 0;
    if (have < need) missing[item.name] = need - have;
  }
  return missing;
}

function missingDetail(missing: Record<string, number>): string {
  return Object.entries(missing)
    .map(([name, count]) => `missing ${count} ${name}`)
    .join(", ");
}

function relatedInventoryNames(name: string): string[] {
  const families = ingredientFamilies(name);
  const names = new Set<string>();
  if (name.endsWith("_planks")) {
    const wood = name.slice(0, -"_planks".length);
    [
      `${wood}_log`,
      `${wood}_wood`,
      `stripped_${wood}_log`,
      `stripped_${wood}_wood`,
      `${wood}_stem`,
      `${wood}_hyphae`,
      `stripped_${wood}_stem`,
      `stripped_${wood}_hyphae`
    ].forEach((related) => names.add(related));
  }
  if (families.includes("stone_crafting_material")) {
    STONE_CRAFTING_MATERIALS.forEach((related) => names.add(related));
    names.add("stone");
  }
  return [...names];
}

function ingredientFamilies(name: string): string[] {
  const families: string[] = [];
  if (name.endsWith("_planks")) families.push("planks");
  if (STONE_CRAFTING_MATERIALS.includes(name)) families.push("stone_crafting_material");
  return families;
}

function inventoryHasSameFamily(counts: Record<string, number>, name: string): boolean {
  const families = ingredientFamilies(name);
  if (!families.length) return false;
  return Object.entries(counts).some(([inventoryName, count]) => count > 0 && ingredientFamilies(inventoryName).some((family) => families.includes(family)));
}

function relatedInventoryMatches(counts: Record<string, number>, missing: Record<string, number>): number {
  return Object.keys(missing).filter(
    (name) => inventoryHasSameFamily(counts, name) || relatedInventoryNames(name).some((related) => (counts[related] ?? 0) > 0)
  ).length;
}

function missingPreference(missing: Record<string, number>): number {
  return Object.keys(missing).reduce((score, name) => {
    if (STONE_CRAFTING_MATERIALS.includes(name)) return score + STONE_CRAFTING_MATERIALS.indexOf(name);
    if (name.endsWith("_planks")) return score + (name === "oak_planks" ? 0 : 1);
    return score;
  }, 0);
}

export function bestMissingRecipeCandidate(bot: any, candidates: RecipeCandidate[], crafts: number): RecipeCandidate | null {
  const counts = inventoryCounts(bot);
  return candidates
    .map((candidate) => {
      const missing = missingMaterialsForRecipe(bot, candidate.recipe, crafts);
      const missingTotal = Object.values(missing).reduce((sum, count) => sum + count, 0);
      return {
        candidate,
        missing,
        missingTotal,
        missingTypes: Object.keys(missing).length,
        relatedMatches: relatedInventoryMatches(counts, missing),
        preference: missingPreference(missing)
      };
    })
    .sort((left, right) => {
      if (left.missingTotal !== right.missingTotal) return left.missingTotal - right.missingTotal;
      if (left.missingTypes !== right.missingTypes) return left.missingTypes - right.missingTypes;
      if (left.relatedMatches !== right.relatedMatches) return right.relatedMatches - left.relatedMatches;
      if (left.preference !== right.preference) return left.preference - right.preference;
      return left.candidate.index - right.candidate.index;
    })[0]?.candidate ?? null;
}

async function craftingTable(bot: any, context: ToolContext): Promise<any | null> {
  const tables = findBlockMatching(bot, (block) => block.name === "crafting_table", 16, 1);
  if (tables[0]) return tables[0];
  if (itemCount(bot, "crafting_table") <= 0) return null;
  const pos = bot.entity.position.offset(1, 0, 0).floored();
  const item = bot.inventory.items().find((candidate: any) => candidate.name === "crafting_table");
  await bot.equip(item, "hand");
  await placeHeldAt(context, pos);
  return bot.blockAt(pos);
}

/**
 * Crafts a named item using the 2x2 grid or a nearby/placed crafting table.
 * Fails with exact missing materials when no craftable recipe is available.
 */
export async function craftTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  try {
    const itemName = String(args.item);
    const count = Number(args.count);
    const item = itemDefinition(context.bot, itemName);
    if (!item) return { status: "failed", detail: `craft failed: unknown item ${itemName}` };

    let table: any | null = null;
    let recipes = context.bot.recipesFor(item.id, null, count, null);
    if (!recipes.length) {
      table = await craftingTable(context.bot, context);
      recipes = context.bot.recipesFor(item.id, null, count, table);
    }
    if (!recipes.length) {
      const allRecipes = [
        ...context.bot.recipesAll(item.id, null, null).filter(Boolean).map((recipe: any, index: number) => ({ recipe, requiresTable: false, index })),
        ...context.bot
          .recipesAll(item.id, null, table ?? blockDefinition(context.bot, "crafting_table"))
          .filter(Boolean)
          .map((recipe: any, index: number) => ({ recipe, requiresTable: true, index: index + 100000 }))
      ];
      const best = bestMissingRecipeCandidate(context.bot, allRecipes, count);
      const missing = best ? missingMaterialsForRecipe(context.bot, best.recipe, count) : {};
      const details = Object.keys(missing).length ? [missingDetail(missing)] : [];
      if (best?.requiresTable && table === null) details.push("no crafting_table nearby (craft or place one)");
      const detail = details.length ? details.join(", ") : "no recipe available";
      return { status: "failed", detail: `craft failed: ${detail}` };
    }
    await context.bot.craft(recipes[0], count, table);
    return success(`crafted ${count} ${itemName}`);
  } catch (error) {
    return resultFromError("craft", error);
  }
}
