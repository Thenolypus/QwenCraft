import { Vec3 } from "vec3";
import { ToolContext, ToolResult } from "../types";
import { assertNotAborted, delay, isAbortError, itemCount, matchesWhitelist, normalizeError } from "../utils";
import { collectBlockInterruptible, configureMovements, equipByName, failed, findBlocksByName, gotoNear, interrupted, success } from "./helpers";

// Immature crop blocks drop seeds or nothing instead of their item; only harvest
// grown ones (sweet berry bushes start yielding at age 2).
const CROP_MIN_AGE: Record<string, number> = {
  wheat: 7,
  carrots: 7,
  potatoes: 7,
  beetroots: 3,
  sweet_berry_bush: 2
};

// What to put back on the farmland after harvesting, when we have it.
const CROP_SEED: Record<string, string> = {
  wheat: "wheat_seeds",
  carrots: "carrot",
  potatoes: "potato",
  beetroots: "beetroot_seeds"
};

function isGrownCrop(block: any): boolean {
  const minAge = CROP_MIN_AGE[block.name];
  if (minAge === undefined) return true;
  const age = Number(block.getProperties?.()?.age);
  return Number.isFinite(age) && age >= minAge;
}

// Crops are instant-break, collision-free blocks; collectblock's stand-adjacent
// goal is overkill for them and times out on dense farm layouts under the tight
// pathfinder think budget. Walk near, break directly (drops land at our feet),
// and replant so the farm keeps producing.
async function harvestCropBlock(context: ToolContext, block: any, type: string): Promise<void> {
  const bot = context.bot;
  const pos = block.position;
  await gotoNear(context, pos.x, pos.y, pos.z, 1);
  assertNotAborted(context.signal);
  const crop = bot.blockAt(pos);
  if (crop && crop.name === type) {
    if (type === "sweet_berry_bush") {
      // Right-click harvest yields berries without destroying the bush.
      await bot.activateBlock(crop);
      return;
    }
    await bot.dig(crop);
  }
  await replantCrop(context, pos, type);
}

async function replantCrop(context: ToolContext, pos: any, type: string): Promise<void> {
  const bot = context.bot;
  const seed = CROP_SEED[type];
  if (!seed) return;
  // Give the just-dropped seeds a moment to reach the inventory.
  await delay(250);
  assertNotAborted(context.signal);
  if (itemCount(bot, seed) <= 0) return;
  const farmland = bot.blockAt(pos.offset(0, -1, 0));
  if (farmland?.name !== "farmland") return;
  try {
    if (await equipByName(context, seed)) await bot.placeBlock(farmland, new Vec3(0, 1, 0));
  } catch {
    // Best-effort: a failed replant must not fail the harvest.
  }
}

/**
 * Mines nearest matching whitelisted blocks with collectblock and collects drops.
 * Fails when the block type is not whitelisted, unknown, absent in range, or unmineable.
 */
export async function mineBlockTool(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  let type = "block";
  let count = 0;
  let mined = 0;
  try {
    type = String(args.type);
    count = Number(args.count);
    if (!context.resolverBypassWhitelist && !matchesWhitelist(type, context.config.block_whitelist)) {
      return failed(`mine_block failed: ${type} is not in block whitelist`);
    }
    const candidates = findBlocksByName(context.bot, type, context.config.scan_radius_blocks, count + 8);
    const blocks = candidates.filter(isGrownCrop);
    if (!blocks.length) {
      const note = candidates.length
        ? `only immature ${type} found within ${context.config.scan_radius_blocks} blocks (wait for crops to grow)`
        : `no ${type} found within ${context.config.scan_radius_blocks} blocks`;
      return failed(`mine_block failed: ${note}`);
    }

    if (CROP_MIN_AGE[type] === undefined) {
      // collectblock swaps in its own default Movements per collect, and the
      // pathfinder plugin defaults are unbounded (searchRadius -1, thinkTimeout
      // 5000ms) — exactly the dig-A* heap blowup the movement budget exists to
      // prevent. Configure the budget and hand collectblock our movements so
      // its internal setMovements applies them.
      const movements = configureMovements(context);
      if (context.bot.collectBlock) context.bot.collectBlock.movements = movements;
      // Even budgeted, a 2s dig-A* at radius 48 saturates ~0.5GB of nodes when
      // every neighbor is diggable stone; fired back-to-back per candidate they
      // outpace GC (observed: 67MB -> 4GB OOM in under a minute). Collect paths
      // are short, so cap think time hard here and size the radius per target.
      context.bot.pathfinder.thinkTimeout = 1000;
    }

    let lastError = "";
    for (const block of blocks) {
      if (mined >= count) break;
      try {
        assertNotAborted(context.signal);
        if (CROP_MIN_AGE[type] !== undefined) await harvestCropBlock(context, block, type);
        else {
          const reach = context.bot.entity.position.distanceTo(block.position);
          context.bot.pathfinder.searchRadius = Math.min(48, Math.ceil(reach) + 8);
          await collectBlockInterruptible(context, block);
        }
        mined += 1;
      } catch (error) {
        const message = normalizeError(error);
        if (context.signal.aborted || isAbortError(error)) {
          return interrupted(`mine_block interrupted after collecting ${mined}/${count} ${type}: ${message}`);
        }
        lastError = message;
      }
    }

    if (mined === count) return success(`collected ${mined} ${type}`);
    if (mined > 0) return success(`collected ${mined}/${count} ${type} (stopped: ${lastError || "no more candidates"})`);
    return failed(`mine_block failed: ${lastError || `no collectable ${type} found within ${context.config.scan_radius_blocks} blocks`}`);
  } catch (error) {
    const message = normalizeError(error);
    if (context.signal.aborted || isAbortError(error)) {
      return interrupted(`mine_block interrupted after collecting ${mined}/${count || "?"} ${type}: ${message}`);
    }
    return failed(`mine_block failed: ${message}`);
  }
}
