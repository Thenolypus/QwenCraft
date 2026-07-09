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
- Every LLM decision is logged as a training-ready record (prompt components,
  completion, tool result, outcome — see v2.2) so an SFT corpus accumulates as
  a side effect of every run. Store components, not rendered prompt text, to
  keep the v1.2 slim-log guarantees.
- All LLM calls are stateless and role-scoped: each role (actor, critic, slow
  planner) has its own fixed system prompt, and any memory lives in our stores,
  never in the server. llama-server holds no conversation state between calls;
  only its prompt cache is affected by prompt swaps (mitigate with `-np` slots,
  see v3).
- Unchanged v1 non-goals: no RL, no screenshots, no web UI. Vision input
  (Optimus-3's lane) stays out of scope; the text observation schema is the
  chosen interface.

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

## v2.2 — Training-ready decision records

Independent of v2.1 — start immediately: every run before this ships is lost
training data.

- Each decision appends one JSONL record: prompt components (observation,
  goal, stage, hint, history summary, prompt-builder version), the raw
  completion, the validated tool call, and — filled in after execution — the
  tool result and any interrupt that ended it.
- Components must be sufficient to re-render the exact prompt text offline;
  no full prompt text in the log.
- An episode footer record captures outcome labels (milestones reached,
  deaths, nights survived) for trajectory filtering later.

**Done when:** a script converts one episode's records into chat-format SFT
examples (system/user/assistant + tool call) with success/failure labels.

## v2.3 — Compositional skill layer (ported from Odyssey)

Odyssey's key portable trick (MIT, cloned at `~/Projects/Odyssey/`,
`MC-Comprehensive-Skill-Library/`): a recursive `obtainItem` resolver that
turns "get X" into the full mine/craft/smelt/kill prerequisite chain in
deterministic code. Today the 9B plans that chain itself across many
decisions; each one is a parse/interrupt risk and a token cost.

- New bot tool `obtain_item(item, count)`: resolve prerequisites recursively,
  reusing the existing `craft`/`smelt`/`mine_block`/`attack` implementations
  as steps.
- Recipes and tool tiers come from mineflayer's minecraft-data for 1.21 at
  runtime (Odyssey's `pre_item`/`pre_tool` JSONs are stale 1.19 copies of the
  same facts — do not vendor them).
- Vendor only the knowledge minecraft-data lacks, filtered to 1.21 names,
  with attribution: `func.json` (which method obtains an item at all),
  `pre_collect.json` (mob drops and special collection), `map_name.json`
  (ore→drop and item-family mapping), and `pre_smelt.json` (furnace recipes —
  verified 2026-07-06 that minecraft-data 1.21.11 ships no smelting data,
  correcting the earlier assumption here).
- Guardrails Odyssey lacks: recursion depth cap and per-item attempt cap (its
  `while(!res)` loop never gives up), abort checks between steps (the v1.1
  interrupt matrix applies mid-chain), and partial-progress reporting like
  `mine_block` ("obtained 3/5, stuck at iron_ore: need stone_pickaxe").
- Per-step tools stay available; the prompt steers toward `obtain_item` once
  the stage is past first_wood.

**Done when:** `obtain_item stone_pickaxe` from bare fists completes
unattended in one LLM decision, and a mid-chain interrupt aborts cleanly with
partial progress reported.

## v2.4 — Failure critic and split memory

- DEPS-style failure explanation: when a tool fails (not interrupted), one
  extra LLM call with a dedicated critic prompt — what failed, why, one
  corrective lesson. The explanation is injected into the next decision
  prompt; the lesson goes to long-term memory.
- Split the long-term store per Optimus-1: knowledge (stable facts: recipe
  chains learned, mob behavior) vs experience (episodic: places, deaths,
  successful sequences). Retrieval stays top-k; each kind gets its own cap
  and eviction.
- Critic verdicts also label the v2.2 decision records (success/failure/
  lesson), improving SFT filtering for free.

**Done when:** a failed craft shows a critic explanation in the next prompt,
and the same failure stops recurring within an episode.

## v3 — Growth

- Two-speed planning becomes explicit roles with fixed prompts: a slow
  planner call (goal review + short plan sketch) every N minutes or on
  milestone/death events; the fast per-decision actor call follows the
  sketch. Run llama-server with `-np 2/3` and a proportionally larger `-c`
  so each role keeps its own warm prompt-cache slot.
- Plan retrieval (JARVIS-1): successful plan sketches stored with their
  situation (stage, biome, goal) and retrieved as few-shot context when a
  similar situation recurs.
- Plan-while-acting (Parallelized Planning-Acting paper): a single-slot
  action buffer — while a long tool runs, the planner may prepare the next
  call; priority events still interrupt. Adopt the buffer pattern, drop the
  multi-agent parts.
- Skill library: successful multi-step sequences get named and become callable
  macros (Voyager-style), layered on top of `obtain_item`.
- Self-proposed goals (including free building — "whatever beauties it decides
  to build"), validated against the curriculum state.
- Death post-mortems written into experience memory.

**Done when:** a 12-hour unattended run ends with a stocked base, sustainable
food, and at least one self-proposed build completed.

## v4 — SFT the brain

Turn accumulated decision records into a fine-tuned Qwen that natively acts
the way the prompt currently coaxes it to. Coarse plan; firms up as v2.2 data
accumulates:

- Own-trajectory SFT (LLaMA-Rider pattern): filter v2.2 records to
  successful, critic-approved decisions; train prompt → tool call.
- Knowledge injection (Odyssey MineMA pattern): adapt their dataset-generation
  and fine-tuning scripts (LLaMA→Qwen). Their training data is text QA
  generated from the Minecraft wiki — unlike Optimus's video-embedding
  datasets, it ports directly to a text-only agent.
- Mindcraft's Andy models are the existence proof that SFT works at this
  model scale.
- Open questions to resolve first: required data volume, dedup/cleaning
  pipeline, and an eval that proves the SFT beats the prompted baseline.

**Done when:** a fine-tuned Qwen matches or beats the prompted baseline on
the eval ladder with a materially shorter system prompt.

## Eval ladder

- Headline: nights survived unattended + curriculum milestones reached.
- Odyssey-style dynamic-immediate planning tasks (sudden threat → correct
  reaction) for reactive quality.
- A few MCU tasks for comparability with the literature.

## Component → paper map (2026-07-06 brainstorm)

| Component | Source |
|---|---|
| Compositional skills / `obtain_item` | Odyssey skill library |
| Failure explanation before replanning | DEPS |
| Knowledge vs experience memory | Optimus-1 |
| Plan retrieval by situation | JARVIS-1 |
| Action buffer, plan-while-acting | Parallelized Planning-Acting |
| Own-trajectory SFT | LLaMA-Rider |
| Knowledge-injection SFT scripts | Odyssey (MineMA) |
| Small-model SFT existence proof | Mindcraft (Andy) |
| Future `do(goal_text)` low-level policy | STEVE-1 / Optimus-2 (slot reserved, not planned) |

## Implementation handoff

v1.1, v1.2, and v2.0 are specified in detail in `doc/handoff-gpt55.md` as a
three-phase implementation prompt with verification gates (all three phases
implemented as of 2026-07-05). v2.2–v2.4 are the next candidates for the same
treatment.
