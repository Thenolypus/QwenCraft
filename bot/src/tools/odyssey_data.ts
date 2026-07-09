import fs from "node:fs";
import { repoPath } from "../config";
import { logInfo } from "../logger";
import { blockDefinition, itemDefinition } from "./helpers";

export interface OdysseyData {
  func: Record<string, string>;
  preCollect: Record<string, string[]>;
  mapName: Record<string, string[]>;
  preSmelt: Record<string, string>;
}

function readVendoredJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(repoPath("bot", "data", "odyssey", name), "utf8")) as T;
}

const rawFunc = readVendoredJson<Record<string, string>>("func.json");
const rawPreCollect = readVendoredJson<Record<string, string[]>>("pre_collect.json");
const rawMapName = readVendoredJson<Record<string, string[]>>("map_name.json");
const rawPreSmelt = readVendoredJson<Record<string, string>>("pre_smelt.json");

function entityDefinition(bot: any, name: string): any | null {
  return bot.registry?.entitiesByName?.[name] ?? null;
}

function knownName(bot: any, name: string): boolean {
  return Boolean(itemDefinition(bot, name) || blockDefinition(bot, name));
}

function filterOdysseyData(bot: any): { data: OdysseyData; dropped: number } {
  let dropped = 0;

  const func: Record<string, string> = {};
  for (const [name, method] of Object.entries(rawFunc)) {
    if (knownName(bot, name)) func[name] = method;
    else dropped += 1;
  }

  const preCollect: Record<string, string[]> = {};
  for (const [name, mobs] of Object.entries(rawPreCollect)) {
    const knownMobs = mobs.filter((mob) => Boolean(entityDefinition(bot, mob)));
    if (knownName(bot, name) && knownMobs.length) preCollect[name] = knownMobs;
    else dropped += 1;
  }

  const mapName: Record<string, string[]> = {};
  for (const [name, blocks] of Object.entries(rawMapName)) {
    const knownBlocks = blocks.filter((block) => Boolean(blockDefinition(bot, block)));
    if (knownBlocks.length) mapName[name] = knownBlocks;
    else dropped += 1;
  }

  const preSmelt: Record<string, string> = {};
  for (const [output, input] of Object.entries(rawPreSmelt)) {
    if (knownName(bot, output) && knownName(bot, input)) preSmelt[output] = input;
    else dropped += 1;
  }

  return { data: { func, preCollect, mapName, preSmelt }, dropped };
}

const cache = new WeakMap<object, OdysseyData>();

/**
 * Loads the vendored Odyssey routing tables (func/pre_collect/map_name/pre_smelt),
 * filtered against the bot's live registry so stale/renamed 1.19 names never reach
 * the resolver. Filtering runs once per bot registry instance; the dropped-entry
 * count is logged once at that point.
 */
export function loadOdysseyData(bot: any): OdysseyData {
  const registry = bot.registry;
  const cached = cache.get(registry);
  if (cached) return cached;
  const { data, dropped } = filterOdysseyData(bot);
  if (dropped > 0) {
    logInfo("odyssey data filtered", { dropped_entries: dropped, mc_version: bot.version ?? "unknown" });
  }
  cache.set(registry, data);
  return data;
}
