# QwenCraft Development Log

Date: 2026-07-05

## Project Summary

QwenCraft is a two-process local Minecraft survival agent.

- `bot/`: TypeScript Mineflayer sidecar. It connects to Minecraft, hosts a local WebSocket server, builds compact observations, and executes high-level tools.
- `brain/`: Python planner. It connects as a WebSocket client, calls an OpenAI-compatible local LLM endpoint, parses exactly one tool call, dispatches it to the bot, and logs trajectories.
- `schemas/`: JSON Schema source of truth for observations and tool definitions.
- `docker-compose.yml`: local offline-mode Minecraft server using `itzg/minecraft-server`.
- `eval/`: mock episode runner and metrics.
- `logs/`: JSONL trajectories, gitignored.

The intended control loop is:

1. Bot builds a compact JSON observation.
2. Brain merges memory and sends observation plus tool schemas to the LLM.
3. LLM returns one tool call.
4. Bot executes the tool autonomously.
5. Result becomes `last_action` in the next observation.

The LLM is not called every tick. Calls happen after tool completion/failure, interrupt events, or idle heartbeat.

## Runtime Versions And Policy

- The repo currently targets Minecraft `1.21.11`, Mineflayer `4.37.1`, and Node `22+`.
- The user originally asked about "Minecraft 26.2"; the current repo documents that newer/experimental versions require coordinated updates to `mc_version`, Docker `VERSION`, Mineflayer, and Prismarine data support.
- Python is managed with `uv`, not plain `pip` workflows.
- The current local model path is `/home/seant/Documents/LocalLLM/Qwen3.5-9B-Q8_0.gguf`.
- `config.yaml` is set up for llama.cpp:
  - `llm_base_url: http://127.0.0.1:8080/v1`
  - `llm_model: Qwen3.5-9B-Q8_0`
- vLLM remains the recommended default for Hugging Face/safetensors weights on GPU, especially for OpenAI-compatible tool calling. For this GGUF file, llama.cpp is the practical path.

## Current Startup Commands

Minecraft server:

```bash
docker compose up -d
```

Fallback for Docker Compose v1:

```bash
docker-compose up -d
```

Bot:

```bash
cd bot
npm install
npm start
```

llama.cpp server:

```bash
llama-server -m /home/seant/Documents/LocalLLM/Qwen3.5-9B-Q8_0.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  -c 8192 \
  --jinja
```

Brain:

```bash
uv run python -m brain.main
```

Mock brain:

```bash
uv run python -m brain.main --mock
```

## Major Fixes Already Made

- Switched the bot JSON Schema validator to `ajv/dist/2020.js` so draft 2020-12 schemas compile.
- Fixed TypeScript build output by setting `rootDir: "src"` so `npm start` can run `dist/index.js`.
- Changed `npm start` to compile first and then run `node dist/index.js`; `npm run dev` remains available for `tsx`.
- Added README prerequisites for Docker daemon, Compose plugin, Node, uv, and local LLM serving.
- Added Docker troubleshooting for `/var/run/docker.sock` and missing Compose v2.
- Documented GGUF serving through llama.cpp and vLLM's experimental GGUF path.
- Updated `config.yaml` for the user's local GGUF model via llama.cpp on port `8080`.
- Added friendly Python errors for missing LLM endpoint.
- Disabled aggressive Python WebSocket keepalive pings. Long tools can run around two minutes, so a 20s ping timeout was too fragile.
- Added brain-side tool timeout handling that sends `stop()` and returns a structured failed result instead of crashing.
- Added clearer Python errors when the bot WebSocket is unavailable or closes.
- Added live bot logging:
  - WebSocket connections
  - observations
  - tool starts
  - tool results
  - reflex events
  - position, health, hunger, inventory sketch, and heap usage
- Added brain-side decision/result prints.
- Capped Mineflayer pathfinder search radius to avoid unbounded path searches in survival terrain.
- Wired abort signals so timed-out tools actually stop pathfinder/PvP behavior.
- Made `mine_block` collection interruptible.
- Added a short cache for expensive block-interest scans.
- Fixed an observation crash where Mineflayer reported `oxygenLevel > 20`; status values are now clamped to schema ranges.

## Recent Runtime Observations

The bot successfully spawned and was visibly walking around the server. It encountered a nearby zombie and the reflex/interrupt path worked:

```text
event name=hostile_close data={"type":"zombie","dist":5.8}
tool result tool=stop status=success detail=stop requested (mine_block)
tool result tool=mine_block status=failed detail=mine_block failed: stop requested
```

Immediately after that, the bot crashed because the observation schema rejected `status.oxygen > 20`. This has been fixed by clamping health, hunger, oxygen, and light before validation.

## Current Verification Commands

Bot:

```bash
cd bot
npm run build
npm test
```

Python:

```bash
UV_CACHE_DIR=.uv-cache uv run python -m py_compile brain/*.py eval/run_episode.py
UV_CACHE_DIR=.uv-cache uv run pytest
```

## Known Caveats

- `mineflayer-auto-eat` still emits a deprecated `physicTick` warning internally. The repo's own reflex code uses `physicsTick`.
- `npm install` reports dependency audit warnings from the Mineflayer/plugin ecosystem. We have not run `npm audit fix --force` because that may introduce breaking dependency changes.
- Docker integration could not be fully verified in this environment because Docker daemon access depends on the user's host setup.
- The repo is still largely untracked in git. A future cleanup commit should add the scaffold intentionally rather than relying on a patch diff.
- If Node heap usage climbs again, watch the bot terminal's `heap_mb` line and correlate it with the current `tool=` status log.

## Suggested Next Chat Starting Point

Start from the current runtime issue, not from scaffolding:

- Run the server, bot, llama.cpp, and brain.
- Watch bot logs for `heap_mb`, `tool start`, and `tool result`.
- Use the JSONL logs in `logs/` to inspect LLM decisions.
- If another crash occurs, paste the bot terminal output plus the nearest brain `decision` line.

## [2026-07-05] fix | Treat hunger as planner signal, not interrupt

Removed `hunger_low` from the brain interrupt event set so hunger no longer aborts active tools. Hunger still reaches Qwen through `status.hunger`, `danger_flags`, and throttled events.
Added an auto-eat in-flight guard and retry cooldowns so missing food does not flood the bot/brain event stream with repeated `auto_eat_failed` messages.
Verified with `npm run build`, `npm test`, Python compile, and `uv run pytest`.

## [2026-07-05] fix | Keep threat handling from crashing flee

Caught emergency auto-flee pathfinder errors so `GoalChanged` rejections become `emergency` events instead of unhandled Node process crashes.
Refined brain interrupts so new threat events still stop non-defensive work but no longer cancel an active `flee`; death still interrupts everything.
Added an attack safety gate below 8 health and strengthened the prompt against low-health attacks.
Verified with `npm run build`, `npm test`, Python compile, and `uv run pytest`.

## [2026-07-05] plan | v1 review → goals.md roadmap + GPT-5.5 handoff spec

Full code review (Claude). Top findings: repeating reflex events still abort the tools handling them (`night_falling` kills `build_shelter`; `damage_taken` kills `attack` — partial fixes for flee/attack landed in the prior entry); `history_summary` grows unbounded inside every prompt (the real memory explosion at `-c 8192`); the hardcoded "survive" system prompt overrules `set_goal`, blocking progression.
Wrote `doc/goals.md` (v1.1 stabilize, v1.2 bounded memory, v2.0 progression, v2.1 sustainability tools, v3 growth) and `doc/handoff-gpt55.md` (three-phase implementation spec with verification gates, written to build on the existing `should_interrupt`).
Decision: no world border — unlimited exploration is intended; world disk growth accepted.
Next: run `doc/handoff-gpt55.md` through GPT-5.5 phase by phase, gating each on `npm test` + `uv run pytest`.

## [2026-07-05] phase1 | Stabilize interrupt, observation, and mining paths

Implemented v1.1 stabilizers: data-aware interrupt matrix with once-per-event stop suppression, localhost-only bot WebSocket, shared hostile/whitelist matching, partial-progress `mine_block`, honest light/biome fallbacks, LLM parse retry context, eval metric fixes, and stale `bot/dist/` cleanup.
Verified `npm run build`, `npm test`, `UV_CACHE_DIR=.uv-cache uv run pytest`, and `UV_CACHE_DIR=.uv-cache uv run python -m py_compile brain/*.py eval/run_episode.py`.
Docker daemon access failed with `/var/run/docker.sock` permission denied, so the optional seeded mock episode and live daylight/biome observation check remain unverified in this session.

## [2026-07-05] phase2 | Bound memory, rotate logs, and persist state

Implemented bounded working memory: 200-char event caps, 1200-char history budget with planner compression/fallback truncation, slim LLM JSONL logging, startup gzip rotation, capped long-term memory retrieval, shelter/death upserts, and restart persistence for goal/pins/history.
Added tmp-path tests for budget trigger/fallback, event caps, log rotation, slim responses, long-term eviction/retrieval/persistence, and atomic-write crash behavior.
Verified `npm run build`, `npm test`, `UV_CACHE_DIR=.uv-cache uv run pytest`, and `UV_CACHE_DIR=.uv-cache uv run python -m py_compile brain/*.py eval/run_episode.py`.
Docker daemon access is still denied, so the kill/restart mock episode confirmation could not be run here.

## [2026-07-05] phase3 | Add progression scaffold and equip tool

Completed the handoff: Phase 1 stabilized interrupts/mining/observations, Phase 2 bounded memory/logs/state, and Phase 3 made the prompt goal-driven with curriculum stage hints, milestone achievements, the `equip` tool, and ladder-aligned eval metrics.
Added curriculum and equip tests; final verification passed with `npm run build`, `npm test`, `UV_CACHE_DIR=.uv-cache uv run pytest`, and `UV_CACHE_DIR=.uv-cache uv run python -m py_compile brain/*.py eval/run_episode.py`.
`bot/dist/` now rebuilds to the current root output only; Docker daemon access remains blocked by `/var/run/docker.sock` permission denied, so live episode gates remain unverified here.

## [2026-07-05] diagnose | Night interrupt storm → death loop → bot OOM at 4GB heap

Reviewed the GPT-5.5 build (all 31 tests green, spec followed faithfully, longterm retrieval confirmed working in the live run). But episode_20260705T185804Z shows 24 decisions in 118s, ~3 deaths (hp resets to 20), and nearly every gather/move tool killed by "stop requested" within 1-3s; the bot then OOM'd at ~4GB Node heap in under 3 minutes.
Root cause chain: `hostile_close` re-fires every 5s and the edge-trigger is per-dispatch only, so every *new* tool gets interrupted; the LLM keeps re-issuing mine_block at night (stage hint pushes progression, no "safety first at night" rule); each aborted dispatch leaves a pathfinder A* compute running to its think budget — now 4000ms (raised per handoff spec 1.4, in hindsight a mistake) with searchRadius 64 and canDig — plus per-hit emergency auto-flees and death/respawn chunk re-parses. Allocation outran GC.
Bot keeps playing through death/respawn: nothing aborts the current tool or resets brain context on death.
Next: cross-dispatch interrupt cooldown, night-safety prompt rule, thinkTimeout back to ~1500-2000 + setGoal(null) on abort, emergency-flee cooldown, death → abort current tool.

## [2026-07-05] fix | Damp interrupt storm and pathfinder heap blowup

Implemented the five OOM/thrash fixes from the diagnosis entry (Claude).
Brain: cross-dispatch interrupt cooldown (30s per event name, bypassed when the news escalates — closer hostile or lower health; death/emergency never rate-limited); night-safety hard rule in the system prompt (night + hostiles → build_shelter/sleep/flee/stop only).
Bot: pathfinder thinkTimeout 4000→2000 and searchRadius 64→48, `setGoal(null)` added to every abort path so in-flight A* computations actually drop; emergency auto-flee gets a 10s cooldown and no longer fires while a `flee` tool is running (it was aborting the very flee the brain protects); death now aborts the current tool instead of playing through respawn.
Also: aborted tools now report `interrupted` instead of `failed: stop requested` (central reclassification in executeToolCall; mine_block keeps its partial counts on abort).
Verified with `npm run build`, `npm test` (7), `uv run pytest` (28, 4 new interrupt-cooldown tests), py_compile. Not yet live-verified: run an episode and watch the bot terminal's `heap_mb` line — it should stay flat through a night fight now.

## [2026-07-05] fix | Report actionable craft recipe variants

Fixed `craft` failure diagnostics so recipe variants are scored against current inventory instead of reporting the first arbitrary `recipesAll()` variant; tied plank variants now prefer wood types whose logs/stems are held.
Craft failures for 3x3 recipes also append `no crafting_table nearby (craft or place one)` when the best recipe needs a table and none was found or placed.
Added bot tests for oak-log → oak-planks diagnostics and the missing crafting table cause. Verified `npm run build` and `npm test` (9).

## [2026-07-05] fix | Keep pending crafts goal-oriented

Added brain-owned `memory.pending_craft` so failed crafts remain an explicit short-term subgoal across dependency work; dependency craft failures no longer overwrite the original target, and the breadcrumb clears on success or once the item appears in inventory.
Extended the prompt to treat pending crafts as the immediate safe craft subgoal, and persisted the breadcrumb with brain state.
Generalized craft recipe variant scoring beyond wood: stone-material recipes now cross-check inventory families and default to `cobblestone` before deepslate/blackstone when there is no inventory signal.
Verified `npm run build`, `npm test` (10), `UV_CACHE_DIR=.uv-cache uv run pytest` (30), and `UV_CACHE_DIR=.uv-cache uv run python -m py_compile brain/*.py eval/run_episode.py`.

## [2026-07-06] plan | Brainstorm → goals v2.2–v4: Odyssey port, critic, SFT track

Reviewed the local Odyssey clone for portable pieces (Claude). Decision: port the recursive `obtainItem` resolver as a bot tool backed by live minecraft-data 1.21 — Odyssey's `pre_item`/`pre_tool`/`pre_smelt` JSONs are stale 1.19 duplicates of data mineflayer already has; vendor only `func`/`pre_collect`/`map_name` routing knowledge.
Rewrote goals.md: v2.2 SFT-ready decision records (start first — every run without them is lost training data), v2.3 `obtain_item` port, v2.4 DEPS failure critic + Optimus-1 knowledge/experience memory split, v3 role-based two-speed planning, v4 SFT (LLaMA-Rider own-trajectories + Odyssey MineMA knowledge injection adapted to Qwen).
Rejected Odyssey's full planner-actor-critic: their actor free-writes JS and needed a fine-tuned MineMA-8B to work; our constrained JSON tool calls already fill the actor role for a 9B. Adopt only the critic and a slow planner role.
Clarified: llama-server chat completions are stateless (no cross-role memory bleed); only prompt-cache warmth is affected by role swaps — solved later with `-np 2/3` and a larger `-c`.
Next: still owe the live heap_mb verification from the 2026-07-05 OOM fixes, then implement v2.2 decision records.

## [2026-07-07] orchestrate | Crash diagnosis + v2.2 records, v2.3 obtain_item, v2.4 critic (Sonnet agents)

Diagnosed the latest crash (episode_20260705T201443Z): bot-side Node heap OOM, not the brain — the LLM re-issues identical failing `mine_block` calls (no consecutive-failure guard existed anywhere) while `interruptible()` abandoned rather than cancelled the underlying collectBlock promises, leaking A* state per retry.
Fixes: bot `interruptible()` now calls `collectBlock.cancelTask()` and drains abandoned promises (3s grace, warning logged on overrun); brain `FailureTracker` blocks an identical (tool,args) call for 300s after 2 consecutive failures and states the block in the prompt, with the retry path rejecting banned calls.
Landed v2.2 decision records (`logs/decisions_*.jsonl` + `eval/export_sft.py`, byte-identical prompt re-render incl. injected extras), v2.3 `obtain_item` (recursive resolver on minecraft-data 1.21 + vendored Odyssey func/pre_collect/map_name/pre_smelt — minecraft-data ships no smelting data, goals.md corrected; whitelist bypass for resolver-targeted mining; 600s budget both sides), v2.4 failure critic (one-shot DEPS explanation → next prompt, lesson → longterm) and knowledge/experience memory split (100/100 caps, category eviction, transparent migration).
Verified: `npm run build`, `npm test` (19), `uv run pytest` (74), py_compile. Not live-verified: heap_mb flatness across forced mine_block timeouts, obtain_item chains on a real server, critic quality with the real LLM.
Next: run a live episode — watch `heap_mb` and `tool abort drain timed out` lines, look for BLOCKED/CRITIC lines in prompts, and export the episode's decisions JSONL as the first SFT sample.

## [2026-07-09] fix | Wheat unobtainable: crop routing, craft→mine fallback, food priority
obtain_item(wheat) always failed: no "wheat" entry in odyssey func.json, so the
route fell through to wheat's only recipe (hay_block → 9 wheat), and hay_block
crafts from 9 wheat → cycle detected. Whitelist was a red herring (resolver
bypasses it). Added crop entries (wheat/carrot/potato/beetroot/sweet_berries)
to func/map_name, a craft→mine fallback in resolve(), and a mature-crop age
filter in mine_block (immature crops drop seeds only). Brain: new hard rule to
explore for food in daylight when hungry with none in view, plus a first_food
milestone (3 food) after sheltered. Tests cover the cycle fallback and immature
crops. Next: live episode next to the wheat farm to confirm end-to-end.

## [2026-07-09] fix | Crop harvesting: direct dig + replant instead of collectblock
Live run showed mine_block(wheat) collecting 1 crop then "Took to long to decide
path to goal!": collectblock's stand-adjacent goal is too strict for dense farms
under the 2s pathfinder think budget, and progress mostly came from farmland
trampling. Crops now use a dedicated path in mine_block: GoalNear(1), direct
bot.dig (instant break, drops land at feet), then best-effort replant of the
matching seed on the farmland; sweet berry bushes use activateBlock so the bush
survives. New mine_block.test.ts covers dig+replant, no-seed, and berry cases.
Next: watch a live harvest for pickup reliability and replant success rate.

## [2026-07-09] fix | OOM crash: collectblock path never had the pathfinder heap budget
Live OOM (62MB -> 4GB, SIGABRT) right after mine_block(stone) under phantom
attack. Root cause: the v1 heap fix (thinkTimeout 2000/searchRadius 48) lives in
configureMovements, which only gotoNear-based tools call; mine_block's
collectblock path ran on pathfinder defaults (thinkTimeout 5000, searchRadius
-1 unbounded) and collectblock swaps in its own default Movements per collect.
mine_block now applies configureMovements and hands collectblock the budgeted
movements before mining. Combat-reaction gaps (damage interrupt <8hp, flee(10)
death spiral, idle-during-LLM-think) diagnosed, fixes pending decision.

## [2026-07-09] fix | Combat survival: earlier interrupts, flee-to-safety, idle keep-away, shelter preflight
Live runs showed 2-3 free hits before the brain reacted, then a flee(10) ->
LLM-think -> get-hit death spiral. Four changes: damage_taken now interrupts
below 12hp (was 8); flee hops repeatedly (up to 3) until no hostile within 12
blocks instead of one fixed hop; a new idle-only keep-away reflex steps 8 blocks
from any hostile within 4 while the planner is deciding (never fights a running
tool, 5s throttle, emits keep_away); build_shelter dirt_box preflights material
(needs up to 25 blocks) and fails fast with the shortfall + dig_in hint instead
of half-building. Tests: flee hop budget/safety, shelter preflight, interrupt
threshold. Next: live night episode to check the spiral is broken and keep_away
does not thrash with the planner.

## [2026-07-09] fix | Second mine_block OOM: adaptive search radius + heap watchdog
Same OOM recurred WITH the movements budget applied, no interrupts involved:
mine_block(stone,16) barehanded at stone level, 67MB -> 4GB in <1min. Mechanism:
each 2s dig-A* at radius 48 saturates ~0.5GB of nodes when every neighbor is
diggable; fired back-to-back per candidate they outpace 3s mark-compact GC and
the loop starves. mine_block now caps thinkTimeout at 1s and sizes searchRadius
per target (distance+8, max 48). Added heap watchdog in index.ts: >1GB logs
"heap pressure" + aborts tool/search/collect; >2GB exits(3) cleanly instead of
SIGABRT. If pressure lines ever appear, they name the tool — that is the
diagnostic breadcrumb. Also confirmed dirt_box preflight + dig_in fallback
worked as designed in this episode.

## [2026-07-09] fix | obtain_item: resolve crafting_table as a prerequisite
Live run: obtain_item(wooden_pickaxe) failed "no crafting_table nearby" despite
having planks — resolveCraft resolved recipe materials but treated the table as
craftTool's problem, and craftTool only uses a table already nearby/in inventory.
Now a table-only recipe resolves crafting_table first (mirrors the smelt route's
furnace step), ordered before the missing-materials computation since crafting
the table consumes 4 planks the recipe may also need. Test mock upgraded to
table-aware recipes + real Vec3 positions; new test covers the full chain
(craft table -> place -> craft pickaxe).
