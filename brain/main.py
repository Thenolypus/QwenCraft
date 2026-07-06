from __future__ import annotations

import argparse
import asyncio
import gzip
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import websockets
from jsonschema import Draft202012Validator
from websockets.exceptions import ConnectionClosed

if __package__ in {None, ""}:
    sys.path.append(str(Path(__file__).resolve().parents[1]))
    __package__ = "brain"

from .curriculum import curriculum_status
from .llm import LLMConnectionError, LLMPlanner, load_tools
from .longterm import LongTermStore, format_record
from .memory import MemoryManager
from .mock_llm import MockPolicy
from .models import Config, ToolCall, ToolResult, load_config


# Hunger stays in observations/danger_flags so the planner can account for it
# without aborting the current action. Damage and immediate threats remain interrupts.
INTERRUPT_EVENTS = {"damage_taken", "night_falling", "hostile_close", "death", "emergency"}
THREAT_EVENTS = {"damage_taken", "hostile_close", "emergency"}
LONG_RUNNING_TOOLS = {"goto", "explore", "mine_block"}
# Reflex events re-fire on timers while their condition persists; once the planner has
# been told, repeating the same news must not keep killing whatever it chose to do next.
INTERRUPT_COOLDOWN_SECONDS = 30.0
ROOT = Path(__file__).resolve().parents[1]


class BotConnectionError(ConnectionError):
    pass


def tool_timeout_seconds(tool: str) -> int:
    return 120 if tool in LONG_RUNNING_TOOLS else 60


def should_interrupt(tool: str, event: str, data: dict[str, Any] | None = None) -> bool:
    if tool == "stop" or event not in INTERRUPT_EVENTS:
        return False
    if tool == "flee" and event in THREAT_EVENTS:
        return False
    if event in {"death", "emergency"}:
        return True
    if tool in {"build_shelter", "sleep"} and event in {"night_falling", "hostile_close"}:
        return False
    if tool == "attack" and event in {"hostile_close", "damage_taken"}:
        return False
    if event == "damage_taken":
        health = (data or {}).get("health")
        return isinstance(health, (int, float)) and health < 8
    return True


def is_escalation(event: str, data: dict[str, Any] | None, previous: dict[str, Any] | None) -> bool:
    """True when a repeated event carries meaningfully worse news than the last interrupt."""
    if not data or not previous:
        return False
    if event == "damage_taken":
        new, old = data.get("health"), previous.get("health")
        return isinstance(new, (int, float)) and isinstance(old, (int, float)) and new < old
    if event == "hostile_close":
        new, old = data.get("dist"), previous.get("dist")
        return isinstance(new, (int, float)) and isinstance(old, (int, float)) and new < old - 1
    return False


class BotClient:
    def __init__(
        self,
        websocket: Any,
        memory: MemoryManager,
        planner: Any | None = None,
        longterm: LongTermStore | None = None,
    ) -> None:
        self.websocket = websocket
        self.memory = memory
        self.planner = planner
        self.longterm = longterm
        self._last_interrupts: dict[str, tuple[float, dict[str, Any]]] = {}

    async def send(self, payload: dict[str, Any]) -> None:
        try:
            await self.websocket.send(json.dumps(payload))
        except ConnectionClosed as exc:
            raise BotConnectionError(
                f"Bot WebSocket closed while sending {payload.get('type', 'message')}: {exc}. "
                "Check the bot terminal for the underlying Mineflayer error."
            ) from exc

    async def recv(self) -> dict[str, Any]:
        try:
            raw = await self.websocket.recv()
        except ConnectionClosed as exc:
            raise BotConnectionError(
                f"Bot WebSocket closed while waiting for a message: {exc}. "
                "Check the bot terminal for the underlying Mineflayer error."
            ) from exc
        message = json.loads(raw)
        if message.get("type") == "event":
            name = message.get("name", "event")
            await self.memory.add_event(f"{name}: {message.get('data', {})}", self.planner)
            if name == "death" and self.longterm is not None:
                pos = parse_position(message.get("data", {}).get("position") if isinstance(message.get("data"), dict) else None)
                self.longterm.upsert(
                    {
                        "type": "death",
                        "key": "last_death",
                        "value": f"death at {pos or 'unknown position'}",
                        "pos": pos,
                        "importance": 4,
                    }
                )
        return message

    async def wait_for_spawn(self) -> None:
        while True:
            message = await self.recv()
            if message.get("type") == "event" and message.get("name") == "spawned":
                return

    async def observation(self) -> dict[str, Any]:
        await self.send({"type": "get_observation"})
        while True:
            message = await self.recv()
            if message.get("type") == "observation":
                return message["data"]

    def _interrupt_allowed(self, event: str, data: dict[str, Any], now: float) -> bool:
        """Rate-limit repeated interrupts for the same recurring event, across dispatches."""
        if event in {"death", "emergency"}:
            return True
        previous = self._last_interrupts.get(event)
        if previous is not None:
            last_time, last_data = previous
            if now - last_time < INTERRUPT_COOLDOWN_SECONDS and not is_escalation(event, data, last_data):
                return False
        self._last_interrupts[event] = (now, dict(data))
        return True

    async def dispatch(self, call: ToolCall, heartbeat_seconds: int) -> ToolResult:
        call_id = str(uuid.uuid4())
        await self.send({"id": call_id, "type": "tool_call", "tool": call.tool, "args": call.args})
        deadline = asyncio.get_running_loop().time() + tool_timeout_seconds(call.tool) + 30
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                stop_id = str(uuid.uuid4())
                await self.send({"id": stop_id, "type": "tool_call", "tool": "stop", "args": {}})
                return ToolResult(
                    status="failed",
                    detail=f"{call.tool} failed: no tool_result received before brain-side timeout",
                )
            try:
                message = await asyncio.wait_for(self.recv(), timeout=remaining)
            except asyncio.TimeoutError:
                stop_id = str(uuid.uuid4())
                await self.send({"id": stop_id, "type": "tool_call", "tool": "stop", "args": {}})
                return ToolResult(
                    status="failed",
                    detail=f"{call.tool} failed: no tool_result received before brain-side timeout",
                )
            if message.get("type") == "tool_result" and message.get("id") == call_id:
                return ToolResult(status=message["status"], detail=message["detail"])
            if message.get("type") == "event":
                event_name = str(message.get("name", ""))
                data = message.get("data") if isinstance(message.get("data"), dict) else {}
                if should_interrupt(call.tool, event_name, data) and self._interrupt_allowed(
                    event_name, data, asyncio.get_running_loop().time()
                ):
                    stop_id = str(uuid.uuid4())
                    await self.send({"id": stop_id, "type": "tool_call", "tool": "stop", "args": {}})


def write_log(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf8") as handle:
        handle.write(json.dumps(payload, default=str, ensure_ascii=True) + "\n")


def rotate_episode_logs(log_dir: Path, keep_archives: int = 20) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    for path in log_dir.glob("episode_*.jsonl"):
        archive = path.with_suffix(path.suffix + ".gz")
        mtime = path.stat().st_mtime
        tmp = archive.with_name(f"{archive.name}.tmp")
        with path.open("rt", encoding="utf8") as source, gzip.open(tmp, "wt", encoding="utf8") as target:
            target.write(source.read())
        os.replace(tmp, archive)
        os.utime(archive, (mtime, mtime))
        path.unlink()

    archives = sorted(log_dir.glob("episode_*.jsonl.gz"), key=lambda item: item.stat().st_mtime, reverse=True)
    for old_archive in archives[keep_archives:]:
        old_archive.unlink()


def slim_llm_response(raw_response: Any) -> Any:
    if not isinstance(raw_response, dict) or "choices" not in raw_response:
        return raw_response
    choices = raw_response.get("choices") or []
    message = choices[0].get("message", {}) if choices and isinstance(choices[0], dict) else {}
    slim: dict[str, Any] = {}
    for key in ("content", "tool_calls"):
        value = message.get(key)
        if value is not None:
            slim[key] = drop_none(value)
    usage = raw_response.get("usage")
    if isinstance(usage, dict):
        compact_usage = {key: value for key, value in usage.items() if value is not None}
        if compact_usage:
            slim["usage"] = compact_usage
    return slim


def drop_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: drop_none(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [drop_none(item) for item in value if item is not None]
    return value


def parse_position(value: Any) -> list[int] | None:
    if isinstance(value, (list, tuple)) and len(value) == 3:
        try:
            return [int(float(part)) for part in value]
        except (TypeError, ValueError):
            return None
    if not isinstance(value, str):
        return None
    numbers = re.findall(r"-?\d+(?:\.\d+)?", value)
    if len(numbers) < 3:
        return None
    return [int(float(part)) for part in numbers[:3]]


def _count_from_value(value: Any) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return 1


def _tool_arg_count(call: ToolCall) -> int:
    return _count_from_value(call.args.get("count", 1))


def update_pending_craft(call: ToolCall, result: ToolResult, memory: MemoryManager) -> None:
    if call.tool != "craft":
        return
    item = str(call.args.get("item", ""))
    count = _tool_arg_count(call)
    if not item:
        return

    if result.status == "success":
        if memory.pending_craft and memory.pending_craft.get("item") == item:
            memory.clear_pending_craft()
        return

    if result.status != "failed" or not result.detail.startswith("craft failed:"):
        return
    if memory.pending_craft and memory.pending_craft.get("item") != item:
        return
    memory.set_pending_craft(item, count, result.detail.removeprefix("craft failed:").strip())


def clear_satisfied_pending_craft(observation: Any, memory: MemoryManager) -> None:
    if not memory.pending_craft:
        return
    item = str(memory.pending_craft.get("item", ""))
    count = _count_from_value(memory.pending_craft.get("count", 1))
    if observation.inventory.items.get(item, 0) >= count:
        memory.clear_pending_craft()


async def record_new_milestones(
    observation: Any,
    reached_milestones: set[str],
    memory: MemoryManager,
    longterm: LongTermStore,
    planner: Any | None,
) -> None:
    status = curriculum_status(observation)
    position = list(observation.status.position)
    for name in status.satisfied:
        if name in reached_milestones:
            continue
        reached_milestones.add(name)
        await memory.add_event(f"milestone reached: {name}", planner)
        longterm.upsert(
            {
                "type": "achievement",
                "key": name,
                "value": f"milestone reached: {name}",
                "pos": position,
                "importance": 4,
            }
        )


def compact_json(value: Any, max_length: int = 180) -> str:
    text = json.dumps(value, ensure_ascii=True, default=str)
    if len(text) <= max_length:
        return text
    return text[: max_length - 3] + "..."


def print_step(message: str, **fields: Any) -> None:
    suffix = " ".join(f"{key}={compact_json(value)}" for key, value in fields.items())
    print(f"[brain] {message}{' ' + suffix if suffix else ''}", flush=True)


def validate_schemas() -> tuple[Draft202012Validator, list[dict[str, Any]]]:
    observation_schema = json.loads((ROOT / "schemas" / "observation.schema.json").read_text())
    tools = load_tools(ROOT / "schemas" / "tools.schema.json")
    return Draft202012Validator(observation_schema), tools


async def execute_local_meta(call: ToolCall, memory: MemoryManager) -> ToolResult | None:
    if call.tool == "set_goal":
        memory.set_goal(str(call.args["text"]))
        return ToolResult(status="success", detail=f"goal set: {call.args['text']}")
    if call.tool == "note":
        memory.note(str(call.args["key"]), str(call.args["value"]))
        return ToolResult(status="success", detail=f"noted {call.args['key']}={call.args['value']}")
    return None


def maybe_pin_shelter(
    call: ToolCall,
    result: ToolResult,
    memory: MemoryManager,
    longterm: LongTermStore | None = None,
) -> None:
    if call.tool != "build_shelter" or result.status != "success":
        return
    detail = result.detail
    start = detail.find("[")
    end = detail.find("]", start)
    if start != -1 and end != -1:
        position_text = detail[start : end + 1]
        memory.note("shelter", position_text)
        if longterm is not None:
            longterm.upsert(
                {
                    "type": "place",
                    "key": "shelter",
                    "value": detail,
                    "pos": parse_position(position_text),
                    "importance": 5,
                }
            )


async def run(config: Config, mock: bool) -> Path:
    observation_validator, tools = validate_schemas()
    rotate_episode_logs(ROOT / "logs")
    memory = MemoryManager(ROOT / "state" / "brain_state.json")
    longterm = LongTermStore(ROOT / "state" / "longterm.json")
    reached_milestones = {
        str(record.get("key"))
        for record in longterm.records
        if record.get("type") == "achievement" and record.get("key") is not None
    }
    planner: Any = MockPolicy() if mock else LLMPlanner(config, tools)
    memory_planner = planner if hasattr(planner, "summarize_events") else None
    log_path = ROOT / "logs" / f"episode_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.jsonl"
    uri = f"ws://127.0.0.1:{config.ws_port}"
    deadline = asyncio.get_running_loop().time() + config.episode_time_limit_minutes * 60

    print_step("connecting", ws=uri, llm=config.llm_base_url, model=config.llm_model, mock=mock)
    async with websockets.connect(uri, ping_interval=None, close_timeout=5) as websocket:
        client = BotClient(websocket, memory, memory_planner, longterm)
        await client.wait_for_spawn()
        await memory.add_event("spawned", memory_planner)
        print_step("spawned")

        while asyncio.get_running_loop().time() < deadline:
            raw_observation = await client.observation()
            errors = sorted(observation_validator.iter_errors(raw_observation), key=lambda err: err.path)
            if errors:
                await memory.add_event(f"schema warning: {errors[0].message}", memory_planner)
            position = raw_observation.get("status", {}).get("position", [0, 0, 0])
            memory.set_longterm([format_record(record) for record in longterm.retrieve(position, memory.goal, k=5)])
            observation = memory.merge_observation(raw_observation)
            clear_satisfied_pending_craft(observation, memory)
            observation = memory.merge_observation(raw_observation)
            await record_new_milestones(observation, reached_milestones, memory, longterm, memory_planner)
            observation = memory.merge_observation(raw_observation)
            progress = curriculum_status(observation)

            if isinstance(planner, LLMPlanner):
                planner.history_summary = memory.history_summary
            call, raw_response = await planner.decide(
                observation,
                progress.stage,
                progress.next_milestone,
                progress.hint,
            )
            print_step(
                "decision",
                tool=call.tool,
                args=call.args,
                stage=progress.stage,
                pos=observation.status.position,
                hp=observation.status.health,
                hunger=observation.status.hunger,
                time=observation.status.time,
                danger=observation.status.danger_flags,
            )
            result = await execute_local_meta(call, memory)
            if result is None:
                result = await client.dispatch(call, config.heartbeat_seconds)
            print_step("result", tool=call.tool, status=result.status, detail=result.detail)
            update_pending_craft(call, result, memory)
            maybe_pin_shelter(call, result, memory, longterm)
            await memory.add_event(f"{call.tool} {result.status}: {result.detail}", memory_planner)

            write_log(
                log_path,
                {
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "observation": observation.model_dump(mode="json"),
                    "llm_response": slim_llm_response(raw_response),
                    "tool": call.tool,
                    "args": call.args,
                    "result": result.model_dump(),
                },
            )

            if call.tool == "chat" and "survived night 1" in str(call.args.get("message", "")):
                break
            if call.tool == "stop":
                await asyncio.sleep(config.heartbeat_seconds)

    return log_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="QwenCraft brain process")
    parser.add_argument("--config", type=Path, default=ROOT / "config.yaml")
    parser.add_argument("--mock", action="store_true", help="Use scripted milestone policy instead of an LLM")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    config = load_config(args.config)
    try:
        log_path = asyncio.run(run(config, args.mock))
    except BotConnectionError as exc:
        print(f"Bot connection failed: {exc}", file=sys.stderr)
        print("", file=sys.stderr)
        print("Make sure the bot process is still running:", file=sys.stderr)
        print("  cd bot && npm start", file=sys.stderr)
        raise SystemExit(2) from exc
    except LLMConnectionError as exc:
        print(f"LLM connection failed: {exc}", file=sys.stderr)
        print("", file=sys.stderr)
        print("For your GGUF model, start llama.cpp first, for example:", file=sys.stderr)
        print(
            "  llama-server -m /home/seant/Documents/LocalLLM/Qwen3.5-9B-Q8_0.gguf "
            "--host 127.0.0.1 --port 8080 -c 8192 --jinja",
            file=sys.stderr,
        )
        print("", file=sys.stderr)
        print("Or test the bot/brain loop without an LLM:", file=sys.stderr)
        print("  uv run python -m brain.main --mock", file=sys.stderr)
        raise SystemExit(2) from exc
    print(f"episode log: {log_path}")


if __name__ == "__main__":
    main()
