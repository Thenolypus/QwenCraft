import { Vec3 } from "vec3";
import { Direction } from "./types";

export const hostileTypes = new Set([
  "blaze",
  "bogged",
  "breeze",
  "cave_spider",
  "creeper",
  "drowned",
  "elder_guardian",
  "enderman",
  "endermite",
  "evoker",
  "ghast",
  "guardian",
  "hoglin",
  "husk",
  "magma_cube",
  "phantom",
  "piglin_brute",
  "pillager",
  "ravager",
  "shulker",
  "silverfish",
  "skeleton",
  "slime",
  "spider",
  "stray",
  "vex",
  "vindicator",
  "warden",
  "witch",
  "wither_skeleton",
  "zoglin",
  "zombie",
  "zombie_villager",
  "zombified_piglin"
]);

export function isHostile(entityName: string | undefined): boolean {
  return !!entityName && hostileTypes.has(entityName);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(String(signal.reason ?? "interrupted")));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error(String(signal.reason ?? "interrupted")));
      },
      { once: true }
    );
  });
}

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error(String(signal.reason ?? "interrupted"));
  }
}

export function directionVector(direction: Direction): Vec3 {
  const map: Record<Direction, Vec3> = {
    N: new Vec3(0, 0, -1),
    NE: new Vec3(1, 0, -1),
    E: new Vec3(1, 0, 0),
    SE: new Vec3(1, 0, 1),
    S: new Vec3(0, 0, 1),
    SW: new Vec3(-1, 0, 1),
    W: new Vec3(-1, 0, 0),
    NW: new Vec3(-1, 0, -1)
  };
  return map[direction];
}

export function compassFromDelta(dx: number, dz: number): Direction {
  const angle = Math.atan2(dx, -dz);
  const sector = Math.round(angle / (Math.PI / 4) + 8) % 8;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][sector] as Direction;
}

export function roundPosition(pos: { x: number; y: number; z: number }): [number, number, number] {
  return [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)];
}

export function inventoryCounts(bot: any): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of bot.inventory?.items?.() ?? []) {
    counts[item.name] = (counts[item.name] ?? 0) + item.count;
  }
  return counts;
}

export function findInventoryItem(bot: any, name: string): any | null {
  return (bot.inventory?.items?.() ?? []).find((item: any) => item.name === name) ?? null;
}

export function findAnyInventoryItem(bot: any, names: string[]): any | null {
  return (bot.inventory?.items?.() ?? []).find((item: any) => names.includes(item.name)) ?? null;
}

export function itemCount(bot: any, name: string): number {
  return inventoryCounts(bot)[name] ?? 0;
}

export function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isAbortError(error: unknown): boolean {
  const message = normalizeError(error).toLowerCase();
  return message.includes("interrupt") || message.includes("abort") || message.includes("cancel");
}

export function matchesWhitelist(name: string, whitelist: string[]): boolean {
  return whitelist.some((pattern) => {
    if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
    if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
    return name === pattern;
  });
}

export function nearestEntity(bot: any, predicate: (entity: any) => boolean, radius: number): any | null {
  const origin = bot.entity?.position;
  if (!origin) return null;
  return (
    Object.values(bot.entities ?? {})
      .filter((entity: any) => entity !== bot.entity && entity.position && predicate(entity))
      .map((entity: any) => ({ entity, dist: origin.distanceTo(entity.position) }))
      .filter(({ dist }: { dist: number }) => dist <= radius)
      .sort((a: { dist: number }, b: { dist: number }) => a.dist - b.dist)[0]?.entity ?? null
  );
}

export function bestWeapon(bot: any): any | null {
  const priority = ["netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "wooden_sword", "axe"];
  const items = bot.inventory?.items?.() ?? [];
  return (
    items.find((item: any) => priority.includes(item.name)) ??
    items.find((item: any) => item.name.endsWith("_axe")) ??
    null
  );
}
