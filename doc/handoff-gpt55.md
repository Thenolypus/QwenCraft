# QwenCraft Implementation Handoff

You are implementing a reviewed and approved set of improvements to QwenCraft,
a two-process local Minecraft agent: `bot/` is a TypeScript Mineflayer sidecar
exposing a WebSocket server and high-level tools; `brain/` is a Python planner
that calls a local Qwen LLM (llama.cpp, OpenAI-compatible) and dispatches
exactly one tool call per decision. Read `CLAUDE.md`, `AGENTS.md`, the latest
entries of `doc/log.md`, and `doc/goals.md` before touching anything.

## Ground rules

- Python runs through `uv` (`uv run ...`); the bot uses npm from `bot/`.
- `doc/log.md` is append-only. After each completed phase, append one entry in
  the format `## [YYYY-MM-DD] <op> | <title>` with a 2–6 line body (what
  happened, what changed, anything surprising). Never edit prior entries.
- Surgical changes only: match existing style, no drive-by refactors, no
  speculative flexibility. Every changed line must trace to an item below.
- Update README sections your changes invalidate (Config, Protocol,
  Troubleshooting).
- Work the phases **in order**. Each phase ends with a verification gate; do
  not start the next phase until it passes.

**Explicitly out of scope — do not do:**

- No world border and no changes to `docker-compose.yml` or `server-data/`.
  Unlimited exploration is an intentional owner decision.
- No chest/farming/breeding tools (those are v2.1, see `doc/goals.md`).
- No RL, screenshots, or web UI.

## Verification gate (run after every phase)

```bash
cd bot && npm run build && npm test
uv run pytest
uv run python -m py_compile brain/*.py eval/run_episode.py
```

If Docker and a local LLM are available, also smoke-test with
`uv run python eval/run_episode.py --mock --seed 1`. If not available, say so
in the log entry instead of skipping silently.

---

## Phase 1 — Stabilize (v1.1)

### 1.1 Complete the interrupt policy matrix (the headliner)

**Problem.** The bot reflexes (`bot/src/reflexes.ts`) re-emit `hostile_close`
every 5s while a hostile is within 6 blocks and `night_falling` every 20s
throughout the sunset window, and `dispatch()` in `brain/main.py` sends `stop`
whenever an interrupt-worthy event arrives while a tool runs. Net effect: the
very tools that handle a situation get aborted by its trigger.

**Already done — build on it, don't redo it.** `should_interrupt(tool, event)`
exists at `brain/main.py:42-49` with tests in
`brain/tests/test_interrupts.py`: `flee` is protected from threat events,
`attack` from `hostile_close`, and the bot-side `attack` tool self-interrupts
below 8 health (`bot/src/tools/attack.ts`).

**Remaining gaps to close:**

- `build_shelter` and `sleep` are still killed by `night_falling` (which
  re-fires all sunset — the bot can never finish a shelter during the window
  it needs one) and by `hostile_close`. Exempt both tools from both events.
- `attack` is still interrupted by `damage_taken`, i.e. every hit received
  cancels the fight even though the tool already self-gates below 8 health.
  Exempt `attack` from `damage_taken`.
- `damage_taken` should interrupt the remaining tools only when
  `data["health"] < 8` — a single fall-damage tick at health 15 should not
  abort a mining run; the planner still learns about it at the next decision
  boundary via `danger_flags` and events. The event already carries `health`
  (`bot/src/reflexes.ts` lines 26–30), so extend the signature to
  `should_interrupt(tool, event, data)`. The bot-side health-below-6
  emergency auto-flee remains the disaster backstop.
- `death` and `emergency` keep interrupting everything except `flee`
  (`emergency` is exempted for `flee` already via `THREAT_EVENTS`).

**Edge-triggering.** Within a single `dispatch()` call, send at most one
`stop` per event name — repeated re-emissions must not send additional stops.

**Tests.** Extend `brain/tests/test_interrupts.py`: shelter/sleep exemptions,
the `damage_taken` health threshold, attack surviving `damage_taken`, and the
once-per-event-name rule.

### 1.2 Bind the WebSocket server to localhost

`bot/src/index.ts` line 55: `new WebSocketServer({ port })` listens on all
interfaces — anyone on the LAN can drive the bot. Change to
`new WebSocketServer({ host: "127.0.0.1", port: config.ws_port })`.

### 1.3 Single source of truth for hostile mobs

Three inconsistent definitions exist: `hostileMobs` in
`bot/src/observation.ts` (lines 19–53, missing `cave_spider`), `hostileTypes`
in `bot/src/utils.ts` (lines 4–38, missing `piglin_brute`), and
`entity.kind === "Hostile mobs"` in `bot/src/reflexes.ts` line 83. Keep one
exported set in `utils.ts` (the union — add the missing entries), delete the
copy in `observation.ts`, and make reflexes use `isHostile(entity.name)`
instead of `entity.kind`.

### 1.4 `mine_block`: partial progress + next-candidate fallback

**Problem.** `bot/src/tools/mine_block.ts` fails the whole call if any single
block collection throws, discarding progress ("collected 5, then reported
failed"). The first real episode failed on exactly this
(`Took to long to decide path to goal!`).

**Required behavior.**

- Fetch `count + 8` candidates from `findBlocksByName` and iterate until
  `count` are mined or candidates run out.
- Per-block try/catch: on a non-abort error, remember it and try the next
  candidate.
- Results: mined == count → `success` "collected N \<type\>"; 0 < mined <
  count → `success` "collected {mined}/{count} \<type\> (stopped: \<last
  error\>)"; mined == 0 → `failed` with the last error; abort →
  `interrupted` including the partial count.
- Raise `pathfinder.thinkTimeout` from 1500 to 4000 in
  `bot/src/tools/helpers.ts` line 37.

### 1.5 Unified whitelist matching in the observation scan

`isWhitelistedBlock` in `bot/src/observation.ts` (lines 159–163) hardcodes
`_log`/`_bed` suffixes and otherwise does exact matching, while `mine_block`
uses `matchesWhitelist` from `utils.ts` which understands `*` wildcards.
Adding e.g. `*_ore` to `config.yaml` would let the bot mine it but never show
it in observations. Replace `isWhitelistedBlock` with
`matchesWhitelist(name, config.block_whitelist)`.

### 1.6 Better parse errors and retry context (`brain/llm.py`)

- `parse_openai_tool_call`: when `len(tool_calls) > 1`, raise
  `ToolParseError(f"model returned {n} tool calls; expected exactly 1")`
  instead of falling through to content parsing (which yields a confusing
  "found 0" error).
- `decide()` retry (line 96): the replayed assistant message is
  `content or ""` — if the failure was inside `tool_calls`, the model never
  sees what it produced. Include the JSON-serialized tool calls in the
  replayed assistant content so the correction request has context.

### 1.7 Honest `light` and `biome` observations

Real episode logs show `"light": 0` in broad daylight and `"biome": ""`. The
model reasons about light for safety, so this is actively misleading.
In `bot/src/observation.ts`:

- `light`: read the block at head level
  (`bot.entity.position.offset(0, 1, 0)`) and report
  `max(block.light ?? 0, block.skyLight ?? 0)`, clamped 0–15.
- `biome`: resolve through the registry
  (`bot.registry.biomes[id]?.name`); never emit an empty string — fall back
  to `"unknown"`.
- Verify against a live observation line if a server is available (daylight
  light > 0, biome non-empty); otherwise note it as unverified in the log
  entry.

### 1.8 Remove the leftover stop-sleep in `dispatch`

`brain/main.py` lines 121–122: the `await asyncio.sleep(heartbeat_seconds)`
inside the dispatch receive loop (for `stop` calls) only delays reading the
result; the real idle heartbeat already lives at the end of `run()`
(line 227). Delete the one inside `dispatch`.

### 1.9 Config default consistency

`brain/models.py` line 18: default `mc_version` is `"26.2"`; change to
`"1.21.11"` to match `config.yaml` and the README version pin.

### 1.10 Eval metric fixes (`eval/run_episode.py`, `metrics()`)

- `first_wood`: count any item whose name ends with `_log`, not just
  `oak_log`.
- `deaths`: `recent_events` windows overlap across rows, so one death is
  counted many times. Count an event only when it is not present in the
  previous row's `recent_events`.

### 1.11 Clean stale build output

`bot/dist/` contains duplicated stale trees from before the `rootDir` fix
(`dist/*.js` and `dist/src/*.js`). Delete `bot/dist/` once; `npm start`
rebuilds it.

**Phase 1 gate:** standard verification plus the new interrupt tests. Append a
log entry.

---

## Phase 2 — Bounded memory (v1.2)

### 2.1 History summary hard budget (`brain/memory.py`)

**Problem.** Line 37 grows `history_summary` by concatenation forever, and it
is injected into the system prompt every decision (`brain/prompts.py` lines
24–27). With llama.cpp at `-c 8192` this is the first thing that explodes.

**Required behavior.**

- Cap each event string at 200 chars in `add_event` (truncate with `…`).
- After extending `history_summary`: if `len > 1200`, call a new
  `planner.compress_history(text)` which must return ≤ 600 chars. On any
  exception or an overlong reply, hard-truncate to the final 1200 chars.
- `LLMPlanner.compress_history`: one LLM call — "Rewrite this Minecraft agent
  history in under 600 characters. Keep goals achieved, important places, and
  unresolved problems." `MockPolicy.compress_history`: return the last 600
  chars.

**Tests:** budget trigger, fallback truncation, event-length cap.

### 2.2 Slim JSONL logging + rotation (`brain/main.py`)

- Replace the logged `llm_raw_response` with a slim dict:
  `{"content", "tool_calls", "usage"}` extracted from the response — drop
  llama.cpp `timings`, fingerprints, and null fields. Mock responses are
  already small; log them as-is.
- On brain startup, gzip all pre-existing `logs/episode_*.jsonl`, keep the
  newest 20 archives, delete older ones. Implement as a pure function with a
  test (tmp-path based).

### 2.3 Long-term store + restart persistence

New `brain/longterm.py`, backed by `state/longterm.json` (add `state/` to
`.gitignore`).

- Record shape: `{id, type: place|fact|achievement|death, key, value,
  pos: [x,y,z]|null, importance: 1-5, created_ts, last_used_ts}`.
- Hard cap 200 records; evict lowest `(importance, last_used_ts)` first.
- API: `upsert(record)` (same `type`+`key` replaces),
  `retrieve(position, goal_text, k=5)`. Scoring: places by
  `importance / (1 + distance/100)`; non-places by keyword overlap between
  `key`+`value` and `goal_text`, tie-broken by recency. Update `last_used_ts`
  on retrieval. Atomic writes (temp file + rename).
- Wire-ins now: `maybe_pin_shelter` also upserts a `place` record
  (importance 5); `death` events upsert a `death` record with position
  (importance 4). Achievements arrive in Phase 3.
- Prompt injection: add an optional `longterm: list[str] | None` field to
  `MemorySnapshot` (`brain/models.py`) and the `memory` object in
  `schemas/observation.schema.json` (optional, so the bot's own built
  observation stays valid without it). The brain fills it with the top-k
  formatted as short strings, e.g. `place shelter [82,71,248]`.
- Restart persistence: atomically write `state/brain_state.json`
  (`{goal, pinned, history_summary}`) whenever they change; load on startup
  if present.

**Tests:** eviction order, place-proximity retrieval, persistence round-trip,
atomic write survives a simulated crash (write temp, no rename → old file
intact).

**Phase 2 gate:** standard verification plus new tests. If runnable: start a
mock episode, kill the brain, restart, confirm goal/pinned reload. Append a
log entry.

---

## Phase 3 — Progression scaffold (v2.0)

### 3.1 Prompt refactor (`brain/prompts.py`)

- `SYSTEM_PROMPT` becomes role + hard safety rules only. Delete the
  "Standing objective: Survive..." line — it currently overrules `set_goal`
  on every call.
- `build_user_prompt(observation, goal, stage, next_milestone, hint)` puts
  these lines *before* the observation JSON:

  ```
  Current goal: <goal>
  Progression stage: <stage> — next milestone: <next_milestone> (<hint>)
  ```

- The compressed history summary stays in the system prompt as today.

### 3.2 Curriculum module (new `brain/curriculum.py`)

Ordered milestones, each `{name, predicate(observation) -> bool, hint}`:

1. `first_wood` — any inventory item ending `_log` ≥ 1 — "gather logs"
2. `wooden_pickaxe` — ≥ 1
3. `stone_tools` — `stone_pickaxe` ≥ 1
4. `sheltered` — `"shelter"` key present in `memory.pinned`
5. `furnace_and_fuel` — furnace in inventory or pinned, and coal or charcoal ≥ 1
6. `iron_ingot` — ≥ 1
7. `iron_gear` — `iron_pickaxe` ≥ 1 and `iron_sword` ≥ 1
8. `food_buffer` — total food items ≥ 8 (define a small food-name list)

Stage = name of the first unmet milestone. On first detection of a milestone
becoming satisfied: append a `milestone reached: <name>` event to memory and
upsert a long-term `achievement` record (importance 4).

**Tests:** predicates and stage transitions from synthetic observations.

### 3.3 New `equip` tool (bot)

Iron gear is pointless if nothing can wear it — armor slots are observed but
nothing equips them.

- Tool `equip` with args `{item: string}`: armor pieces go to the correct
  armor destination (`head`/`torso`/`legs`/`feet` via `bot.equip`), everything
  else to `hand`. Fails with a clear detail when the item is not in inventory.
- Add to `schemas/tools.schema.json`, `toolRegistry`
  (`bot/src/tools/index.ts`), and document in the README protocol section.
  Default 60s timeout is fine.

### 3.4 Align eval metrics with the curriculum

Extend `metrics()` in `eval/run_episode.py` with the ladder milestones
(keep the existing keys so old logs remain comparable).

**Phase 3 gate:** full verification; a live episode if feasible. Append a
final log entry summarizing all three phases, outcomes, and anything
surprising.

---

## Acceptance summary

| Phase | You are done when |
|---|---|
| 1 | Builds/tests green; interrupt matrix unit-tested; live sunset `build_shelter` no longer thrashes (if runnable) |
| 2 | Prompt size provably bounded (tests); logs slimmed + rotated; long-term store capped at 200 with retrieval; brain restart resumes state |
| 3 | Stage/goal injected into prompt; milestones detected and recorded; `equip` works; eval reports ladder milestones |
