# Vendored Odyssey routing data

Source: https://github.com/zju-vipa/odyssey (`MC-Comprehensive-Skill-Library`).
License: MIT. Copyright the MineDojo Team / ZJU-VIPA.

These four JSON files are copied verbatim from the upstream repo and are filtered
against the live 1.21 `minecraft-data` registry at runtime (see
`bot/src/tools/odyssey_data.ts`) — entries whose item/block/entity names don't exist
in the running Minecraft version are dropped, with a one-time count logged.

What was taken and why:

- `func.json` — which method (`craft`/`mine`/`smelt`/`kill`/`collect_mine`) obtains a
  given item at all. This routing knowledge isn't derivable from `minecraft-data`.
- `pre_collect.json` — mob drops and special collection sources used by the `kill`
  route (e.g. `string` -> `spider`/`cave_spider`).
- `map_name.json` — drop/family name -> block name mapping (e.g. `raw_iron` ->
  `iron_ore`, `deepslate_iron_ore`; `cobblestone` -> `stone`) used to find the right
  block(s) to mine for a requested item.
- `pre_smelt.json` — smelting output -> input item mapping (e.g. `iron_ingot` ->
  `raw_iron`). Vendored because mineflayer's `minecraft-data` (checked at 1.21.11)
  ships crafting recipes (`recipes.json`) and block harvest-tool data
  (`blocks.json` `harvestTools`) but has no furnace/smelting recipe table at all.

Intentionally NOT vendored: Odyssey's `pre_item.json` and `pre_tool.json`. Both are
stale 1.19 duplicates of facts `minecraft-data` already provides live for 1.21 —
crafting recipes via `bot.recipesFor`/`bot.recipesAll`, and harvest tool tiers via
`block.harvestTools` — so those are read from `minecraft-data` at runtime instead.

Odyssey's own recursive resolver (`skill/obtainItem.js` and friends) was read for
reference only and was not copied — it retries a failing step forever
(`while (!res)`), which `bot/src/tools/obtain_item.ts` deliberately does not
reproduce (recursion depth cap, primitive-step budget, and per-item attempt cap
instead).
