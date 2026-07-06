# QwenCraft Goals and Version Milestones

End goal: a local Qwen model that *plays* Minecraft, not just survives it.
Progression arc: start → survive → mine → gear up → upgrade → build a base
(or whatever it decides to build) → hunt → become sustainable. Memory must
stay hard-capped at every tier no matter how long the bot runs.

## Standing design principles

- The LLM is only called at decision boundaries; the prompt stays compact and
  fixed-size forever. Growth happens in a disk-capped long-term store, and the
  prompt only ever receives top-k retrieved entries from it.
- Every memory tier has a hard cap: working set (goal, 10 pinned, 15 events),
  rolling history summary (character budget with re-compression), long-term
  store (record cap with importance + recency eviction), JSONL logs (slimmed +
  rotated).
- The curriculum ladder gives direction; the LLM still chooses every action.
- **Unlimited exploration is intended** (decision 2026-07-05): no world border.
  The bot may roam as far as it wants to find its optimal home. World disk
  growth is accepted.
- Unchanged v1 non-goals: no RL, no screenshots, no web UI.

## v1.1 — Stabilize

Fix the correctness bugs found in the 2026-07-05 review. Headliners:

- Interrupt policy matrix: events must not abort the tool that handles them
  (`night_falling` vs `build_shelter`, `hostile_close` vs `attack`/`flee`,
  `damage_taken` vs `attack`). Edge-triggered, per-tool rules.
- WebSocket server bound to 127.0.0.1 (currently listens on all interfaces).
- One shared hostile-mob definition (currently three inconsistent ones).
- `mine_block` reports partial progress and tries next-nearest candidates
  instead of failing the whole call.
- Honest observations: `light` and `biome` currently report `0`/`""`.
- Parse/retry fixes in the brain LLM path; eval metric nits.

**Done when:** builds/tests pass; a live sunset run completes `build_shelter`
without interrupt thrash; combat/flee run to completion.

## v1.2 — Bounded memory

- History summary hard budget: re-compress via the LLM when it exceeds
  ~1200 chars; per-event cap of 200 chars. This is the only truly unbounded
  memory in v1 and it lives inside every prompt.
- Slim JSONL logging (message + tool call + usage only, no llama.cpp timings)
  plus rotation: gzip finished episodes, keep newest 20.
- Long-term store (`state/longterm.json`): places, achievements, deaths,
  facts. Capped at 200 records, importance + recency eviction, top-k retrieval
  into the prompt by proximity/goal relevance.
- Brain state persists across restarts (goal, pinned, history summary).

**Done when:** a multi-hour run shows flat prompt token counts; killing and
restarting the brain resumes with prior goal/places intact.

## v2.0 — Progression scaffold

- System prompt becomes role + rules only; the current goal from memory is
  injected prominently (today the hardcoded "survive" objective overrules
  `set_goal`).
- Curriculum ladder checked programmatically from observations, injected into
  the prompt as "stage / next milestone / hint":
  1. first_wood — any `*_log` in inventory
  2. wooden_pickaxe
  3. stone_tools — stone pickaxe
  4. sheltered — shelter pinned in memory
  5. furnace_and_fuel — furnace + coal/charcoal
  6. iron_ingot
  7. iron_gear — iron pickaxe + iron sword
  8. food_buffer — ≥ 8 food items held
- Milestones reached are recorded as long-term achievements.
- New `equip` tool (armor + held item) so iron gear actually matters.
- Eval metrics aligned with the ladder.

**Done when:** an unattended episode reaches iron gear and survives 3 nights.

## v2.1 — Sustainability tools

Added stage-by-stage as the curriculum unlocks them, to keep the tool list
small for the 9B model:

- `use_chest` (deposit/withdraw) — storage at the base.
- Farming: till / plant / harvest.
- Animal handling: breed; hunting stays covered by `attack`.
- Torch-line lighting around the base (via existing `place_block`).

**Done when:** the bot maintains a net-positive food supply from farming or
breeding without prompting.

## v3 — Growth

- Skill library: successful multi-step sequences get named and become callable
  macros (Voyager-style), reducing decisions-per-goal.
- Two-speed planning: a slow "goal review" call every N minutes / on milestone
  events; fast per-action decisions in between.
- Self-proposed goals (including free building — "whatever beauties it decides
  to build"), validated against the curriculum state.
- Death post-mortems written into long-term memory.

**Done when:** a 12-hour unattended run ends with a stocked base, sustainable
food, and at least one self-proposed build completed.

## Implementation handoff

v1.1, v1.2, and v2.0 are specified in detail in `doc/handoff-gpt55.md` as a
three-phase implementation prompt with verification gates.
