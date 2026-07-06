from __future__ import annotations

import json
from collections import OrderedDict
from pathlib import Path
from typing import Any

from .longterm import atomic_write_json
from .models import MemorySnapshot, Observation, ordered_pinned

MAX_EVENT_CHARS = 200
MAX_HISTORY_CHARS = 1200
COMPRESSED_HISTORY_CHARS = 600


class MemoryManager:
    def __init__(self, state_path: Path | None = None) -> None:
        self.state_path = state_path
        self.goal = "Survive as many nights as possible. Build a shelter, gather food, and avoid danger."
        self.pinned: OrderedDict[str, Any] = ordered_pinned()
        self.recent_events: list[str] = []
        self.history_summary = ""
        self.longterm: list[str] | None = None
        self.pending_craft: dict[str, Any] | None = None
        self._load_state()

    def snapshot(self) -> MemorySnapshot:
        return MemorySnapshot(
            goal=self.goal,
            pinned=dict(self.pinned),
            recent_events=self.recent_events[-15:],
            longterm=self.longterm,
            pending_craft=self.pending_craft,
        )

    def merge_observation(self, raw: dict[str, Any]) -> Observation:
        raw = dict(raw)
        raw["memory"] = self.snapshot().model_dump()
        return Observation.model_validate(raw)

    async def add_event(self, event: str, planner: Any | None = None) -> None:
        event = self._cap_event(event)
        self.recent_events.append(event)
        if len(self.recent_events) <= 15:
            return
        oldest = self.recent_events[:10]
        self.recent_events = self.recent_events[10:]
        if planner is not None:
            try:
                summary = await planner.summarize_events(oldest)
            except Exception:
                summary = "; ".join(oldest)
        else:
            summary = "; ".join(oldest)
        self.history_summary = f"{self.history_summary} {summary}".strip()
        await self._enforce_history_budget(planner)
        self._save_state()

    def set_goal(self, text: str) -> None:
        self.goal = text
        self._save_state()

    def note(self, key: str, value: str) -> None:
        if key in self.pinned:
            del self.pinned[key]
        self.pinned[key] = value
        while len(self.pinned) > 10:
            self.pinned.popitem(last=False)
        self._save_state()

    def set_longterm(self, entries: list[str]) -> None:
        self.longterm = entries

    def set_pending_craft(self, item: str, count: int, reason: str) -> None:
        self.pending_craft = {"item": item, "count": count, "reason": reason}
        self._save_state()

    def clear_pending_craft(self) -> None:
        if self.pending_craft is None:
            return
        self.pending_craft = None
        self._save_state()

    async def _enforce_history_budget(self, planner: Any | None) -> None:
        if len(self.history_summary) <= MAX_HISTORY_CHARS:
            return
        text = self.history_summary
        if planner is not None and hasattr(planner, "compress_history"):
            try:
                compressed = (await planner.compress_history(text)).strip()
                if len(compressed) <= COMPRESSED_HISTORY_CHARS:
                    self.history_summary = compressed
                    return
            except Exception:
                pass
        self.history_summary = text[-MAX_HISTORY_CHARS:]

    def _cap_event(self, event: str) -> str:
        if len(event) <= MAX_EVENT_CHARS:
            return event
        return event[: MAX_EVENT_CHARS - 1] + "…"

    def _load_state(self) -> None:
        if self.state_path is None or not self.state_path.exists():
            return
        data = json.loads(self.state_path.read_text(encoding="utf8"))
        self.goal = str(data.get("goal", self.goal))
        self.pinned = ordered_pinned(data.get("pinned", {}))
        self.history_summary = str(data.get("history_summary", ""))
        pending = data.get("pending_craft")
        self.pending_craft = dict(pending) if isinstance(pending, dict) else None

    def _save_state(self) -> None:
        if self.state_path is None:
            return
        atomic_write_json(
            self.state_path,
            {
                "goal": self.goal,
                "pinned": dict(self.pinned),
                "history_summary": self.history_summary,
                "pending_craft": self.pending_craft,
            },
        )
