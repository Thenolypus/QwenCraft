import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";
import type {
  BlockObservation,
  CompassDirection,
  Config,
  EntityObservation,
  InventoryObservation,
  LastAction,
  MemoryView,
  Observation,
  ObservationStatus
} from "./types";
import { vecToTuple } from "./types";
import { isHostile, matchesWhitelist } from "./utils";
import { validateObservation } from "./validation";

const defaultMemory: MemoryView = {
  goal: "survive as many nights as possible",
  pinned: {},
  recent_events: []
};

let cachedBlocks:
  | {
      at: number;
      pos: [number, number, number];
      radius: number;
      whitelist: string;
      blocks: BlockObservation[];
    }
  | null = null;

export function directionFromDelta(dx: number, dz: number): CompassDirection {
  const angle = Math.atan2(dx, -dz);
  const octant = Math.round((8 * angle) / (2 * Math.PI) + 8) % 8;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][octant] as CompassDirection;
}

export function isHostileEntity(entity: Entity): boolean {
  return isHostile(entity.name ?? entity.type);
}

function minecraftTime(bot: Bot): ObservationStatus["time"] {
  const timeOfDay = bot.time?.timeOfDay ?? 0;
  if (timeOfDay >= 23000 || timeOfDay < 1000) return "sunrise";
  if (timeOfDay >= 12000 && timeOfDay < 13000) return "sunset";
  if (timeOfDay >= 13000 && timeOfDay < 23000) return "night";
  return "day";
}

function minutesToNight(bot: Bot): number {
  const timeOfDay = bot.time?.timeOfDay ?? 0;
  const ticksUntilNight = timeOfDay < 13000 ? 13000 - timeOfDay : 24000 - timeOfDay + 13000;
  return Number((ticksUntilNight / 20 / 60).toFixed(1));
}

function weather(bot: Bot): ObservationStatus["weather"] {
  const dynamicBot = bot as Bot & { rainState?: number; thunderState?: number };
  if ((dynamicBot.thunderState ?? 0) > 0) return "thunder";
  if ((dynamicBot.rainState ?? 0) > 0) return "rain";
  return "clear";
}

function biomeName(bot: Bot): string {
  const block = bot.blockAt(bot.entity.position.offset(0, -1, 0));
  const biome = block?.biome;
  if (typeof biome === "number") {
    const registry = bot.registry as unknown as { biomes?: Record<number, { name?: string }>; biomesById?: Record<number, { name?: string }> };
    const name = registry.biomes?.[biome]?.name ?? registry.biomesById?.[biome]?.name;
    return name || "unknown";
  }
  if (typeof biome === "object" && biome && "name" in biome) return String(biome.name) || "unknown";
  if (typeof biome === "string" && biome) return biome;
  return "unknown";
}

function lightAtHead(bot: Bot): number {
  const block = bot.blockAt(bot.entity.position.offset(0, 1, 0));
  return Math.max(block?.light ?? 0, block?.skyLight ?? 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildInventory(bot: Bot): InventoryObservation {
  const items: Record<string, number> = {};
  for (const item of bot.inventory.items()) {
    items[item.name] = (items[item.name] ?? 0) + item.count;
  }
  const fallbackArmorSlots = [5, 6, 7, 8];
  const armorSlots = ["head", "torso", "legs", "feet"].map((slot, index) => {
    const slotIndex =
      typeof bot.getEquipmentDestSlot === "function"
        ? bot.getEquipmentDestSlot(slot as "head" | "torso" | "legs" | "feet")
        : fallbackArmorSlots[index];
    const item = bot.inventory.slots[slotIndex];
    return item?.name ?? null;
  });
  const empty = bot.inventory.emptySlotCount();
  return {
    held: bot.heldItem?.name ?? null,
    items,
    free_slots: empty,
    armor: armorSlots
  };
}

function nearestEntities(bot: Bot, radius: number): EntityObservation[] {
  return Object.values(bot.entities)
    .filter((entity) => entity !== bot.entity && entity.position)
    .map((entity) => {
      const dist = bot.entity.position.distanceTo(entity.position);
      return { entity, dist };
    })
    .filter(({ dist }) => dist <= radius)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5)
    .map(({ entity, dist }) => ({
      type: entity.name ?? entity.type,
      dist: Number(dist.toFixed(1)),
      dir: directionFromDelta(entity.position.x - bot.entity.position.x, entity.position.z - bot.entity.position.z),
      hostile: isHostileEntity(entity)
    }));
}

function scanBlocks(bot: Bot, config: Config): BlockObservation[] {
  const now = Date.now();
  const position = vecToTuple(bot.entity.position);
  const whitelistKey = config.block_whitelist.join(",");
  if (
    cachedBlocks &&
    now - cachedBlocks.at < 2500 &&
    cachedBlocks.radius === config.scan_radius_blocks &&
    cachedBlocks.whitelist === whitelistKey &&
    Math.abs(cachedBlocks.pos[0] - position[0]) <= 2 &&
    Math.abs(cachedBlocks.pos[1] - position[1]) <= 2 &&
    Math.abs(cachedBlocks.pos[2] - position[2]) <= 2
  ) {
    return cachedBlocks.blocks;
  }

  const byType = new Map<string, { count: number; nearest: Block; nearestPos: Vec3; dist: number }>();
  const blocks = bot.findBlocks({
    matching: (block: Block) => matchesWhitelist(block.name, config.block_whitelist),
    maxDistance: config.scan_radius_blocks,
    count: 256
  }) as Vec3[];

  for (const pos of blocks) {
    const block = bot.blockAt(pos);
    if (!block) continue;
    const blockPos = (block.position ?? pos) as Vec3;
    const dist = bot.entity.position.distanceTo(blockPos);
    const current = byType.get(block.name);
    if (!current) {
      byType.set(block.name, { count: 1, nearest: block, nearestPos: blockPos, dist });
    } else {
      current.count += 1;
      if (dist < current.dist) {
        current.nearest = block;
        current.nearestPos = blockPos;
        current.dist = dist;
      }
    }
  }

  const observations = [...byType.entries()]
    .map(([type, item]) => ({
      type,
      nearest_dist: Number(item.dist.toFixed(1)),
      pos: vecToTuple(item.nearestPos),
      count_in_range: item.count
    }))
    .sort((a, b) => a.nearest_dist - b.nearest_dist)
    .slice(0, 12);
  cachedBlocks = {
    at: now,
    pos: position,
    radius: config.scan_radius_blocks,
    whitelist: whitelistKey,
    blocks: observations
  };
  return observations;
}

function dangerFlags(status: Pick<ObservationStatus, "health" | "hunger" | "time">, entities: EntityObservation[]): string[] {
  const flags: string[] = [];
  if (status.health < 6) flags.push("health_critical");
  if (status.hunger < 10) flags.push("hunger_low");
  if (status.time === "sunset" || status.time === "night") flags.push("night_risk");
  if (entities.some((entity) => entity.hostile && entity.dist <= 6)) flags.push("hostile_nearby");
  return flags;
}

export function buildObservation(
  bot: Bot,
  config: Config,
  lastAction: LastAction | null,
  recentEvents: string[] = [],
  memory: MemoryView = defaultMemory
): Observation {
  const entities = nearestEntities(bot, config.entity_radius_blocks);
  const statusBase = {
    position: vecToTuple(bot.entity.position),
    health: clamp(bot.health ?? 20, 0, 20),
    hunger: clamp(bot.food ?? 20, 0, 20),
    oxygen: clamp(bot.oxygenLevel ?? 20, 0, 20),
    time: minecraftTime(bot),
    minutes_to_night: minutesToNight(bot),
    weather: weather(bot),
    biome: biomeName(bot),
    light: clamp(lightAtHead(bot), 0, 15)
  };
  const status: ObservationStatus = {
    ...statusBase,
    danger_flags: dangerFlags(statusBase, entities)
  };
  const observation: Observation = {
    status,
    inventory: buildInventory(bot),
    entities,
    blocks_of_interest: scanBlocks(bot, config),
    last_action: lastAction,
    memory: { ...memory, recent_events: memory.recent_events.length ? memory.recent_events : recentEvents.slice(-15) }
  };
  return validateObservation(observation);
}
