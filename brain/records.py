from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import prompts
from .models import ToolCall, ToolResult

# Bump when the record shape changes so the exporter can branch on old logs.
# v2: added the optional "critic" field (verdict/explanation/lesson from the
# v2.4 failure critic) and components.extras (transient critic/BLOCKED prompt
# lines appended to the user prompt); both additive, absent on older records.
RECORD_SCHEMA_VERSION = 2


def prompt_fingerprint() -> str:
    """Sha1 of the frozen system prompt text.

    prompts.py is owned by another pass this round, so we cannot stamp a
    version constant into it; hashing its content gives records a stable
    pointer back to the exact prompt-builder behavior that produced them.
    """
    return hashlib.sha1(prompts.SYSTEM_PROMPT.encode("utf8")).hexdigest()


@dataclass
class PromptComponents:
    """Everything build_user_prompt/system_prompt_with_history need to
    re-render the exact prompt text offline, captured at decide()-time."""

    observation: dict[str, Any]
    goal: str
    stage: str
    next_milestone: str
    hint: str
    history_summary: str
    # Transient lines (critic notice, BLOCKED bans) appended to the user prompt
    # via prompts.apply_prompt_extras for this one decision.
    extras: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "observation": self.observation,
            "goal": self.goal,
            "stage": self.stage,
            "next_milestone": self.next_milestone,
            "hint": self.hint,
            "history_summary": self.history_summary,
            "extras": self.extras,
        }


def _append(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf8") as handle:
        handle.write(json.dumps(payload, default=str, ensure_ascii=True) + "\n")


class DecisionRecorder:
    """Appends one training-ready JSONL record per decision to
    logs/decisions_<episode-ts>.jsonl, plus one footer record on clean
    shutdown. Each decision line is written exactly once, after the tool
    result (and any interrupt that ended it) is known.
    """

    def __init__(self, path: Path) -> None:
        self.path = path

    def record_decision(
        self,
        components: PromptComponents,
        completion: Any,
        tool_call: ToolCall,
        fallback: bool,
        result: ToolResult,
        interrupt: str | None,
        critic: dict[str, Any] | None = None,
    ) -> None:
        _append(
            self.path,
            {
                "type": "decision",
                "ts": datetime.now(timezone.utc).isoformat(),
                "schema_version": RECORD_SCHEMA_VERSION,
                "prompt_version": prompt_fingerprint(),
                "components": components.as_dict(),
                "completion": completion,
                "fallback": fallback,
                "tool_call": {"tool": tool_call.tool, "args": tool_call.args},
                "result": result.model_dump(),
                "interrupt": interrupt,
                "critic": critic,
            },
        )

    def record_footer(self, outcome: dict[str, Any]) -> None:
        _append(
            self.path,
            {
                "type": "footer",
                "ts": datetime.now(timezone.utc).isoformat(),
                "schema_version": RECORD_SCHEMA_VERSION,
                "outcome": outcome,
            },
        )
