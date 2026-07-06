import { describe, expect, it } from "vitest";
import { Vec3 } from "vec3";
import { buildObservation } from "../src/observation";
import { BotConfig } from "../src/types";

const config: BotConfig = {
  mc_host: "127.0.0.1",
  mc_port: 25565,
  mc_version: "26.2",
  bot_username: "QwenCraft",
  ws_port: 8765,
  llm_base_url: "http://127.0.0.1:8000/v1",
  llm_api_key: "EMPTY",
  llm_model: "Qwen/Qwen3.5-9B-Instruct",
  enable_thinking: false,
  temperature: 0.2,
  heartbeat_seconds: 10,
  scan_radius_blocks: 32,
  entity_radius_blocks: 24,
  block_whitelist: ["*_log", "stone", "coal_ore", "crafting_table", "furnace", "chest", "*_bed", "water", "lava"],
  viewer_enabled: false,
  episode_time_limit_minutes: 30
};

describe("buildObservation", () => {
  it("sorts nearby entities and groups whitelisted blocks", () => {
    const blockMap = new Map<string, { name: string; light?: number; boundingBox?: string }>([
      ["0,63,0", { name: "grass_block", light: 15 }],
      ["2,64,0", { name: "oak_log" }],
      ["3,64,0", { name: "oak_log" }],
      ["8,63,0", { name: "stone" }]
    ]);
    const bot: any = {
      entity: { position: new Vec3(0, 64, 0) },
      entities: {
        self: null,
        zombie: { name: "zombie", position: new Vec3(3, 64, -3) },
        cow: { name: "cow", position: new Vec3(8, 64, 0) }
      },
      health: 18,
      food: 14,
      oxygenLevel: 20,
      time: { timeOfDay: 6000 },
      rainState: 0,
      thunderState: 0,
      heldItem: { name: "stone_pickaxe" },
      inventory: {
        items: () => [{ name: "oak_log", count: 2 }],
        emptySlotCount: () => 30,
        slots: []
      },
      blockAt: (pos: Vec3) => blockMap.get(`${pos.x},${pos.y},${pos.z}`) ?? { name: "air", light: 15 },
      findBlocks: () => [new Vec3(2, 64, 0), new Vec3(3, 64, 0), new Vec3(8, 63, 0)],
      registry: { biomesById: {} }
    };
    bot.entities.self = bot.entity;

    const observation = buildObservation(bot, config, null, ["spawned"]);

    expect(observation.entities[0]).toMatchObject({ type: "zombie", hostile: true });
    expect(observation.status.danger_flags).toContain("hostile_nearby");
    expect(observation.blocks_of_interest[0]).toMatchObject({ type: "oak_log", count_in_range: 2 });
    expect(observation.inventory.items.oak_log).toBe(2);
  });

  it("clamps transient status values to the observation schema range", () => {
    const bot: any = {
      entity: { position: new Vec3(0, 64, 0) },
      entities: { self: null },
      health: 22,
      food: 21,
      oxygenLevel: 300,
      time: { timeOfDay: 6000 },
      rainState: 0,
      thunderState: 0,
      heldItem: null,
      inventory: {
        items: () => [],
        emptySlotCount: () => 36,
        slots: []
      },
      blockAt: () => ({ name: "air", light: 99 }),
      findBlocks: () => []
    };
    bot.entities.self = bot.entity;

    const observation = buildObservation(bot, config, null);

    expect(observation.status.health).toBe(20);
    expect(observation.status.hunger).toBe(20);
    expect(observation.status.oxygen).toBe(20);
    expect(observation.status.light).toBe(15);
  });
});
