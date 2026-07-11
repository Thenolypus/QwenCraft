import { beforeEach, describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { fleeFromNearestHostile } from "../src/tools/flee";
import { gotoNear } from "../src/tools/helpers";

// gotoNear needs a real pathfinder/world; stub it to teleport the bot to the
// requested target so hop geometry can be asserted, keep other helpers real.
vi.mock("../src/tools/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/helpers")>();
  return { ...actual, gotoNear: vi.fn() };
});

const mockedGotoNear = vi.mocked(gotoNear);

function makeBot(hostilePos: Vec3 | null): any {
  const entities: Record<number, any> = {};
  if (hostilePos) entities[1] = { id: 1, name: "zombie", position: hostilePos };
  return { entity: { position: new Vec3(0, 64, 0) }, entities };
}

function makeContext(bot: any): any {
  return { bot, config: { entity_radius_blocks: 24 }, signal: new AbortController().signal };
}

function teleportBotOnGoto(bot: any): void {
  mockedGotoNear.mockImplementation(async (_context: any, x: number, y: number, z: number) => {
    bot.entity.position = new Vec3(x, y, z);
  });
}

describe("fleeFromNearestHostile", () => {
  beforeEach(() => {
    mockedGotoNear.mockReset();
  });

  it("fails when no hostile is nearby", async () => {
    const result = await fleeFromNearestHostile(10, makeContext(makeBot(null)));

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("no hostile entity nearby");
  });

  it("keeps hopping until the hostile is outside the safe distance", async () => {
    const bot = makeBot(new Vec3(3, 64, 0));
    teleportBotOnGoto(bot);

    const result = await fleeFromNearestHostile(8, makeContext(bot));

    // hop 1 lands ~11 blocks from the zombie (still unsafe), hop 2 ends ~19 away.
    expect(mockedGotoNear).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("success");
    expect(result.detail).toContain("fled 16 blocks from zombie");
    expect(result.detail).toContain("no hostile within safe range");
  });

  it("stops at the hop budget when the hostile keeps pace and reports the remaining threat", async () => {
    const bot = makeBot(new Vec3(3, 64, 0));
    mockedGotoNear.mockImplementation(async (_context: any, x: number, y: number, z: number) => {
      bot.entity.position = new Vec3(x, y, z);
      bot.entities[1].position = new Vec3(x + 2, y, z); // hostile stays on top of the bot
    });

    const result = await fleeFromNearestHostile(8, makeContext(bot));

    expect(mockedGotoNear).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("success");
    expect(result.detail).toContain("still 2 blocks away");
  });

  it("respects a caller-supplied single-hop budget", async () => {
    const bot = makeBot(new Vec3(3, 64, 0));
    mockedGotoNear.mockImplementation(async (_context: any, x: number, y: number, z: number) => {
      bot.entity.position = new Vec3(x, y, z);
      bot.entities[1].position = new Vec3(x + 2, y, z);
    });

    const result = await fleeFromNearestHostile(8, makeContext(bot), 1);

    expect(mockedGotoNear).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("success");
  });
});
