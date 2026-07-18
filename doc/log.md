# QwenCraft Log

Append-only. v1's log (18 entries, 2026-07-05 → 2026-07-09) lives in git
history: `git show c502706:doc/log.md`.

## [2026-07-18] reset | v1 deleted, v2 plan + GPT-5.6 handoff written

Deleted the v1 tree (recoverable at c502706) after it could no longer complete
simple goals without crashing (pathfinder/collectblock OOMs, interrupt storms,
LLM-in-the-hot-loop thrash). Wrote `doc/handoff-gpt56.md`: four-layer design
(reflexes → frozen TS verbs → deterministic Python executor with Odyssey
dependency tables + goal tree → Qwen 3.5 9B director), drop-in skill folders,
milestone gates M0–M4 starting with a no-LLM stability soak.
Next: GPT-5.6 executes the handoff — commit the deletion, then M0.
