# QwenCraft v2 — Handoff for GPT-5.6

You are implementing a fresh restart of QwenCraft. The previous iteration (v1)
was deleted from the working tree on 2026-07-18 but is fully recoverable at git
commit `HEAD` (`c502706`, "Planned for deletion for a new start"). Read this
document fully before writing code. Follow the repo conventions in `CLAUDE.md`
(uv environment, append-only `doc/log.md` entries).

## 1. Mission

Build a Minecraft agent driven by a **local Qwen 3.5 9B** (OpenAI-compatible
endpoint via llama.cpp or vLLM) that plays like a human: survives, hunts,
mines, builds structures, and explores to obtain what it needs. Sustained
autonomous survival is the primary goal. Beating the ender dragon is a stretch
goal, not a requirement. The architecture must make adding new skills (e.g.
responding to chat commands) nearly effortless — a drop-in module, in the way
Claude Code skills are drop-in folders.

## 2. Why v1 died — post-mortem (read before designing anything)

v1 lives at `git show c502706:<path>`. Its `doc/log.md` (18 entries) records
the failure pattern. Recover it with `git show c502706:doc/log.md`. Summary:

1. **Mineflayer-side OOM crashes.** `mineflayer-pathfinder` and
   `mineflayer-collectblock` repeatedly blew the Node heap to 4GB. Fixes
   (heap watchdog, adaptive search radius, heap budgets) were reactive
   patches, applied per-tool, and kept missing paths (the collectblock OOM
   was found *after* the mine_block one was "fixed").
2. **Interrupt storms.** Night hostiles generated event floods → the brain
   thrashed between flee/fight decisions → death loop → OOM.
3. **LLM in the hot loop.** The LLM dispatched exactly one tool per decision.
   A 9B model re-deciding after every tool result got lost, looped, and any
   single bad decision stalled the whole agent.
4. **Scope explosion.** Within two days of the first stabilization pass, work
   expanded to an Odyssey port, a critic agent, records for future SFT, and
   multi-agent orchestration — before the bot could reliably survive a night.

Design consequences, non-negotiable for v2:

- Crash-resilience is **architecture**, not patches: supervisor with
  auto-restart, hard caps and watchdogs from day one, reconnect-and-resume
  protocol. Assume the bot process *will* die; make recovery boring.
- The LLM decides **goals**, not steps. Everything between goal decisions is
  deterministic code.
- Events are coalesced and severity-ranked at the source; the brain consumes
  a digest, never a firehose.
- Strict milestone gates (Section 8). Do not start milestone N+1 until N's
  acceptance test passes. No critic, no SFT, no multi-agent, no vision in v2.

## 3. Architecture: four layers

```
┌─────────────────────────────────────────────────────────────┐
│ L3  DIRECTOR   (Python + Qwen 3.5 9B)                       │
│     Picks/updates goals, reacts to event digests, chats.    │
│     Called only at decision boundaries. Small toolset.      │
├─────────────────────────────────────────────────────────────┤
│ L2  EXECUTOR   (Python, deterministic)                      │
│     Skill registry (drop-in folders) + dependency resolver  │
│     (Odyssey tables) + goal tree + retries/timeouts/        │
│     escalation. Turns "obtain iron_pickaxe" into a verb     │
│     sequence without the LLM.                               │
├─────────────────────────────────────────────────────────────┤
│ L1  VERBS      (TypeScript Mineflayer sidecar, WebSocket)   │
│     ~15 fixed low-level actions: goto, dig, place, craft,   │
│     smelt, attack, equip, consume, sleep, find_blocks,      │
│     find_entities, collect_drops, use_container, chat,      │
│     stop. Hardened once, rarely changed.                    │
├─────────────────────────────────────────────────────────────┤
│ L0  REFLEXES   (TS, mineflayer plugins)                     │
│     auto-eat, shield/critical-flee trigger, fall/lava       │
│     avoidance via pathfinder config. Never involves LLM.    │
└─────────────────────────────────────────────────────────────┘
```

The key change vs v1: v1 implemented fat tools (`obtain_item`, `build_shelter`,
crop logic…) in TypeScript and let the LLM call them one at a time. v2 keeps
TypeScript **minimal and frozen** (the part that OOM'd gets small and hardened
once) and moves all composition into Python skills, which are unit-testable
against a fake verb layer and trivially addable.

### L1 Verb contract

Every verb: JSON-schema-validated args, hard timeout, cancellable by `stop`,
returns `{status: "success" | "failure", detail, data}` — never throws across
the wire, never retries silently (v1's "Deliberate v1 Choices" got this right;
keep it). Bounded search radius defaults. Bot binds WebSocket to 127.0.0.1.

Node hardening (from v1 lessons, apply globally not per-tool):
- Run bot with `--max-old-space-size=2048`; a heap watchdog aborts the
  *current verb* (structured failure) at a soft threshold and process-exits at
  a hard threshold, trusting the supervisor to restart.
- One global pathfinder movements config with conservative limits.
- Event coalescing at the source: events have `severity` (info/warn/danger),
  are deduplicated per type within a window, and `danger` events interrupt
  the current verb by design rather than racing it.

### L2 Executor

- **Dependency resolver**: given `obtain(item, count)` + current inventory,
  compute the full prerequisite tree (tool tiers, crafting table/furnace,
  fuel, inputs) from the data tables (Section 5) and emit an ordered verb/skill
  plan. Pure function, fully unit-tested offline. This is v1's
  `obtain_item.ts` logic (`git show c502706:bot/src/tools/obtain_item.ts`)
  reborn in Python where it can be tested without a server.
- **Goal tree**: persistent JSON (goal nodes: id, title, status, parent,
  reason, created-by). The director edits the tree; the executor works the
  frontier: picks the next actionable leaf, runs the mapped skill, records
  the result. Survival maintenance (food, night shelter, torching) is a
  standing background goal the executor schedules without asking the LLM.
- **Escalation policy**: skill failure → bounded retry with variation →
  mark goal blocked with a structured reason → *then* wake the director.
  A watchdog detects no-progress (same goal, N failures or T minutes) and
  forces a safe-mode skill (return to base / hole up / sleep) instead of
  letting the agent thrash. This replaces v1's loop-breaker patches.

### L3 Director (the only LLM consumer)

- Called on: goal completion/blocked, danger digest, idle heartbeat, chat
  message addressed to the bot. NOT after every verb.
- Toolset stays under ~10 tools: `set_goal`, `complete_goal`, `abandon_goal`,
  `run_skill(name, args)`, `lookup(query)` (resolver/wiki query — answers
  "what do I need for X" deterministically), `note`, `chat`, `idle`.
  Skills are surfaced as a name+description list in the prompt, invoked via
  `run_skill` — the LLM never sees 180 tool schemas. If the skill list grows
  past ~25, add embedding retrieval of top-k relevant skills (Odyssey-style);
  do not build retrieval before that.
- Prompt budget < ~4k tokens: compact observation (v1's observation format
  was good — salvage it), goal tree summary (not full tree), last-k results,
  event digest.
- **Constrained decoding**: use llama.cpp `--jinja` native tool calls or
  vLLM guided decoding so tool-call JSON is grammatically forced. A 9B model
  must not be trusted to format JSON freely. Validate args with jsonschema
  and return validation errors as tool results (one repair round, then fall
  back to `idle`).

## 4. Skill system (the modularity requirement)

A skill is a folder under `skills/`:

```
skills/
  hunt_food/
    skill.yaml        # manifest
    skill.py          # async def run(ctx, args) -> SkillResult
    test_hunt_food.py # unit test against FakeVerbs
```

`skill.yaml`:

```yaml
name: hunt_food
description: >     # shown to the director LLM verbatim — write it for the LLM
  Hunt nearby animals and cook the meat. Use when food supply is low.
args:              # JSON schema for run_skill args
  type: object
  properties:
    target_saturation: {type: integer, default: 20}
preconditions:     # checked by executor before dispatch; structured failure if unmet
  - has_item: {item: "_sword", any_tier: true}   # optional
success:           # machine-checkable postcondition for the executor
  - food_level_gte: 18
timeout_s: 300
danger_interruptible: true
```

`ctx` gives skills: `ctx.verbs.*` (typed L1 verb calls), `ctx.resolve(item,
count)` (the resolver), `ctx.obs()` (latest observation), `ctx.data` (game
data tables), `ctx.log`. Registry auto-discovers folders, validates manifests
at startup, and generates the director-facing skill list. **Adding a skill
must require zero changes outside its folder.** Enforce with a registry test.

Initial skill set (v2.0): `obtain` (thin wrapper over resolver), `hunt_food`,
`gather_food_plants`, `shelter` (dig-in or blueprint hut before nightfall),
`sleep_safely`, `explore` (directional, bounded), `deposit_loot` (base chest),
`build_structure` (blueprint-driven, below), `return_to_base`, `safe_mode`.
v2.1+: `respond_to_chat` command parsing, `farm` (crops), `mine_branch`
(systematic iron/diamond), `tame`/`breed`.

### Building like a human

Voyager/Odyssey never made aesthetic building work; scripted blueprints will.
`data/blueprints/*.json`: named block layouts (layer matrices + palette +
anchor rule). `build_structure` resolves the material bill via `ctx.resolve`,
acquires, clears the site, places layer by layer. Ship 2–3 blueprints
(starter cabin, storage hut, watchtower). The director chooses *which* and
*where*; deterministic code does the rest. LLM-generated blueprints are a
future experiment, not v2.0.

## 5. Game data (the "wiki binary")

Copy from the local Odyssey checkout
(`/home/seant/Projects/Odyssey/MC-Comprehensive-Skill-Library/json/`) into
`data/mc/`:

- `func.json` — 788 items → acquisition method (craft/smelt/mine/kill/collect)
- `pre_item.json` — 630 recipes: inputs, yield, needs-crafting-table flag
- `pre_tool.json` — 92 block → required tool tier
- `pre_collect.json`, `pre_smelt.json`, `map_name.json` — source mappings

Caveat: Odyssey targeted MC ~1.19; v2 pins 1.21.x. Validate/regenerate
against `minecraft-data` (prismarine) for the pinned version — it ships
authoritative `recipes.json`/`items.json`, so `pre_item.json` can be
regenerated programmatically; keep the Odyssey files as the seed and write a
`scripts/validate_data.py` that diffs them against minecraft-data and reports
drift. The resolver reads only `data/mc/`, so fixing data never touches code.

Also salvageable from the Odyssey checkout: primitive skill JS in
`Odyssey/skill_library/skill/primitive/` and
`MC-Comprehensive-Skill-Library/skill/*.js` as *reference implementations*
when writing verbs/skills (patterns for exploreUntil, killMob, placement).
Do NOT port their Python agent stack (langchain/Chroma, MineMA, multi-agent).

## 6. Repository layout

```
QwenCraft/
├── bot/                      # L0+L1 TypeScript sidecar (npm, Node 22+)
│   ├── src/
│   │   ├── index.ts          # WS server, lifecycle, heap watchdog
│   │   ├── verbs/            # one file per verb
│   │   ├── reflexes.ts       # L0 plugin config + event coalescing
│   │   └── observation.ts    # compact observation builder (salvage v1)
│   └── test/
├── brain/                    # L2+L3 Python (uv)
│   ├── main.py               # supervisor: owns bot process, restarts, runs loop
│   ├── director/             # LLM client, prompts, tool schemas, decision loop
│   ├── executor/             # goal tree, resolver, skill dispatch, watchdogs
│   ├── verbs.py              # typed client stubs for L1 + FakeVerbs for tests
│   └── tests/
├── skills/                   # drop-in skill folders (Section 4)
├── data/
│   ├── mc/                   # game data tables (Section 5)
│   └── blueprints/
├── eval/
│   └── run_episode.py        # milestone harness (salvage v1's shape)
├── doc/                      # log.md (append-only), this handoff
├── config.yaml               # single config: server, WS, LLM, budgets
└── docker-compose.yml        # itzg/minecraft-server, pinned version
```

Salvage from v1 (`git show c502706:<path>`) rather than rewriting: WebSocket
protocol envelope (README §Protocol), `observation.ts` compaction and block
whitelist wildcards, `config.yaml` shape, episode JSONL logging + gzip
rotation, docker-compose, and test patterns in `bot/test/` and
`brain/tests/`. Cherry-pick logic, not files — v1 files carry the fat-tool
architecture you are replacing.

Keep the version pin policy from v1's README (MC 1.21.x ↔ mineflayer tested
list ↔ Node 22+), re-verifying current mineflayer at implementation time.

## 7. Process & supervision model

Three processes, one owner: `brain/main.py` is the supervisor. It spawns/
monitors the bot (Node) process, restarts it with backoff on exit, and
re-syncs state on reconnect (bot is stateless across restarts except MC world
state; brain re-sends nothing, just re-observes). The Minecraft server runs
in Docker, independent. The LLM server (llama.cpp/vLLM) is external and its
unavailability must degrade to executor-only survival (standing goals keep
running; director calls queue/skip).

Brain state (`state/`): goal tree, base location, notes, deaths. Persist on
every mutation; load on start. Death is an event, not a crash: respawn →
safe-mode → director decides recovery.

## 8. Milestones — gates, not phases

Each has an executable acceptance check in `eval/`. Do not proceed past a
gate that doesn't pass. Log each gate result in `doc/log.md`.

- **M0 — Harness stability.** Bot + verbs + supervisor, no LLM, no skills.
  Acceptance: scripted verb loop (goto/dig/craft/place cycles) runs 4+ hours
  against the Docker server with zero unhandled crashes; `kill -9` on the bot
  mid-`goto` recovers within 30s and the loop continues; heap stays under cap.
- **M1 — Deterministic survival.** Resolver + core skills, scripted director
  (no LLM): spawn → wood → tools → shelter → food → survive 3 nights →
  stone tools. Acceptance: 3 consecutive seeded runs pass via
  `eval/run_episode.py`. This harness is the permanent regression suite.
- **M2 — LLM director.** Qwen 3.5 9B replaces the script. Acceptance: on 3
  seeds, survives 3 nights and reaches iron tools with zero human input;
  no thrash-loop (watchdog fires < 2 times/run); decision latency and token
  budgets logged.
- **M3 — Human-likeness.** Blueprint house built near base, chest logistics,
  crop farm, `respond_to_chat` skill (follow/come/status/build commands).
  Acceptance: scripted chat session transcript + house materializes correctly
  from a fresh run.
- **M4 — Stretch (only after M3).** Nether prep, enchanting, dragon roadmap;
  optional vision channel (see below). Define acceptance when you get there.

## 9. Explicit non-goals for v2.0–2.3

No critic/self-reflection agent, no SFT/LoRA data pipeline, no multi-agent,
no curriculum learning, no vision, no web UI. Leave seams: the episode JSONL
already captures trajectories (future SFT), the observation builder is an
interface (future VLM screenshot provider via prismarine-viewer — an *extra
observation for choices like build sites*, never a control channel; VPT-style
visual control à la Optimus-3/JARVIS-VLA is a different tech tree requiring
training compute we don't have).

## 10. Risks & watchpoints

- **Qwen 3.5 9B planning ceiling** is the reason L2 exists. If M2 shows the
  director still thrashing, first response is to shrink its decision space
  (fewer tools, more standing goals in the executor), not to add LLM calls.
- **Odyssey data drift** (1.19→1.21 item names): validation script in §5.
- **Pathfinder OOM class**: if it resurfaces despite caps, cap `goto`
  distance and chain hops in the executor rather than raising heap.
- **Context growth**: log token usage per call from day one; the 4k budget is
  a gate metric in M2, not an aspiration.

## 11. First session checklist

1. Commit the pending v1 deletion as its own commit (working tree currently
   has ~80 staged/unstaged deletions; keep `README.md`,
   `pyproject.toml`, `uv.lock`, `LICENSE`, `CLAUDE.md`, `AGENTS.md`,
   `.gitignore`, `logs/.gitkeep`).
2. Rewrite `README.md` for the v2 architecture (much of §Prerequisites/
   §Quickstart/§Version Pin survives).
3. Copy + validate data tables (§5).
4. Scaffold repo layout (§6), M0 first. Append a `doc/log.md` entry per
   meaningful step, per repo conventions.
