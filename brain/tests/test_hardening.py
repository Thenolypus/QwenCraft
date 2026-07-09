import asyncio
import json
import shutil

import pytest
from websockets.exceptions import ConnectionClosed

from brain import main
from brain.main import BotConnectionError, tool_timeout_seconds
from brain.models import Config

REPO_ROOT = main.ROOT

# Keep in sync with timeoutSecondsForTool in bot/src/tools/index.ts.
BOT_OBTAIN_ITEM_BUDGET_SECONDS = 600


def test_obtain_item_brain_timeout_covers_bot_budget():
    # dispatch() waits tool_timeout_seconds + 30s slack, so with an equal base
    # timeout the bot-side 600s budget always gives up first.
    assert tool_timeout_seconds("obtain_item") >= BOT_OBTAIN_ITEM_BUDGET_SECONDS


def test_other_tools_keep_existing_timeouts():
    assert tool_timeout_seconds("mine_block") == 120
    assert tool_timeout_seconds("craft") == 60


OBSERVATION = {
    "status": {
        "position": [0, 64, 0],
        "health": 20,
        "hunger": 20,
        "oxygen": 20,
        "time": "day",
        "minutes_to_night": 10,
        "weather": "clear",
        "biome": "plains",
        "light": 15,
        "danger_flags": [],
    },
    "inventory": {"held": None, "items": {}, "free_slots": 36, "armor": [None, None, None, None]},
    "entities": [],
    "blocks_of_interest": [],
    "last_action": None,
}


class DyingWebsocket:
    """Delivers spawn and one observation, then drops the connection as soon
    as a tool call is dispatched — simulating the bot process dying mid-tool."""

    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []
        self.spawn_delivered = False

    async def send(self, payload: str) -> None:
        self.sent.append(json.loads(payload))

    async def recv(self) -> str:
        if not self.spawn_delivered:
            self.spawn_delivered = True
            return json.dumps({"type": "event", "name": "spawned", "data": {}})
        if self.sent and self.sent[-1].get("type") == "get_observation":
            return json.dumps({"type": "observation", "data": OBSERVATION})
        raise ConnectionClosed(None, None)


class FakeConnection:
    def __init__(self, websocket: DyingWebsocket) -> None:
        self._websocket = websocket

    async def __aenter__(self) -> DyingWebsocket:
        return self._websocket

    async def __aexit__(self, *exc: object) -> bool:
        return False


def test_connection_lost_names_in_flight_call_and_records_it(tmp_path, monkeypatch):
    shutil.copytree(REPO_ROOT / "schemas", tmp_path / "schemas")
    monkeypatch.setattr(main, "ROOT", tmp_path)
    monkeypatch.setattr(main.websockets, "connect", lambda *a, **k: FakeConnection(DyingWebsocket()))

    config = Config(episode_time_limit_minutes=1)
    with pytest.raises(BotConnectionError, match=r"bot connection lost while running mine_block\("):
        asyncio.run(main.run(config, mock=True))

    decisions_files = list((tmp_path / "logs").glob("decisions_*.jsonl"))
    assert len(decisions_files) == 1
    records = [json.loads(line) for line in decisions_files[0].read_text(encoding="utf8").splitlines()]
    decision = records[0]
    assert decision["type"] == "decision"
    assert decision["tool_call"]["tool"] == "mine_block"
    assert decision["result"]["status"] == "connection_lost"
    assert "bot connection lost while running mine_block(" in decision["result"]["detail"]
    assert "bot process may have died" in decision["result"]["detail"]
