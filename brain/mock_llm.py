from __future__ import annotations

from typing import Any

from .models import Observation, ToolCall, ToolResult


class MockPolicy:
    """Scripted milestone policy for integration tests without an LLM server."""

    def __init__(self) -> None:
        self.survival_chat_sent = False
        self.has_seen_night = False

    async def decide(
        self,
        observation: Observation,
        stage: str = "unknown",
        next_milestone: str = "unknown",
        hint: str = "",
        blocked: list[dict[str, Any]] | None = None,
        notice: str | None = None,
    ) -> tuple[ToolCall, dict[str, Any]]:
        inv = observation.inventory.items
        pinned = observation.memory.pinned

        if inv.get("oak_log", 0) + inv.get("spruce_log", 0) + inv.get("birch_log", 0) < 4:
            return self._call("mine_block", {"type": self._nearest_log(observation), "count": 4})

        plank_type = self._plank_type(inv)
        if sum(count for name, count in inv.items() if name.endswith("_planks")) < 12:
            return self._call("craft", {"item": plank_type, "count": 4})

        if inv.get("crafting_table", 0) < 1:
            return self._call("craft", {"item": "crafting_table", "count": 1})

        if inv.get("stick", 0) < 2:
            return self._call("craft", {"item": "stick", "count": 1})

        if inv.get("wooden_pickaxe", 0) < 1:
            return self._call("craft", {"item": "wooden_pickaxe", "count": 1})

        if inv.get("cobblestone", 0) < 8:
            return self._call("mine_block", {"type": "stone", "count": 8})

        if inv.get("cobblestone", 0) < 20 and "shelter" not in pinned:
            return self._call("mine_block", {"type": "stone", "count": 12})

        if "shelter" not in pinned:
            return self._call("build_shelter", {"style": "dirt_box"})

        if observation.status.time in {"night", "sunset"}:
            self.has_seen_night = True
            return self._call("stop", {})

        if self.has_seen_night and not self.survival_chat_sent and observation.status.time in {"sunrise", "day"}:
            self.survival_chat_sent = True
            return self._call("chat", {"message": "survived night 1"})

        return self._call("stop", {})

    async def summarize_events(self, events: list[str]) -> str:
        return "; ".join(events[:3])

    async def compress_history(self, text: str) -> str:
        return text[-600:]

    async def critic(self, observation: Observation, goal: str, tool_call: ToolCall, result: ToolResult) -> dict[str, str]:
        return {
            "verdict": "mock_failure",
            "explanation": f"mock critic: {tool_call.tool} failed ({result.detail})",
            "lesson": f"avoid repeating {tool_call.tool} with the same args right after a failure",
        }

    def _call(self, tool: str, args: dict[str, Any]) -> tuple[ToolCall, dict[str, Any]]:
        return ToolCall(tool=tool, args=args), {"mock": True, "tool": tool, "args": args}

    def _nearest_log(self, observation: Observation) -> str:
        logs = [block for block in observation.blocks_of_interest if block.type.endswith("_log")]
        if logs:
            return logs[0].type
        return "oak_log"

    def _plank_type(self, inv: dict[str, int]) -> str:
        for name, count in inv.items():
            if name.endswith("_log") and count > 0:
                return name.removesuffix("_log") + "_planks"
        return "oak_planks"
