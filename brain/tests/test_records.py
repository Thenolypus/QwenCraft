import asyncio
import gzip
import hashlib
import json
import shutil

from brain import main, prompts
from brain.main import BotClient, rotate_episode_logs
from brain.memory import MemoryManager
from brain.models import Config, ToolCall, ToolResult
from brain.records import RECORD_SCHEMA_VERSION, DecisionRecorder, PromptComponents, prompt_fingerprint

REPO_ROOT = main.ROOT


def make_components() -> PromptComponents:
    return PromptComponents(
        observation={"status": {"time": "day"}},
        goal="Survive as many nights as possible.",
        stage="first_wood",
        next_milestone="wooden_pickaxe",
        hint="craft a wooden pickaxe",
        history_summary="",
    )


def test_prompt_fingerprint_matches_system_prompt_sha1():
    assert prompt_fingerprint() == hashlib.sha1(prompts.SYSTEM_PROMPT.encode("utf8")).hexdigest()


def test_recorder_does_not_write_until_result_known(tmp_path):
    path = tmp_path / "decisions_test.jsonl"
    recorder = DecisionRecorder(path)
    assert not path.exists()

    recorder.record_decision(
        components=make_components(),
        completion={"tool_calls": [{"function": {"name": "mine_block"}}]},
        tool_call=ToolCall(tool="mine_block", args={"type": "oak_log", "count": 4}),
        fallback=False,
        result=ToolResult(status="success", detail="mined 4 oak_log"),
        interrupt=None,
    )

    assert path.exists()
    assert len(path.read_text(encoding="utf8").splitlines()) == 1


def test_record_decision_writes_one_line_with_full_shape(tmp_path):
    path = tmp_path / "decisions_test.jsonl"
    recorder = DecisionRecorder(path)
    components = make_components()

    recorder.record_decision(
        components=components,
        completion={"tool_calls": [{"function": {"name": "mine_block"}}]},
        tool_call=ToolCall(tool="mine_block", args={"type": "oak_log", "count": 4}),
        fallback=False,
        result=ToolResult(status="success", detail="mined 4 oak_log"),
        interrupt=None,
    )

    lines = path.read_text(encoding="utf8").splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["type"] == "decision"
    assert record["schema_version"] == RECORD_SCHEMA_VERSION
    assert record["prompt_version"] == prompt_fingerprint()
    assert record["components"] == components.as_dict()
    assert record["tool_call"] == {"tool": "mine_block", "args": {"type": "oak_log", "count": 4}}
    assert record["result"] == {"status": "success", "detail": "mined 4 oak_log"}
    assert record["interrupt"] is None
    assert record["fallback"] is False


def test_record_decision_captures_fallback_and_interrupt(tmp_path):
    path = tmp_path / "decisions_test.jsonl"
    recorder = DecisionRecorder(path)

    recorder.record_decision(
        components=make_components(),
        completion={"first_error": "boom", "second_error": "boom again"},
        tool_call=ToolCall(tool="stop", args={}),
        fallback=True,
        result=ToolResult(status="interrupted", detail="mine_block interrupted: stop requested"),
        interrupt="hostile_close",
    )

    record = json.loads(path.read_text(encoding="utf8").splitlines()[0])
    assert record["fallback"] is True
    assert record["interrupt"] == "hostile_close"
    assert record["result"]["status"] == "interrupted"


def test_record_footer_writes_outcome_labels(tmp_path):
    path = tmp_path / "decisions_test.jsonl"
    recorder = DecisionRecorder(path)

    recorder.record_footer({"milestones_reached": ["first_wood"], "deaths": 1, "nights_survived": 2})

    lines = path.read_text(encoding="utf8").splitlines()
    assert len(lines) == 1
    footer = json.loads(lines[0])
    assert footer["type"] == "footer"
    assert footer["schema_version"] == RECORD_SCHEMA_VERSION
    assert footer["outcome"] == {"milestones_reached": ["first_wood"], "deaths": 1, "nights_survived": 2}


def test_rotate_episode_logs_also_gzips_decision_files(tmp_path):
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    decisions_jsonl = log_dir / "decisions_1.jsonl"
    decisions_jsonl.write_text('{"decision": true}\n', encoding="utf8")

    rotate_episode_logs(log_dir, keep_archives=20)

    assert not decisions_jsonl.exists()
    with gzip.open(log_dir / "decisions_1.jsonl.gz", "rt", encoding="utf8") as handle:
        assert json.loads(handle.readline()) == {"decision": True}


def test_dispatch_records_last_interrupt_event():
    class FakeWebsocket:
        def __init__(self) -> None:
            self.sent: list[dict[str, object]] = []
            self.recv_count = 0

        async def send(self, payload: str) -> None:
            self.sent.append(json.loads(payload))

        async def recv(self) -> str:
            self.recv_count += 1
            if self.recv_count == 1:
                return json.dumps({"type": "event", "name": "hostile_close", "data": {"type": "zombie", "dist": 5.0}})
            return json.dumps(
                {
                    "id": self.sent[0]["id"],
                    "type": "tool_result",
                    "status": "interrupted",
                    "detail": "mine_block interrupted: stop requested",
                }
            )

    async def run_dispatch() -> None:
        client = BotClient(FakeWebsocket(), MemoryManager())
        result = await client.dispatch(ToolCall(tool="mine_block", args={"type": "oak_log", "count": 1}), 10)
        assert result.status == "interrupted"
        assert client.last_interrupt_event == "hostile_close"

    asyncio.run(run_dispatch())


def test_dispatch_resets_last_interrupt_event_when_uninterrupted():
    class FakeWebsocket:
        def __init__(self) -> None:
            self.sent: list[dict[str, object]] = []

        async def send(self, payload: str) -> None:
            self.sent.append(json.loads(payload))

        async def recv(self) -> str:
            return json.dumps({"id": self.sent[0]["id"], "type": "tool_result", "status": "success", "detail": "done"})

    async def run_dispatch() -> None:
        client = BotClient(FakeWebsocket(), MemoryManager())
        client.last_interrupt_event = "stale"
        result = await client.dispatch(ToolCall(tool="mine_block", args={"type": "oak_log", "count": 1}), 10)
        assert result.status == "success"
        assert client.last_interrupt_event is None

    asyncio.run(run_dispatch())


def test_recv_counts_death_events_even_without_longterm():
    class FakeWebsocket:
        def __init__(self, messages: list[str]) -> None:
            self.messages = messages

        async def recv(self) -> str:
            return self.messages.pop(0)

    async def run_recv() -> None:
        websocket = FakeWebsocket(
            [
                json.dumps({"type": "event", "name": "death", "data": {"position": [1, 2, 3]}}),
                json.dumps({"type": "event", "name": "death", "data": {"position": [4, 5, 6]}}),
            ]
        )
        client = BotClient(websocket, MemoryManager())
        await client.recv()
        await client.recv()
        assert client.death_count == 2

    asyncio.run(run_recv())


def test_run_writes_decisions_footer_on_clean_shutdown(tmp_path, monkeypatch):
    shutil.copytree(REPO_ROOT / "schemas", tmp_path / "schemas")
    monkeypatch.setattr(main, "ROOT", tmp_path)

    class FakeWebsocket:
        async def send(self, payload: str) -> None:
            pass

        async def recv(self) -> str:
            return json.dumps({"type": "event", "name": "spawned", "data": {}})

    class FakeConnection:
        def __init__(self, websocket: FakeWebsocket) -> None:
            self._websocket = websocket

        async def __aenter__(self) -> FakeWebsocket:
            return self._websocket

        async def __aexit__(self, *exc: object) -> bool:
            return False

    monkeypatch.setattr(main.websockets, "connect", lambda *a, **k: FakeConnection(FakeWebsocket()))

    config = Config(episode_time_limit_minutes=0)
    log_path = asyncio.run(main.run(config, mock=True))

    episode_ts = log_path.stem.removeprefix("episode_")
    decisions_path = tmp_path / "logs" / f"decisions_{episode_ts}.jsonl"
    lines = decisions_path.read_text(encoding="utf8").splitlines()
    assert len(lines) == 1
    footer = json.loads(lines[0])
    assert footer["type"] == "footer"
    assert footer["outcome"] == {"milestones_reached": [], "deaths": 0, "nights_survived": 0}
