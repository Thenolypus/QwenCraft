import { describe, expect, it, vi } from "vitest";
import { equipTool } from "../src/tools/equip";

function contextWithItems(items: Array<{ name: string; count: number }>): any {
  return {
    bot: {
      inventory: {
        items: () => items
      },
      equip: vi.fn()
    },
    signal: new AbortController().signal
  };
}

describe("equipTool", () => {
  it("equips armor to the matching armor destination", async () => {
    const context = contextWithItems([{ name: "iron_helmet", count: 1 }]);

    const result = await equipTool({ item: "iron_helmet" }, context);

    expect(result.status).toBe("success");
    expect(context.bot.equip).toHaveBeenCalledWith({ name: "iron_helmet", count: 1 }, "head");
  });

  it("fails clearly when the item is missing", async () => {
    const context = contextWithItems([]);

    const result = await equipTool({ item: "iron_sword" }, context);

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("iron_sword not in inventory");
    expect(context.bot.equip).not.toHaveBeenCalled();
  });
});
