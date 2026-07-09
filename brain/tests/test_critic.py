import asyncio
import json
from types import SimpleNamespace

from brain.llm import LLMPlanner, load_tools, parse_critic_response
from brain.longterm import LongTermStore
from brain.main import ROOT, format_critic_notice, run_failure_critic
from brain.mock_llm import MockPolicy
from brain.models import Config, Inventory, MemorySnapshot, Observation, Status, ToolCall, ToolResult
from brain.prompts import CRITIC_SYSTEM_PROMPT
from brain.records import DecisionRecorder, PromptComponents


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
        memory=MemorySnapshot(goal="reach iron gear", pinned={}, recent_events=[]),
    )


class CountingCritic(MockPolicy):
    def __init__(self) -> None:
        super().__init__()
        self.critic_calls = 0

    async def critic(self, observation, goal, tool_call, result):
        self.critic_calls += 1
        return await super().critic(observation, goal, tool_call, result)


MINE_CALL = ToolCall(tool="mine_block", args={"type": "oak_log", "count": 10})
FAILED = ToolResult(status="failed", detail="mine_block failed: timed out after 120s")


def test_critic_runs_on_first_failure_and_writes_lesson_to_longterm(tmp_path):
    longterm = LongTermStore(tmp_path / "longterm.json")
    planner = CountingCritic()

    verdict = asyncio.run(
        run_failure_critic(planner, MINE_CALL, FAILED, make_observation(), streak=1, was_blocked=False, longterm=longterm)
    )

    assert planner.critic_calls == 1
    assert verdict is not None
    assert set(verdict) == {"verdict", "explanation", "lesson"}
    lessons = [record for record in longterm.records if record.get("type") == "lesson"]
    assert len(lessons) == 1
    assert lessons[0]["value"] == verdict["lesson"]
    assert lessons[0]["importance"] == 2


def test_critic_not_called_on_interrupted_result(tmp_path):
    longterm = LongTermStore(tmp_path / "longterm.json")
    planner = CountingCritic()
    interrupted = ToolResult(status="interrupted", detail="mine_block interrupted: stop requested")

    verdict = asyncio.run(
        run_failure_critic(planner, MINE_CALL, interrupted, make_observation(), streak=0, was_blocked=False, longterm=longterm)
    )

    assert verdict is None
    assert planner.critic_calls == 0
    assert longterm.records == []


def test_critic_not_called_when_key_already_blocked(tmp_path):
    longterm = LongTermStore(tmp_path / "longterm.json")
    planner = CountingCritic()

    verdict = asyncio.run(
        run_failure_critic(planner, MINE_CALL, FAILED, make_observation(), streak=1, was_blocked=True, longterm=longterm)
    )

    assert verdict is None
    assert planner.critic_calls == 0


def test_critic_not_called_again_on_second_consecutive_failure(tmp_path):
    longterm = LongTermStore(tmp_path / "longterm.json")
    planner = CountingCritic()

    verdict = asyncio.run(
        run_failure_critic(planner, MINE_CALL, FAILED, make_observation(), streak=2, was_blocked=False, longterm=longterm)
    )

    assert verdict is None
    assert planner.critic_calls == 0


def test_format_critic_notice_mentions_tool_and_lesson():
    notice = format_critic_notice(
        MINE_CALL,
        {"verdict": "timeout", "explanation": "no oak_log reachable", "lesson": "explore before mining"},
    )

    assert "CRITIC (previous mine_block failure)" in notice
    assert "timeout" in notice
    assert "explore before mining" in notice


def test_parse_critic_response_reads_structured_lines():
    parsed = parse_critic_response(
        "VERDICT: timeout\nWHY: target block too far away\nLESSON: explore closer to trees before mining"
    )

    assert parsed == {
        "verdict": "timeout",
        "explanation": "target block too far away",
        "lesson": "explore closer to trees before mining",
    }


def test_parse_critic_response_falls_back_to_raw_text():
    parsed = parse_critic_response("the pickaxe broke mid-dig")

    assert parsed["verdict"] == "failed"
    assert parsed["explanation"] == "the pickaxe broke mid-dig"
    assert parsed["lesson"] == "the pickaxe broke mid-dig"


class RecordingCompletions:
    def __init__(self, content: str) -> None:
        self.content = content
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        message = SimpleNamespace(content=self.content, tool_calls=None)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def test_llmplanner_critic_is_plain_completion_without_tools():
    tools = load_tools(ROOT / "schemas" / "tools.schema.json")
    planner = LLMPlanner(Config(), tools)
    completions = RecordingCompletions("VERDICT: timeout\nWHY: too far\nLESSON: mine closer trees")
    planner.client = SimpleNamespace(chat=SimpleNamespace(completions=completions))

    verdict = asyncio.run(planner.critic(make_observation(), "reach iron gear", MINE_CALL, FAILED))

    assert verdict == {"verdict": "timeout", "explanation": "too far", "lesson": "mine closer trees"}
    call = completions.calls[0]
    assert "tools" not in call
    assert call["temperature"] == 0
    assert call["messages"][0] == {"role": "system", "content": CRITIC_SYSTEM_PROMPT}
    assert "mine_block" in call["messages"][1]["content"]
    assert "timed out after 120s" in call["messages"][1]["content"]


def test_mock_policy_critic_returns_usable_verdict():
    verdict = asyncio.run(MockPolicy().critic(make_observation(), "reach iron gear", MINE_CALL, FAILED))

    assert verdict["lesson"]
    assert "mine_block" in verdict["explanation"]


def make_components() -> PromptComponents:
    return PromptComponents(
        observation={"status": {"time": "day"}},
        goal="reach iron gear",
        stage="first_wood",
        next_milestone="wooden_pickaxe",
        hint="craft a wooden pickaxe",
        history_summary="",
    )


def test_record_decision_labels_critic_fields(tmp_path):
    path = tmp_path / "decisions_test.jsonl"
    recorder = DecisionRecorder(path)
    critic = {"verdict": "timeout", "explanation": "too far", "lesson": "mine closer trees"}

    recorder.record_decision(
        components=make_components(),
        completion={"tool_calls": []},
        tool_call=MINE_CALL,
        fallback=False,
        result=FAILED,
        interrupt=None,
        critic=critic,
    )
    recorder.record_decision(
        components=make_components(),
        completion={"tool_calls": []},
        tool_call=MINE_CALL,
        fallback=False,
        result=ToolResult(status="success", detail="mined 10 oak_log"),
        interrupt=None,
    )

    records = [json.loads(line) for line in path.read_text(encoding="utf8").splitlines()]
    assert records[0]["critic"] == critic
    assert records[1]["critic"] is None
