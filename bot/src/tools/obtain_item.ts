import { ToolContext, ToolResult } from "../types";
import { assertNotAborted, findAnyInventoryItem, isAbortError, itemCount, nearestEntity, normalizeError } from "../utils";
import { attackTool } from "./attack";
import { bestMissingRecipeCandidate, craftTool, missingMaterialsForRecipe } from "./craft";
import { blockDefinition, findBlockMatching, itemDefinition, failed, interrupted, success } from "./helpers";
import { mineBlockTool } from "./mine_block";
import { OdysseyData, loadOdysseyData } from "./odyssey_data";
import { fuelPriority, smeltTool } from "./smelt";

export const MAX_DEPTH = 6;
export const MAX_STEPS = 25;
export const MAX_ATTEMPTS_PER_ITEM = 3;

class ObtainBudgetExceeded extends Error {}

interface ResolveState {
  context: ToolContext;
  data: OdysseyData;
  steps: number;
  attempts: Map<string, number>;
  stack: string[];
}

interface ResolveOk {
  ok: true;
}

interface ResolveFail {
  ok: false;
  blockedItem: string;
  reason: string;
}

type ResolveResult = ResolveOk | ResolveFail;

const RESOLVED_OK: ResolveOk = { ok: true };

function resolveFail(item: string, reason: string): ResolveFail {
  return { ok: false, blockedItem: item, reason };
}

// Wraps a failed prerequisite so the report reads "need X (why X failed)" while
// preserving the deepest blockedItem (the actual dead end), not the wrapper's own name.
function needFail(label: string, inner: ResolveFail): ResolveFail {
  return { ok: false, blockedItem: inner.blockedItem, reason: `need ${label} (${inner.reason})` };
}

type PrimitiveAttempt = { ok: true; result: ToolResult } | { ok: false; reason: string };

/**
 * Runs one primitive tool call attributed to `itemName`, enforcing the per-item
 * attempt cap and the abort/step-budget guardrails around every primitive action.
 */
async function attemptPrimitive(state: ResolveState, itemName: string, fn: () => Promise<ToolResult>): Promise<PrimitiveAttempt> {
  const attempts = state.attempts.get(itemName) ?? 0;
  if (attempts >= MAX_ATTEMPTS_PER_ITEM) {
    return { ok: false, reason: `attempt cap (${MAX_ATTEMPTS_PER_ITEM}) reached for ${itemName}` };
  }
  state.attempts.set(itemName, attempts + 1);
  assertNotAborted(state.context.signal);
  if (state.steps >= MAX_STEPS) throw new ObtainBudgetExceeded(`primitive step budget (${MAX_STEPS}) exceeded`);
  state.steps += 1;
  const result = await fn();
  assertNotAborted(state.context.signal);
  return { ok: true, result };
}

const TOOL_TIERS = ["wooden", "golden", "stone", "iron", "diamond", "netherite"];

function toolTierRank(name: string): number {
  const tier = TOOL_TIERS.find((candidate) => name.startsWith(`${candidate}_`));
  return tier ? TOOL_TIERS.indexOf(tier) : Number.MAX_SAFE_INTEGER;
}

function requiredToolFor(bot: any, blockName: string): string | null {
  const block = blockDefinition(bot, blockName);
  const harvestTools = block?.harvestTools;
  if (!harvestTools || !Object.keys(harvestTools).length) return null;
  const names = Object.keys(harvestTools)
    .map((id) => bot.registry.items[Number(id)]?.name)
    .filter((name: string | undefined): name is string => Boolean(name));
  if (!names.length) return null;
  return [...names].sort((a, b) => toolTierRank(a) - toolTierRank(b))[0];
}

function determineRoute(bot: any, itemName: string, data: OdysseyData): "craft" | "mine" | "smelt" | "kill" | null {
  const explicit = data.func[itemName];
  if (explicit === "craft") return "craft";
  if (explicit === "mine") return "mine";
  if (explicit === "smelt") return "smelt";
  if (explicit === "kill" || explicit === "collect_mine") return "kill";

  const itemDef = itemDefinition(bot, itemName);
  if (itemDef) {
    const hasRecipe =
      bot.recipesAll(itemDef.id, null, null).filter(Boolean).length > 0 ||
      bot.recipesAll(itemDef.id, null, blockDefinition(bot, "crafting_table")).filter(Boolean).length > 0;
    if (hasRecipe) return "craft";
  }
  if (data.mapName[itemName]?.length || blockDefinition(bot, itemName)) return "mine";
  return null;
}

async function resolveCraft(itemName: string, neededCount: number, depth: number, state: ResolveState): Promise<ResolveResult> {
  const bot = state.context.bot;
  const itemDef = itemDefinition(bot, itemName);
  if (!itemDef) return resolveFail(itemName, `unknown item ${itemName}`);

  const allRecipes = [
    ...bot
      .recipesAll(itemDef.id, null, null)
      .filter(Boolean)
      .map((recipe: any, index: number) => ({ recipe, requiresTable: false, index })),
    ...bot
      .recipesAll(itemDef.id, null, blockDefinition(bot, "crafting_table"))
      .filter(Boolean)
      .map((recipe: any, index: number) => ({ recipe, requiresTable: true, index: index + 100000 }))
  ];
  const best = bestMissingRecipeCandidate(bot, allRecipes, neededCount);
  if (!best) return resolveFail(itemName, `no recipe available for ${itemName}`);

  // craftTool only uses a table that is already nearby or in inventory; a
  // table-only recipe must obtain one first, same as the smelt route's furnace.
  // Resolve it before computing missing materials — crafting the table itself
  // consumes planks the recipe may also need.
  if (best.requiresTable) {
    const hasTable =
      findBlockMatching(bot, (block: any) => block.name === "crafting_table", 16, 1).length > 0 || itemCount(bot, "crafting_table") > 0;
    if (!hasTable) {
      const tableResult = await resolve("crafting_table", 1, depth + 1, state);
      if (!tableResult.ok) return needFail("crafting_table", tableResult);
    }
  }

  const missing = missingMaterialsForRecipe(bot, best.recipe, neededCount);
  for (const [material, materialCount] of Object.entries(missing)) {
    const result = await resolve(material, materialCount, depth + 1, state);
    if (!result.ok) return needFail(`${materialCount} ${material}`, result);
  }

  const attempt = await attemptPrimitive(state, itemName, () => craftTool({ item: itemName, count: neededCount }, state.context));
  if (!attempt.ok) return resolveFail(itemName, attempt.reason);
  if (attempt.result.status !== "success") return resolveFail(itemName, attempt.result.detail);
  return RESOLVED_OK;
}

async function resolveMine(itemName: string, neededCount: number, depth: number, state: ResolveState): Promise<ResolveResult> {
  const bot = state.context.bot;
  const candidates: string[] = state.data.mapName[itemName]?.length
    ? state.data.mapName[itemName]
    : blockDefinition(bot, itemName)
      ? [itemName]
      : [];
  if (!candidates.length) return resolveFail(itemName, `no known block source for ${itemName}`);

  const toolName = requiredToolFor(bot, candidates[0]);
  if (toolName && itemCount(bot, toolName) <= 0) {
    const toolResult = await resolve(toolName, 1, depth + 1, state);
    if (!toolResult.ok) return needFail(toolName, toolResult);
  }

  const mineContext: ToolContext = { ...state.context, resolverBypassWhitelist: true };
  let lastReason = `no ${candidates.join("/")} found nearby`;
  for (const blockName of candidates) {
    if (itemCount(bot, itemName) >= neededCount) break;
    const remaining = neededCount - itemCount(bot, itemName);
    const attempt = await attemptPrimitive(state, itemName, () => mineBlockTool({ type: blockName, count: remaining }, mineContext));
    if (!attempt.ok) {
      lastReason = attempt.reason;
      break;
    }
    if (attempt.result.status !== "success") lastReason = attempt.result.detail;
  }

  if (itemCount(bot, itemName) >= neededCount) return RESOLVED_OK;
  return resolveFail(itemName, lastReason);
}

async function resolveSmelt(itemName: string, neededCount: number, depth: number, state: ResolveState): Promise<ResolveResult> {
  const bot = state.context.bot;
  const inputName = state.data.preSmelt[itemName];
  if (!inputName) return resolveFail(itemName, `no smelting recipe known for ${itemName}`);

  const inputResult = await resolve(inputName, neededCount, depth + 1, state);
  if (!inputResult.ok) return needFail(`${neededCount} ${inputName}`, inputResult);

  const hasFurnace = findBlockMatching(bot, (block: any) => block.name === "furnace", 16, 1).length > 0 || itemCount(bot, "furnace") > 0;
  if (!hasFurnace) {
    const furnaceResult = await resolve("furnace", 1, depth + 1, state);
    if (!furnaceResult.ok) return needFail("furnace", furnaceResult);
  }

  if (!findAnyInventoryItem(bot, fuelPriority)) {
    const fuelResult = await resolve("coal", 1, depth + 1, state);
    if (!fuelResult.ok) return needFail("fuel (coal)", fuelResult);
  }

  const attempt = await attemptPrimitive(state, itemName, () => smeltTool({ item: inputName, count: neededCount }, state.context));
  if (!attempt.ok) return resolveFail(itemName, attempt.reason);
  if (attempt.result.status !== "success") return resolveFail(itemName, attempt.result.detail);
  return RESOLVED_OK;
}

async function resolveKill(itemName: string, neededCount: number, depth: number, state: ResolveState): Promise<ResolveResult> {
  const bot = state.context.bot;
  const mobList = state.data.preCollect[itemName];
  if (!mobList?.length) return resolveFail(itemName, `no known way to obtain ${itemName}`);

  let lastReason = `need ${mobList.join(" or ")} for ${itemName}; none nearby`;
  while (itemCount(bot, itemName) < neededCount) {
    const entity = nearestEntity(bot, (candidate: any) => mobList.includes(candidate.name), state.context.config.entity_radius_blocks);
    if (!entity) break;
    const attempt = await attemptPrimitive(state, itemName, () => attackTool({ entity_type: entity.name }, state.context));
    if (!attempt.ok) {
      lastReason = attempt.reason;
      break;
    }
    if (attempt.result.status !== "success") {
      lastReason = attempt.result.detail;
      break;
    }
  }

  if (itemCount(bot, itemName) >= neededCount) return RESOLVED_OK;
  return resolveFail(itemName, lastReason);
}

async function resolve(itemName: string, neededCount: number, depth: number, state: ResolveState): Promise<ResolveResult> {
  assertNotAborted(state.context.signal);
  const bot = state.context.bot;
  if (itemCount(bot, itemName) >= neededCount) return RESOLVED_OK;
  if (depth > MAX_DEPTH) return resolveFail(itemName, `recursion depth cap (${MAX_DEPTH}) reached resolving ${itemName}`);
  if (state.stack.includes(itemName)) return resolveFail(itemName, `cycle detected: ${itemName} is already being resolved`);

  state.stack.push(itemName);
  try {
    const route = determineRoute(bot, itemName, state.data);
    switch (route) {
      case "craft": {
        const crafted = await resolveCraft(itemName, neededCount, depth, state);
        if (crafted.ok) return crafted;
        // Recipe routes can dead-end on storage-block cycles (wheat <-> hay_block)
        // or unobtainable inputs; when the item also exists as a mineable block,
        // probe that before giving up. On a double failure keep the craft report:
        // it carries the prerequisite chain.
        if (state.data.mapName[itemName]?.length || blockDefinition(bot, itemName)) {
          const mined = await resolveMine(itemName, neededCount, depth, state);
          if (mined.ok) return mined;
        }
        return crafted;
      }
      case "mine":
        return await resolveMine(itemName, neededCount, depth, state);
      case "smelt":
        return await resolveSmelt(itemName, neededCount, depth, state);
      case "kill":
        return await resolveKill(itemName, neededCount, depth, state);
      default:
        return resolveFail(itemName, `no known way to obtain ${itemName}`);
    }
  } finally {
    state.stack.pop();
  }
}

/**
 * Resolves "get X" into its full mine/craft/smelt/kill prerequisite chain in one
 * deterministic call, reusing the existing per-tool implementations as steps.
 * Bounded by a recursion depth cap, a total primitive-step budget, and a per-item
 * attempt cap; checks the abort signal before and after every primitive step so an
 * interrupt unwinds cleanly with partial progress reported.
 */
export async function obtainItemTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const itemName = String(args.item);
  const count = Number(args.count);
  const bot = context.bot;

  if (!itemDefinition(bot, itemName) && !blockDefinition(bot, itemName)) {
    return failed(`obtain_item failed: unknown item ${itemName}`);
  }

  const before = itemCount(bot, itemName);
  if (before >= count) return success(`already have ${before} ${itemName}`);

  const state: ResolveState = {
    context,
    data: loadOdysseyData(bot),
    steps: 0,
    attempts: new Map(),
    stack: []
  };

  try {
    const outcome = await resolve(itemName, count, 0, state);
    const after = itemCount(bot, itemName);
    if (outcome.ok && after >= count) return success(`obtained ${count} ${itemName}`);
    const blockedNote = outcome.ok
      ? "resolution reported success but inventory is still short"
      : `blocked at ${outcome.blockedItem}: ${outcome.reason}`;
    return failed(`obtain_item failed: obtained ${after}/${count} ${itemName}; ${blockedNote}`);
  } catch (error) {
    const after = itemCount(bot, itemName);
    if (error instanceof ObtainBudgetExceeded) {
      return failed(`obtain_item failed: obtained ${after}/${count} ${itemName}; ${error.message}`);
    }
    if (context.signal.aborted || isAbortError(error)) {
      return interrupted(`obtain_item interrupted: obtained ${after}/${count} ${itemName}; ${normalizeError(error)}`);
    }
    return failed(`obtain_item failed: obtained ${after}/${count} ${itemName}; ${normalizeError(error)}`);
  }
}
