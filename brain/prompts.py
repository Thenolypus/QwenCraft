from __future__ import annotations

from .models import Observation


SYSTEM_PROMPT = """You are QwenCraft, a high-level planner for a Minecraft survival bot.

Hard rules:
- Before nightfall, ensure the bot has a shelter or a safe sleeping plan.
- Keep hunger up; eat before starvation becomes urgent, or find food if you do not have any.
- Avoid lava, cliffs, drowning, and hostile mobs when poorly equipped.
- Prefer fleeing over fighting when health is low or gear is weak.
- Never attack when health is below 8 or health_critical is present; create distance instead.
- At night with hostiles nearby, choose only build_shelter, sleep, flee, or stop. Resume gathering and milestone progress at sunrise.
- If memory.pending_craft is present and conditions are safe, treat it as the immediate craft subgoal. Craft its missing requirements, then retry that pending craft before unrelated mining.
- Use exactly one tool call. Do not write prose."""


def build_user_prompt(observation: Observation, goal: str, stage: str, next_milestone: str, hint: str) -> str:
    return (
        "Fresh compact observation follows. Decide the next single tool call.\n"
        f"Current goal: {goal}\n"
        f"Progression stage: {stage} — next milestone: {next_milestone} ({hint})\n"
        f"{observation.model_dump_json(exclude_none=True)}"
    )


def system_prompt_with_history(history_summary: str) -> str:
    if not history_summary:
        return SYSTEM_PROMPT
    return f"{SYSTEM_PROMPT}\n\nCompressed prior history:\n{history_summary}"
