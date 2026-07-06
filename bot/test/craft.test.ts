import { describe, expect, it } from "vitest";
import { craftTool, missingMaterialsForRecipe } from "../src/tools/craft";

describe("missingMaterialsForRecipe", () => {
  it("reports exact missing ingredients", () => {
    const bot: any = {
      inventory: { items: () => [{ name: "oak_planks", count: 1 }] },
      registry: { items: { 1: { name: "oak_planks" }, 2: { name: "stick" } } }
    };
    const recipe = { delta: [{ id: 1, count: -3 }, { id: 2, count: -2 }, { id: 10, count: 1 }] };

    expect(missingMaterialsForRecipe(bot, recipe, 1)).toEqual({ oak_planks: 2, stick: 2 });
  });
});

describe("craftTool missing recipe diagnostics", () => {
  function botWithInventory(items: Array<{ name: string; count: number }>): any {
    const recipeItems = {
      1: { name: "cherry_planks" },
      2: { name: "oak_planks" },
      3: { name: "stick" },
      10: { name: "wooden_pickaxe" }
    };
    const recipes = [
      { delta: [{ id: 1, count: -3 }, { id: 3, count: -2 }, { id: 10, count: 1 }] },
      { delta: [{ id: 2, count: -3 }, { id: 3, count: -2 }, { id: 10, count: 1 }] }
    ];
    return {
      entity: { position: { offset: () => ({ floored: () => ({}) }) } },
      inventory: {
        items: () => items
      },
      registry: {
        items: recipeItems,
        itemsByName: { wooden_pickaxe: { id: 10, name: "wooden_pickaxe" } },
        blocksByName: { crafting_table: { id: 20, name: "crafting_table" } }
      },
      findBlocks: () => [],
      recipesFor: () => [],
      recipesAll: (_itemId: number, _metadata: null, table: any) => (table ? recipes : [])
    };
  }

  function stoneToolBotWithInventory(items: Array<{ name: string; count: number }>): any {
    const recipeItems = {
      1: { name: "cobbled_deepslate" },
      2: { name: "cobblestone" },
      10: { name: "stone_pickaxe" }
    };
    const recipes = [
      { delta: [{ id: 1, count: -3 }, { id: 10, count: 1 }] },
      { delta: [{ id: 2, count: -3 }, { id: 10, count: 1 }] }
    ];
    return {
      entity: { position: { offset: () => ({ floored: () => ({}) }) } },
      inventory: {
        items: () => items
      },
      registry: {
        items: recipeItems,
        itemsByName: { stone_pickaxe: { id: 10, name: "stone_pickaxe" } },
        blocksByName: { crafting_table: { id: 20, name: "crafting_table" } }
      },
      findBlocks: () => [],
      recipesFor: () => [],
      recipesAll: (_itemId: number, _metadata: null, table: any) => (table ? recipes : [])
    };
  }

  it("reports the missing variant matching held logs instead of the first arbitrary recipe", async () => {
    const context: any = {
      bot: botWithInventory([{ name: "oak_log", count: 4 }])
    };

    const result = await craftTool({ item: "wooden_pickaxe", count: 1 }, context);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("missing 3 oak_planks");
    expect(result.detail).toContain("missing 2 stick");
    expect(result.detail).not.toContain("cherry_planks");
  });

  it("reports a missing crafting table when materials are present but no table is nearby", async () => {
    const context: any = {
      bot: botWithInventory([
        { name: "oak_planks", count: 3 },
        { name: "stick", count: 2 }
      ])
    };

    const result = await craftTool({ item: "wooden_pickaxe", count: 1 }, context);

    expect(result).toEqual({
      status: "failed",
      detail: "craft failed: no crafting_table nearby (craft or place one)"
    });
  });

  it("prefers canonical stone materials over arbitrary stone-family recipe order", async () => {
    const context: any = {
      bot: stoneToolBotWithInventory([])
    };

    const result = await craftTool({ item: "stone_pickaxe", count: 1 }, context);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("missing 3 cobblestone");
    expect(result.detail).not.toContain("cobbled_deepslate");
  });
});
