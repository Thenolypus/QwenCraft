import asyncio
import json

from brain.main import INTERRUPT_COOLDOWN_SECONDS, BotClient, is_escalation, should_interrupt
from brain.memory import MemoryManager
from brain.models import ToolCall


def test_hunger_is_not_an_interrupt():
    assert not should_interrupt("mine_block", "hunger_low")


def test_threat_interrupts_non_defensive_work():
    assert should_interrupt("mine_block", "damage_taken", {"health": 7.5})


def test_threat_does_not_cancel_active_flee():
    assert not should_interrupt("flee", "damage_taken")
    assert not should_interrupt("flee", "hostile_close")
    assert not should_interrupt("flee", "emergency")


def test_death_interrupts_even_active_flee():
    assert should_interrupt("flee", "death")


def test_shelter_and_sleep_survive_sunset_and_hostile_reemissions():
    for tool in ("build_shelter", "sleep"):
        assert not should_interrupt(tool, "night_falling")
        assert not should_interrupt(tool, "hostile_close")


def test_damage_taken_interrupts_only_below_health_threshold():
    assert not should_interrupt("mine_block", "damage_taken", {"health": 15})
    assert not should_interrupt("mine_block", "damage_taken", {"health": 8})
    assert not should_interrupt("mine_block", "damage_taken", {})
    assert should_interrupt("mine_block", "damage_taken", {"health": 7.9})


def test_damage_taken_does_not_cancel_active_attack():
    assert not should_interrupt("attack", "damage_taken", {"health": 4})


def test_cooldown_suppresses_repeats_across_dispatches():
    client = BotClient(None, MemoryManager())
    assert client._interrupt_allowed("hostile_close", {"dist": 5.0}, now=100.0)
    assert not client._interrupt_allowed("hostile_close", {"dist": 5.0}, now=110.0)
    assert client._interrupt_allowed("hostile_close", {"dist": 5.0}, now=100.0 + INTERRUPT_COOLDOWN_SECONDS)


def test_escalation_bypasses_cooldown():
    client = BotClient(None, MemoryManager())
    assert client._interrupt_allowed("hostile_close", {"dist": 5.0}, now=100.0)
    assert client._interrupt_allowed("hostile_close", {"dist": 2.0}, now=105.0)
    client = BotClient(None, MemoryManager())
    assert client._interrupt_allowed("damage_taken", {"health": 7.0}, now=100.0)
    assert client._interrupt_allowed("damage_taken", {"health": 4.0}, now=105.0)


def test_death_and_emergency_are_never_rate_limited():
    client = BotClient(None, MemoryManager())
    assert client._interrupt_allowed("death", {}, now=100.0)
    assert client._interrupt_allowed("death", {}, now=100.1)
    assert client._interrupt_allowed("emergency", {"health": 3}, now=100.2)
    assert client._interrupt_allowed("emergency", {"health": 3}, now=100.3)


def test_is_escalation_requires_worse_news():
    assert is_escalation("damage_taken", {"health": 4}, {"health": 9})
    assert not is_escalation("damage_taken", {"health": 9}, {"health": 4})
    assert is_escalation("hostile_close", {"dist": 2.0}, {"dist": 5.0})
    assert not is_escalation("hostile_close", {"dist": 4.5}, {"dist": 5.0})
    assert not is_escalation("night_falling", {"minutes_to_night": 0.2}, {"minutes_to_night": 0.5})
    assert not is_escalation("hostile_close", {"dist": 2.0}, None)


def test_dispatch_sends_one_stop_per_event_name():
    class FakeWebsocket:
        def __init__(self) -> None:
            self.sent: list[dict[str, object]] = []
            self.recv_count = 0

        async def send(self, payload: str) -> None:
            self.sent.append(json.loads(payload))

        async def recv(self) -> str:
            self.recv_count += 1
            if self.recv_count <= 2:
                return json.dumps({"type": "event", "name": "hostile_close", "data": {"type": "zombie", "dist": 5.4}})
            return json.dumps(
                {
                    "type": "tool_result",
                    "id": self.sent[0]["id"],
                    "status": "success",
                    "detail": "done",
                }
            )

    async def run_dispatch() -> FakeWebsocket:
        websocket = FakeWebsocket()
        client = BotClient(websocket, MemoryManager())
        result = await client.dispatch(ToolCall(tool="mine_block", args={"type": "oak_log", "count": 1}), 10)
        assert result.status == "success"
        return websocket

    websocket = asyncio.run(run_dispatch())

    stop_calls = [message for message in websocket.sent if message["tool"] == "stop"]
    assert len(stop_calls) == 1
