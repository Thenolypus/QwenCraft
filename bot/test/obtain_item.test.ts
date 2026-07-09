import { describe, expect, it, vi } from "vitest";
import { obtainItemTool } from "../src/tools/obtain_item";
import { loadOdysseyData } from "../src/tools/odyssey_data";

vi.mock("../src/tools/odyssey_data", () => ({
  loadOdysseyData: vi.fn()
}));

const mockedLoadOdysseyData = vi.mocked(loadOdysseyData);

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface FakeItemDef {
  id: number;
  name: string;
}

interface RecipeDef {
  needs: Record<string, number>;
  produces?: number;
}

/**
 * Builds a mock bot minimal enough to drive the REAL craftTool/mineBlockTool/smeltTool/
 * attackTool (obtain_item reuses them as-is, unmocked) while obtain_item recursively
 * resolves prerequisites against this fake world.
 */
function makeBot(options: {
  items: FakeItemDef[];
  blocks?: Record<string, { harvestTools?: Record<string, boolean> }>;
  entities?: Record<string, string[]>; // itemName -> mob names, just to seed entitiesByName
  initialInventory?: Record<string, number>;
  recipes?: Record<string, RecipeDef>;
  findBlocksByType?: Record<string, number>; // blockName -> how many positions findBlocks reports
  collect?: (blockName: string) => Promise<void> | void;
  nearbyEntities?: Array<{ id: number; name: string }>;
}): any {
  const inventory: Record<string, number> = { ...(options.initialInventory ?? {}) };
  const itemsByName: Record<string, FakeItemDef> = {};
  const itemsById: Record<number, FakeItemDef> = {};
  for (const item of options.items) {
    itemsByName[item.name] = item;
    itemsById[item.id] = item;
  }

  const blocksByName: Record<string, any> = {};
  for (const [name, def] of Object.entries(options.blocks ?? {})) {
    blocksByName[name] = { name, id: 1000 + Object.keys(blocksByName).length, ...def };
  }

  const entitiesByName: Record<string, any> = {};
  for (const mobs of Object.values(options.entities ?? {})) {
    for (const mob of mobs) entitiesByName[mob] = { name: mob };
  }

  const recipes = options.recipes ?? {};

  function recipeDelta(name: string, def: RecipeDef) {
    const delta: Array<{ id: number; count: number }> = [{ id: itemsByName[name].id, count: def.produces ?? 1 }];
    for (const [need, count] of Object.entries(def.needs)) delta.push({ id: itemsByName[need].id, count: -count });
    return delta;
  }

  function itemsArray(): Array<{ name: string; count: number; type: number }> {
    return Object.entries(inventory)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count, type: itemsByName[name]?.id ?? -1 }));
  }

  const bot: any = {
    version: "1.21.11",
    entity: { position: { offset: () => ({ floored: () => ({}) }), distanceTo: () => 5 } },
    entities: Object.fromEntries((options.nearbyEntities ?? []).map((entity) => [entity.id, { ...entity, position: {} }])),
    health: 20,
    registry: { items: itemsById, itemsByName, blocksByName, entitiesByName },
    inventory: { items: itemsArray },
    equip: vi.fn(async () => {}),
    craft: vi.fn(async (recipe: any, count: number) => {
      const def: RecipeDef | undefined = recipe.__def;
      const name: string | undefined = recipe.__name;
      if (!def || !name) return;
      for (const [need, needCount] of Object.entries(def.needs)) inventory[need] = (inventory[need] ?? 0) - needCount * count;
      inventory[name] = (inventory[name] ?? 0) + count * (def.produces ?? 1);
    }),
    recipesFor: (itemId: number, _meta: null, count: number) => {
      const name = Object.values(itemsByName).find((item) => item.id === itemId)?.name;
      const def = name ? recipes[name] : undefined;
      if (!name || !def) return [];
      const satisfied = Object.entries(def.needs).every(([need, needCount]) => (inventory[need] ?? 0) >= needCount * count);
      return satisfied ? [{ __def: def, __name: name, delta: recipeDelta(name, def) }] : [];
    },
    recipesAll: (itemId: number) => {
      const name = Object.values(itemsByName).find((item) => item.id === itemId)?.name;
      const def = name ? recipes[name] : undefined;
      if (!name || !def) return [];
      return [{ __def: def, __name: name, delta: recipeDelta(name, def) }];
    },
    findBlocks: ({ matching, count }: { matching: any; count: number }) => {
      if (typeof matching === "function") return []; // no crafting_table/furnace ever nearby in these tests
      const resolvedName = Object.keys(blocksByName).find((name) => blocksByName[name].id === matching);
      const available = resolvedName ? (options.findBlocksByType?.[resolvedName] ?? 0) : 0;
      return Array.from({ length: Math.min(available, count) }, (_, index) => ({ x: index, y: 0, z: 0, __blockName: resolvedName }));
    },
    blockAt: (pos: any) => ({ position: pos, name: pos.__blockName ?? "block", __blockName: pos.__blockName }),
    collectBlock: {
      collect: vi.fn(async (block: any) => {
        await options.collect?.(block.__blockName);
      })
    },
    pvp: { attack: vi.fn(), stop: vi.fn() },
    pathfinder: { stop: vi.fn(), setGoal: vi.fn() }
  };

  bot.__inventory = inventory;
  return bot;
}

describe("obtainItemTool", () => {
  it("returns success immediately when inventory already satisfies the request", async () => {
    const bot = makeBot({ items: [{ id: 1, name: "oak_log" }], initialInventory: { oak_log: 5 } });
    mockedLoadOdysseyData.mockReturnValue({ func: {}, preCollect: {}, mapName: {}, preSmelt: {} });
    const context: any = { bot, config: { entity_radius_blocks: 24 }, signal: new AbortController().signal };

    const result = await obtainItemTool({ item: "oak_log", count: 3 }, context);

    expect(result.status).toBe("success");
    expect(result.detail).toContain("already have 5 oak_log");
  });

  it("fails informatively for the kill route when no matching entity is nearby", async () => {
    const bot = makeBot({
      items: [{ id: 1, name: "string" }],
      entities: { string: ["spider", "cave_spider"] },
      nearbyEntities: []
    });
    mockedLoadOdysseyData.mockReturnValue({
      func: { string: "kill" },
      preCollect: { string: ["spider", "cave_spider"] },
      mapName: {},
      preSmelt: {}
    });
    const context: any = { bot, config: { entity_radius_blocks: 24 }, signal: new AbortController().signal };

    const result = await obtainItemTool({ item: "string", count: 2 }, context);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("obtained 0/2 string");
    expect(result.detail).toContain("none nearby");
  });

  it("triggers the per-item attempt cap when a kill route needs more kills than the cap allows", async () => {
    const bot = makeBot({
      items: [{ id: 1, name: "string" }],
      entities: { string: ["spider"] },
      nearbyEntities: [
        { id: 1, name: "spider" },
        { id: 2, name: "spider" },
        { id: 3, name: "spider" },
        { id: 4, name: "spider" },
        { id: 5, name: "spider" }
      ]
    });
    // Each successful attack removes the targeted entity (simulating a kill) and drops one string.
    bot.pvp.attack = vi.fn((entity: any) => {
      delete bot.entities[entity.id];
      bot.__inventory.string = (bot.__inventory.string ?? 0) + 1;
    });
    mockedLoadOdysseyData.mockReturnValue({
      func: { string: "kill" },
      preCollect: { string: ["spider"] },
      mapName: {},
      preSmelt: {}
    });
    const context: any = { bot, config: { entity_radius_blocks: 24 }, signal: new AbortController().signal };

    const result = await obtainItemTool({ item: "string", count: 5 }, context);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("obtained 3/5 string");
    expect(result.detail).toContain("attempt cap (3) reached for string");
  });

  it("triggers the recursion depth cap on a deep synthetic craft chain", async () => {
    const chainLength = 9; // deeper than MAX_DEPTH (6)
    const items: FakeItemDef[] = Array.from({ length: chainLength }, (_, index) => ({ id: index + 1, name: `chain${index}` }));
    const recipes: Record<string, RecipeDef> = {};
    const func: Record<string, string> = {};
    for (let index = 0; index < chainLength - 1; index += 1) {
      recipes[`chain${index}`] = { needs: { [`chain${index + 1}`]: 1 } };
      func[`chain${index}`] = "craft";
    }

    const bot = makeBot({ items, recipes });
    mockedLoadOdysseyData.mockReturnValue({ func, preCollect: {}, mapName: {}, preSmelt: {} });
    const context: any = { bot, config: { entity_radius_blocks: 24 }, signal: new AbortController().signal };

    const result = await obtainItemTool({ item: "chain0", count: 1 }, context);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("obtained 0/1 chain0");
    expect(result.detail).toContain("recursion depth cap (6) reached");
  });

  it("returns interrupted with partial progress when the abort signal fires mid-chain", async () => {
    let collectCalls = 0;
    const controller = new AbortController();

    const bot = makeBot({
      items: [{ id: 1, name: "cobblestone" }],
      blocks: { stone: {} },
      findBlocksByType: { stone: 5 },
      collect: async () => {
        collectCalls += 1;
        if (collectCalls === 1) {
          bot.__inventory.cobblestone = (bot.__inventory.cobblestone ?? 0) + 1;
          return;
        }
        // Second block's collection hangs indefinitely: the abort below settles the
        // resolver's wrapper promise first, so this drop is never actually counted.
        await new Promise<void>(() => {});
      }
    });
    mockedLoadOdysseyData.mockReturnValue({
      func: { cobblestone: "mine" },
      preCollect: {},
      mapName: { cobblestone: ["stone"] },
      preSmelt: {}
    });
    const context: any = { bot, config: { entity_radius_blocks: 24, scan_radius_blocks: 32, block_whitelist: [] }, signal: controller.signal };

    const resultPromise = obtainItemTool({ item: "cobblestone", count: 3 }, context);
    await flushMacrotask();
    controller.abort("stop requested");
    const result = await resultPromise;

    expect(result.status).toBe("interrupted");
    expect(result.detail).toContain("obtained 1/3 cobblestone");
    expect(result.detail).toContain("stop requested");
  });
});

describe("loadOdysseyData filtering (real module, not mocked)", () => {
  it("drops vendored entries whose item/block/entity names are not in the registry", async () => {
    const { loadOdysseyData: realLoad } = await vi.importActual<typeof import("../src/tools/odyssey_data")>("../src/tools/odyssey_data");

    const bot: any = {
      registry: {
        itemsByName: { stick: { id: 1, name: "stick" }, oak_planks: { id: 2, name: "oak_planks" }, string: { id: 3, name: "string" } },
        blocksByName: { stone: { id: 100, name: "stone" } },
        entitiesByName: { spider: { name: "spider" } }
      }
    };

    const data = realLoad(bot);

    // "stick" is a real func.json entry and is known to this minimal registry, so it survives.
    expect(data.func.stick).toBeDefined();
    // Items far outside this minimal registry (e.g. nether/end-only items) must be dropped.
    expect(data.func.netherite_pickaxe).toBeUndefined();
    expect(data.func.elytra).toBeUndefined();

    // pre_collect: "string" maps to spider/cave_spider upstream; cave_spider is unknown here,
    // so only the known mob should remain.
    expect(data.preCollect.string).toEqual(["spider"]);
    for (const mobs of Object.values(data.preCollect)) {
      for (const mob of mobs) expect(bot.registry.entitiesByName[mob]).toBeDefined();
    }

    // map_name: every surviving block reference must exist in blocksByName.
    for (const blocks of Object.values(data.mapName)) {
      for (const block of blocks) expect(bot.registry.blocksByName[block]).toBeDefined();
    }
    expect(data.mapName.raw_iron).toBeUndefined(); // iron_ore/deepslate_iron_ore unknown here
  });
});
