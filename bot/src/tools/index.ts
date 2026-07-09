import { ToolHandler } from "../types";
import { attackTool } from "./attack";
import { buildShelterTool } from "./build_shelter";
import { chatTool } from "./chat";
import { craftTool } from "./craft";
import { eatTool } from "./eat";
import { equipTool } from "./equip";
import { exploreTool } from "./explore";
import { fleeTool } from "./flee";
import { gotoTool } from "./goto";
import { mineBlockTool } from "./mine_block";
import { noteTool } from "./note";
import { obtainItemTool } from "./obtain_item";
import { placeBlockTool } from "./place_block";
import { setGoalTool } from "./set_goal";
import { sleepTool } from "./sleep";
import { smeltTool } from "./smelt";
import { stopTool } from "./stop";

export const toolRegistry: Record<string, ToolHandler> = {
  goto: gotoTool,
  explore: exploreTool,
  flee: fleeTool,
  stop: stopTool,
  mine_block: mineBlockTool,
  craft: craftTool,
  smelt: smeltTool,
  obtain_item: obtainItemTool,
  place_block: placeBlockTool,
  eat: eatTool,
  equip: equipTool,
  attack: attackTool,
  build_shelter: buildShelterTool,
  sleep: sleepTool,
  chat: chatTool,
  set_goal: setGoalTool,
  note: noteTool
};

export function timeoutSecondsForTool(tool: string): number {
  // obtain_item chains up to ~25 primitive steps (each up to a mine_block-sized 120s)
  // as one dispatched call, so it needs a much larger ceiling than a single tool.
  if (tool === "obtain_item") return 600;
  if (["goto", "explore", "mine_block"].includes(tool)) return 120;
  return 60;
}
