import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { mineBlockTool } from "../src/tools/mine_block";

// The crop-harvest path walks to each crop; pathfinding needs a real world, so
// stub just gotoNear and keep every other helper real.
vi.mock("../src/tools/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/helpers")>();
  return { ...actual, gotoNear: vi.fn(async () => {}) };
});

/**
 * One crop block on (optionally) farmland. Just enough world for the direct
 * dig-and-replant path; collectblock is never involved for crops.
 */
function makeFarmBot(options: { cropName: string; age: number; farmland?: boolean; inventory?: Record<string, number> }): any {
  const cropPos = new Vec3(0, 64, 0);
  const inventory: Record<string, number> = { ...(options.inventory ?? {}) };
  let cropBroken = false;
  return {
    registry: { blocksByName: { [options.cropName]: { id: 1, name: options.cropName } }, itemsByName: {} },
    inventory: {
      items: () =>
        Object.entries(inventory)
          .filter(([, count]) => count > 0)
          .map(([name, count]) => ({ name, count, type: 1 }))
    },
    findBlocks: () => [cropPos],
    blockAt: (pos: Vec3) => {
      if (pos.y === 63) return { name: options.farmland === false ? "dirt" : "farmland", position: pos };
      if (cropBroken) return { name: "air", position: pos };
      return { name: options.cropName, position: pos, getProperties: () => ({ age: options.age }) };
    },
    dig: vi.fn(async () => {
      cropBroken = true;
    }),
    activateBlock: vi.fn(async () => {}),
    placeBlock: vi.fn(async () => {}),
    equip: vi.fn(async () => {})
  };
}

const config: any = { scan_radius_blocks: 32, block_whitelist: ["wheat", "sweet_berry_bush"] };

describe("mineBlockTool crop harvesting", () => {
  it("digs mature wheat directly and replants the farmland with seeds", async () => {
    const bot = makeFarmBot({ cropName: "wheat", age: 7, inventory: { wheat_seeds: 2 } });
    const context: any = { bot, config, signal: new AbortController().signal };

    const result = await mineBlockTool({ type: "wheat", count: 1 }, context);

    expect(result.status).toBe("success");
    expect(bot.dig).toHaveBeenCalledTimes(1);
    expect(bot.placeBlock).toHaveBeenCalledTimes(1);
    const [placedOn, face] = bot.placeBlock.mock.calls[0];
    expect(placedOn.name).toBe("farmland");
    expect(face).toEqual(new Vec3(0, 1, 0));
  });

  it("still harvests when no seeds are available, skipping the replant", async () => {
    const bot = makeFarmBot({ cropName: "wheat", age: 7 });
    const context: any = { bot, config, signal: new AbortController().signal };

    const result = await mineBlockTool({ type: "wheat", count: 1 }, context);

    expect(result.status).toBe("success");
    expect(bot.dig).toHaveBeenCalledTimes(1);
    expect(bot.placeBlock).not.toHaveBeenCalled();
  });

  it("harvests sweet berry bushes by right-click without destroying them", async () => {
    const bot = makeFarmBot({ cropName: "sweet_berry_bush", age: 3 });
    const context: any = { bot, config, signal: new AbortController().signal };

    const result = await mineBlockTool({ type: "sweet_berry_bush", count: 1 }, context);

    expect(result.status).toBe("success");
    expect(bot.activateBlock).toHaveBeenCalledTimes(1);
    expect(bot.dig).not.toHaveBeenCalled();
    expect(bot.placeBlock).not.toHaveBeenCalled();
  });
});
