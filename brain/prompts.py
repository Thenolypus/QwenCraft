from __future__ import annotations

import json

from .models import Observation, ToolCall, ToolResult


SYSTEM_PROMPT = """You are QwenCraft, a high-level planner for a Minecraft survival bot.

Hard rules:
- Before nightfall, ensure the bot has a shelter or a safe sleeping plan.
- Keep hunger up; eat before starvation becomes urgent, or find food if you do not have any.
- Avoid lava, cliffs, drowning, and hostile mobs when poorly equipped.
- Prefer fleeing over fighting when health is low or gear is weak.
- Never attack when health is below 8 or health_critical is present; create distance instead.
- At night with hostiles nearby, choose only build_shelter, sleep, flee, or stop. Resume gathering and milestone progress at sunrise.
- If memory.pending_craft is present and conditions are safe, treat it as the immediate craft subgoal. Craft its missing requirements, then retry that pending craft before unrelated mining.
- When acquiring an item that has prerequisites (tools, materials, smelting), prefer a single obtain_item call over manually chaining mine_block/craft/smelt yourself.
- Use exactly one tool call. Do not write prose."""


def build_user_prompt(observation: Observation, goal: str, stage: str, next_milestone: str, hint: str) -> str:
    return (
        "Fresh compact observation follows. Decide the next single tool call.\n"
        f"Current goal: {goal}\n"
        f"Progression stage: {stage} — next milestone: {next_milestone} ({hint})\n"
        f"{observation.model_dump_json(exclude_none=True)}"
    )


def prompt_extras(notice: str | None, blocked_messages: list[str]) -> list[str]:
    """Transient per-decision prompt lines: the critic notice (if any) followed
    by loop-breaker BLOCKED lines. Shared by decide() and the SFT exporter so
    recorded components re-render the exact prompt text."""
    return [line for line in (notice, *blocked_messages) if line]


def apply_prompt_extras(user_prompt: str, extras: list[str]) -> str:
    if not extras:
        return user_prompt
    return f"{user_prompt}\n\n" + "\n".join(extras)


def system_prompt_with_history(history_summary: str) -> str:
    if not history_summary:
        return SYSTEM_PROMPT
    return f"{SYSTEM_PROMPT}\n\nCompressed prior history:\n{history_summary}"


CRITIC_SYSTEM_PROMPT = """You are a terse failure critic for a Minecraft survival bot.
You are shown one failed tool call and the situation around it. Reply with exactly
three short lines and no other prose:
VERDICT: a one-to-three word label for the failure
WHY: your best-guess reason, under 20 words
LESSON: one corrective sentence the planner should remember next time"""


def build_critic_prompt(observation: Observation, goal: str, tool_call: ToolCall, result: ToolResult) -> str:
    return (
        f"Goal: {goal}\n"
        f"Attempted call: {tool_call.tool}({json.dumps(tool_call.args, ensure_ascii=True)})\n"
        f"Failure detail: {result.detail}\n"
        f"Observation: {observation.model_dump_json(exclude_none=True)}"
    )
