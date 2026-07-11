import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { buildShelterTool } from "../src/tools/build_shelter";

describe("buildShelterTool dirt_box preflight", () => {
  it("fails fast with the exact shortfall before placing anything", async () => {
    const bot: any = {
      entity: { position: new Vec3(0.5, 64.2, 0.5) },
      blockAt: () => ({ name: "air", boundingBox: "empty" }),
      inventory: { items: () => [{ name: "dirt", count: 5, type: 1 }] },
      equip: vi.fn()
    };
    const context: any = { bot, config: {}, signal: new AbortController().signal };

    const result = await buildShelterTool({ style: "dirt_box" }, context);

    // 9 roof blocks + 8 wall columns x 2 high = 25 placements on open ground.
    expect(result.status).toBe("failed");
    expect(result.detail).toContain("needs 25 blocks");
    expect(result.detail).toContain("have 5");
    expect(result.detail).toContain("dig_in");
    expect(bot.equip).not.toHaveBeenCalled();
  });

  it("does not demand material for spots the terrain already fills", async () => {
    const bot: any = {
      entity: { position: new Vec3(0.5, 64.2, 0.5) },
      // Everything below roof level is already solid ground: only the 9 roof
      // blocks are unfilled, and placing on solid neighbors succeeds.
      blockAt: (pos: Vec3) => (pos.y >= 66 ? { name: "air", boundingBox: "empty" } : { name: "stone", boundingBox: "block" }),
      inventory: { items: () => [{ name: "dirt", count: 9, type: 1 }] },
      equip: vi.fn(),
      placeBlock: vi.fn(async () => {})
    };
    const context: any = { bot, config: {}, signal: new AbortController().signal };

    const result = await buildShelterTool({ style: "dirt_box" }, context);

    expect(result.status).toBe("success");
    expect(bot.placeBlock).toHaveBeenCalledTimes(9);
  });
});
