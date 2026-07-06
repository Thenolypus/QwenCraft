import { describe, expect, it, vi } from "vitest";
import { attackTool } from "../src/tools/attack";

describe("attackTool", () => {
  it("refuses to start combat below the safety health threshold", async () => {
    const context: any = {
      bot: {
        health: 4.1,
        entities: {},
        inventory: { items: () => [] },
        pvp: { attack: vi.fn(), stop: vi.fn() }
      },
      config: { entity_radius_blocks: 24 },
      signal: new AbortController().signal,
      emitEvent: vi.fn(),
      recentEvents: [],
      stopCurrent: vi.fn()
    };

    const result = await attackTool({ entity_type: "zombie" }, context);

    expect(result.status).toBe("interrupted");
    expect(result.detail).toContain("health 4.1 below 8");
    expect(context.bot.pvp.attack).not.toHaveBeenCalled();
  });
});
