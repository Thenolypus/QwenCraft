import asyncio
import json
from types import SimpleNamespace

from brain.llm import LLMPlanner, load_tools
from brain.main import FAILURE_BLOCK_SECONDS, ROOT, FailureTracker
from brain.models import Config, Inventory, MemorySnapshot, Observation, Status, ToolCall, ToolResult


def mine_call(count: int = 10) -> ToolCall:
    return ToolCall(tool="mine_block", args={"type": "oak_log", "count": count})


def failed(detail: str = "mine_block failed: timed out after 120s") -> ToolResult:
    return ToolResult(status="failed", detail=detail)


class FakeClock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


def test_two_consecutive_failures_block_the_exact_call_with_prompt_line():
    tracker = FailureTracker(clock=FakeClock())

    assert tracker.record_result(mine_call(), failed()) == 1
    assert not tracker.is_blocked(mine_call())
    assert tracker.record_result(mine_call(), failed()) == 2
    assert tracker.is_blocked(mine_call())

    entries = tracker.blocked_calls()
    assert len(entries) == 1
    assert entries[0]["tool"] == "mine_block"
    assert entries[0]["args"] == {"count": 10, "type": "oak_log"}
    message = entries[0]["message"]
    assert message.startswith("BLOCKED: mine_block(")
    assert "failed 2x in a row" in message
    assert "timed out after 120s" in message
    assert "Choose a different tool, target, or approach." in message


def test_different_args_track_separate_keys():
    tracker = FailureTracker(clock=FakeClock())

    tracker.record_result(mine_call(10), failed())
    tracker.record_result(mine_call(4), failed())

    assert not tracker.is_blocked(mine_call(10))
    assert not tracker.is_blocked(mine_call(4))
    assert tracker.blocked_calls() == []


def test_success_resets_the_consecutive_count():
    tracker = FailureTracker(clock=FakeClock())

    tracker.record_result(mine_call(), failed())
    tracker.record_result(mine_call(), ToolResult(status="success", detail="mined 10 oak_log"))
    assert tracker.record_result(mine_call(), failed()) == 1
    assert not tracker.is_blocked(mine_call())


def test_interrupted_neither_counts_nor_resets():
    tracker = FailureTracker(clock=FakeClock())

    tracker.record_result(mine_call(), failed())
    streak = tracker.record_result(mine_call(), ToolResult(status="interrupted", detail="stop requested"))
    assert streak == 1
    assert not tracker.is_blocked(mine_call())

    interrupt_only = FailureTracker(clock=FakeClock())
    interrupt_only.record_result(mine_call(), ToolResult(status="interrupted", detail="stop requested"))
    interrupt_only.record_result(mine_call(), ToolResult(status="interrupted", detail="stop requested"))
    assert not interrupt_only.is_blocked(mine_call())


def test_block_expires_after_cooldown():
    clock = FakeClock(1000.0)
    tracker = FailureTracker(clock=clock)
    tracker.record_result(mine_call(), failed())
    tracker.record_result(mine_call(), failed())
    assert tracker.is_blocked(mine_call())

    clock.now = 1000.0 + FAILURE_BLOCK_SECONDS
    assert not tracker.is_blocked(mine_call())
    assert tracker.blocked_calls() == []


def make_observation() -> Observation:
    return Observation(
        status=Status(
            position=(10, 64, -3),
            health=18.0,
            hunger=15.0,
            oxygen=20.0,
            time="day",
            minutes_to_night=12.5,
            weather="clear",
            biome="plains",
            light=14,
            danger_flags=[],
        ),
        inventory=Inventory(held=None, items={}, free_slots=36, armor=(None, None, None, None)),
        entities=[],
        blocks_of_interest=[],
        last_action=None,
        memory=MemorySnapshot(goal="Survive as many nights as possible.", pinned={}, recent_events=[]),
    )


class FakeMessage:
    def __init__(self, tool: str, args: dict) -> None:
        self.tool_calls = None
        self.content = json.dumps({"name": tool, "arguments": args})


class FakeResponse:
    def __init__(self, tool: str, args: dict) -> None:
        self.choices = [SimpleNamespace(message=FakeMessage(tool, args))]

    def model_dump(self, mode: str = "json") -> dict:
        return {"fake": True}


class FakeCompletions:
    def __init__(self, responses: list[FakeResponse]) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    async def create(self, **kwargs) -> FakeResponse:
        self.calls.append(kwargs)
        return self.responses.pop(0)


def make_planner(responses: list[FakeResponse]) -> tuple[LLMPlanner, FakeCompletions]:
    tools = load_tools(ROOT / "schemas" / "tools.schema.json")
    planner = LLMPlanner(Config(), tools)
    completions = FakeCompletions(responses)
    planner.client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    return planner, completions


BLOCKED_ENTRY = {
    "tool": "mine_block",
    "args": {"type": "oak_log", "count": 10},
    "message": "BLOCKED: mine_block({...}) failed 2x in a row (timed out). Choose a different tool, target, or approach.",
}


def test_decide_injects_blocked_lines_and_notice_into_user_prompt():
    planner, completions = make_planner([FakeResponse("stop", {})])
    notice = "CRITIC (previous mine_block failure): timeout — no oak_log reachable."

    asyncio.run(planner.decide(make_observation(), blocked=[BLOCKED_ENTRY], notice=notice))

    user_prompt = completions.calls[0]["messages"][1]["content"]
    # Same construction the recorder captures in components.extras, so the
    # SFT exporter can re-render this exact prompt offline.
    assert user_prompt.endswith("\n\n" + notice + "\n" + BLOCKED_ENTRY["message"])


def test_decide_reasks_when_model_returns_a_blocked_call():
    planner, completions = make_planner(
        [
            FakeResponse("mine_block", {"type": "oak_log", "count": 10}),
            FakeResponse("craft", {"item": "crafting_table", "count": 1}),
        ]
    )

    call, raw = asyncio.run(planner.decide(make_observation(), blocked=[BLOCKED_ENTRY]))

    assert call.tool == "craft"
    assert len(completions.calls) == 2
    corrective = completions.calls[1]["messages"][-1]["content"]
    assert "Invalid tool call" in corrective
    assert "blocked" in corrective


def test_decide_falls_back_to_stop_when_retry_is_still_blocked():
    planner, completions = make_planner(
        [
            FakeResponse("mine_block", {"type": "oak_log", "count": 10}),
            FakeResponse("mine_block", {"type": "oak_log", "count": 10}),
        ]
    )

    call, raw = asyncio.run(planner.decide(make_observation(), blocked=[BLOCKED_ENTRY]))

    assert call.tool == "stop"
    assert "blocked" in raw["first_error"]
    assert "blocked" in raw["second_error"]


def test_decide_allows_same_tool_with_different_args_while_blocked():
    planner, completions = make_planner([FakeResponse("mine_block", {"type": "birch_log", "count": 4})])

    call, _ = asyncio.run(planner.decide(make_observation(), blocked=[BLOCKED_ENTRY]))

    assert call.tool == "mine_block"
    assert call.args == {"type": "birch_log", "count": 4}
    assert len(completions.calls) == 1
