import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { obtainItemTool } from "../src/tools/obtain_item";
import { loadOdysseyData } from "../src/tools/odyssey_data";

vi.mock("../src/tools/odyssey_data", () => ({
  loadOdysseyData: vi.fn()
}));

// The crop-harvest path walks to each crop and mining configures real pathfinder
// Movements; both need a real world, so stub those two and keep every other
// helper real.
vi.mock("../src/tools/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/helpers")>();
  return { ...actual, gotoNear: vi.fn(async () => {}), configureMovements: vi.fn(() => ({})) };
});

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
  table?: boolean; // recipe only available when a crafting table is provided
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
  blockAges?: Record<string, number>; // blockName -> crop age reported by getProperties()
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
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: Object.fromEntries((options.nearbyEntities ?? []).map((entity) => [entity.id, { ...entity, position: new Vec3(1, 64, 1) }])),
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
    recipesFor: (itemId: number, _meta: null, count: number, table: any) => {
      const name = Object.values(itemsByName).find((item) => item.id === itemId)?.name;
      const def = name ? recipes[name] : undefined;
      if (!name || !def) return [];
      if (def.table && !table) return [];
      const satisfied = Object.entries(def.needs).every(([need, needCount]) => (inventory[need] ?? 0) >= needCount * count);
      return satisfied ? [{ __def: def, __name: name, delta: recipeDelta(name, def) }] : [];
    },
    recipesAll: (itemId: number, _meta: null, table: any) => {
      const name = Object.values(itemsByName).find((item) => item.id === itemId)?.name;
      const def = name ? recipes[name] : undefined;
      if (!name || !def) return [];
      if (def.table && !table) return [];
      return [{ __def: def, __name: name, delta: recipeDelta(name, def) }];
    },
    findBlocks: ({ matching, count }: { matching: any; count: number }) => {
      if (typeof matching === "function") return []; // no crafting_table/furnace ever nearby in these tests
      const resolvedName = Object.keys(blocksByName).find((name) => blocksByName[name].id === matching);
      const available = resolvedName ? (options.findBlocksByType?.[resolvedName] ?? 0) : 0;
      return Array.from({ length: Math.min(available, count) }, (_, index) => Object.assign(new Vec3(index, 0, 0), { __blockName: resolvedName }));
    },
    blockAt: (pos: any) => ({
      position: pos,
      name: pos.__blockName ?? "block",
      __blockName: pos.__blockName,
      boundingBox: "block",
      getProperties: () => (options.blockAges?.[pos.__blockName] === undefined ? {} : { age: options.blockAges[pos.__blockName] })
    }),
    collectBlock: {
      collect: vi.fn(async (block: any) => {
        await options.collect?.(block.__blockName);
      })
    },
    dig: vi.fn(async (block: any) => {
      await options.collect?.(block.__blockName ?? block.name);
    }),
    activateBlock: vi.fn(async () => {}),
    placeBlock: vi.fn(async () => {}),
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

  it("resolves a crafting table before crafting a table-only recipe", async () => {
    const bot = makeBot({
      items: [
        { id: 1, name: "wooden_pickaxe" },
        { id: 2, name: "oak_planks" },
        { id: 3, name: "stick" },
        { id: 4, name: "crafting_table" }
      ],
      blocks: { crafting_table: {} },
      initialInventory: { oak_planks: 10, stick: 4 },
      recipes: {
        wooden_pickaxe: { needs: { oak_planks: 3, stick: 2 }, table: true },
        crafting_table: { needs: { oak_planks: 4 } }
      }
    });
    mockedLoadOdysseyData.mockReturnValue({
      func: { wooden_pickaxe: "craft", crafting_table: "craft" },
      preCollect: {},
      mapName: {},
      preSmelt: {}
    });
    const context: any = { bot, config: { entity_radius_blocks: 24, scan_radius_blocks: 32, block_whitelist: [] }, signal: new AbortController().signal };

    const result = await obtainItemTool({ item: "wooden_pickaxe", count: 1 }, context);

    expect(result.status).toBe("success");
    expect(result.detail).toContain("obtained 1 wooden_pickaxe");
    // The table was crafted as a prerequisite (consuming 4 planks), then the
    // pickaxe recipe consumed 3 planks and 2 sticks on the placed table.
    expect(bot.__inventory.wooden_pickaxe).toBe(1);
    expect(bot.__inventory.oak_planks).toBe(3);
  });

  it("falls back from a cyclic craft route to mining the crop block (wheat <-> hay_block)", async () => {
    const bot = makeBot({
      items: [
        { id: 1, name: "wheat" },
        { id: 2, name: "hay_block" }
      ],
      blocks: { wheat: {} },
      recipes: {
        wheat: { needs: { hay_block: 1 }, produces: 9 },
        hay_block: { needs: { wheat: 9 } }
      },
      findBlocksByType: { wheat: 3 },
      blockAges: { wheat: 7 },
      collect: (blockName) => {
        if (blockName === "wheat") bot.__inventory.wheat = (bot.__inventory.wheat ?? 0) + 1;
      }
    });
    // No "wheat" func entry: the route falls through to the hay_block recipe, which
    // needs wheat again — the resolver must survive the cycle by mining the crop.
    mockedLoadOdysseyData.mockReturnValue({ func: { hay_block: "craft" }, preCollect: {}, mapName: {}, preSmelt: {} });
    const context: any = { bot, config: { entity_radius_blocks: 24, scan_radius_blocks: 32, block_whitelist: [] }, signal: new AbortController().signal };

    const result = await obtainItemTool({ item: "wheat", count: 2 }, context);

    expect(result.status).toBe("success");
    expect(result.detail).toContain("obtained 2 wheat");
  });

  it("does not harvest immature crops and reports why", async () => {
    const bot = makeBot({
      items: [{ id: 1, name: "wheat" }],
      blocks: { wheat: {} },
      findBlocksByType: { wheat: 4 },
      blockAges: { wheat: 3 }
    });
    mockedLoadOdysseyData.mockReturnValue({ func: { wheat: "mine" }, preCollect: {}, mapName: { wheat: ["wheat"] }, preSmelt: {} });
    const context: any = { bot, config: { entity_radius_blocks: 24, scan_radius_blocks: 32, block_whitelist: [] }, signal: new AbortController().signal };

    const result = await obtainItemTool({ item: "wheat", count: 1 }, context);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("only immature wheat");
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
        itemsByName: {
          stick: { id: 1, name: "stick" },
          oak_planks: { id: 2, name: "oak_planks" },
          string: { id: 3, name: "string" },
          wheat: { id: 4, name: "wheat" }
        },
        blocksByName: { stone: { id: 100, name: "stone" }, wheat: { id: 101, name: "wheat" } },
        entitiesByName: { spider: { name: "spider" } }
      }
    };

    const data = realLoad(bot);

    // Crop items route straight to mining their crop block (wheat's only recipe is
    // the hay_block cycle, so a missing func entry would dead-end the resolver).
    expect(data.func.wheat).toBe("mine");
    expect(data.mapName.wheat).toEqual(["wheat"]);

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
