import { describe, expect, it, vi } from "vitest";
import { collectBlockInterruptible } from "../src/tools/helpers";

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Minimal bot mock for collectBlockInterruptible: a controllable collectBlock.collect()
 * promise plus the pathfinder/pvp/collectBlock stop surfaces interruptible() calls on abort.
 */
function makeBot(collect: () => Promise<void>, cancelTask?: () => Promise<void>): any {
  const collectBlock: any = { collect: vi.fn(collect) };
  if (cancelTask) collectBlock.cancelTask = vi.fn(cancelTask);
  return {
    collectBlock,
    pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
    pvp: { stop: vi.fn() }
  };
}

describe("collectBlockInterruptible abort draining", () => {
  it("cancels the collectBlock task and awaits the abandoned collect() promise before settling", async () => {
    let resolveCollect: () => void = () => {};
    const collectPromise = new Promise<void>((resolve) => {
      resolveCollect = resolve;
    });
    const bot = makeBot(() => collectPromise, async () => {});
    const controller = new AbortController();
    const context: any = { bot, config: {}, signal: controller.signal };

    const wrapper = collectBlockInterruptible(context, { name: "stone" });
    let settled = false;
    wrapper.catch(() => {}).finally(() => {
      settled = true;
    });

    controller.abort("stop requested");
    await flushMacrotask();

    expect(bot.pathfinder.stop).toHaveBeenCalledTimes(1);
    expect(bot.pathfinder.setGoal).toHaveBeenCalledWith(null);
    expect(bot.collectBlock.cancelTask).toHaveBeenCalledTimes(1);
    // Still draining: the abandoned collect() promise has not been settled yet, so control
    // must not have been handed back to the caller.
    expect(settled).toBe(false);

    resolveCollect();
    await expect(wrapper).rejects.toThrow("stop requested");
    expect(settled).toBe(true);
  });

  it("logs a structured warning and still returns control when the drain grace period expires", async () => {
    const bot = makeBot(() => new Promise<void>(() => {})); // never settles, no cancelTask either
    const controller = new AbortController();
    const context: any = { bot, config: {}, signal: controller.signal };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const wrapper = collectBlockInterruptible(context, { name: "stone" });
    controller.abort("stop requested");

    await expect(wrapper).rejects.toThrow("stop requested");

    const warning = logSpy.mock.calls.map((call) => String(call[0])).find((line) => line.includes("tool abort drain timed out"));
    expect(warning).toBeDefined();
    expect(warning).toContain("reason=stop requested");
    expect(warning).toMatch(/heap_mb=\d+/);

    logSpy.mockRestore();
  }, 10000);

  it("drains the abandoned promise the same way when the abort reason is a dispatch timeout", async () => {
    // index.ts's dispatch timeout aborts the same controller.signal with a "timeout after Ns"
    // reason via stopCurrent(); interruptible() treats it identically to a brain-sent stop,
    // so this exercises the exact cancel+drain path a real dispatch timeout takes.
    let resolveCollect: () => void = () => {};
    const collectPromise = new Promise<void>((resolve) => {
      resolveCollect = resolve;
    });
    const bot = makeBot(() => collectPromise, async () => {});
    const controller = new AbortController();
    const context: any = { bot, config: {}, signal: controller.signal };

    const wrapper = collectBlockInterruptible(context, { name: "stone" });
    let settled = false;
    wrapper.catch(() => {}).finally(() => {
      settled = true;
    });

    controller.abort("timeout after 120s");
    await flushMacrotask();

    expect(bot.collectBlock.cancelTask).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    resolveCollect();
    await expect(wrapper).rejects.toThrow("timeout after 120s");
    expect(settled).toBe(true);
  });
});
