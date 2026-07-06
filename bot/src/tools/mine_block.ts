import { ToolContext, ToolResult } from "../types";
import { assertNotAborted, isAbortError, matchesWhitelist, normalizeError } from "../utils";
import { collectBlockInterruptible, failed, findBlocksByName, interrupted, success } from "./helpers";

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
    if (!matchesWhitelist(type, context.config.block_whitelist)) {
      return failed(`mine_block failed: ${type} is not in block whitelist`);
    }
    const blocks = findBlocksByName(context.bot, type, context.config.scan_radius_blocks, count + 8);
    if (!blocks.length) {
      return failed(`mine_block failed: no ${type} found within ${context.config.scan_radius_blocks} blocks`);
    }

    let lastError = "";
    for (const block of blocks) {
      if (mined >= count) break;
      try {
        assertNotAborted(context.signal);
        await collectBlockInterruptible(context, block);
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
