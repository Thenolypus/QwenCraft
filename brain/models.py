from __future__ import annotations

import json
from collections import OrderedDict
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field


Direction = Literal["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
# connection_lost: brain-side hardening status for a decision whose dispatch
# never got a tool_result because the bot process/connection died mid-call.
ToolStatus = Literal["success", "failed", "interrupted", "connection_lost"]


def canonical_args(args: dict[str, Any]) -> str:
    """Stable JSON form of a tool call's args, used as part of its identity
    for consecutive-failure tracking (the loop-breaker)."""
    return json.dumps(args, sort_keys=True, default=str)


class Config(BaseModel):
    mc_host: str = "127.0.0.1"
    mc_port: int = 25565
    mc_version: str = "1.21.11"
    bot_username: str = "QwenCraft"
    ws_port: int = 8765
    llm_base_url: str = "http://127.0.0.1:8000/v1"
    llm_api_key: str = "EMPTY"
    llm_model: str = "Qwen/Qwen3.5-9B-Instruct"
    enable_thinking: bool = False
    temperature: float = 0.2
    heartbeat_seconds: int = 10
    scan_radius_blocks: int = 32
    entity_radius_blocks: int = 24
    block_whitelist: list[str] = Field(default_factory=list)
    viewer_enabled: bool = False
    episode_time_limit_minutes: int = 30


class LastAction(BaseModel):
    tool: str
    args: dict[str, Any]
    status: ToolStatus
    detail: str


class Status(BaseModel):
    position: tuple[int, int, int]
    health: float
    hunger: float
    oxygen: float
    time: Literal["day", "sunset", "night", "sunrise"]
    minutes_to_night: float
    weather: Literal["clear", "rain", "thunder"]
    biome: str
    light: int
    danger_flags: list[str]


class Inventory(BaseModel):
    held: str | None
    items: dict[str, int]
    free_slots: int
    armor: tuple[str | None, str | None, str | None, str | None]


class EntityObservation(BaseModel):
    type: str
    dist: float
    dir: Direction
    hostile: bool


class BlockObservation(BaseModel):
    type: str
    nearest_dist: float
    pos: tuple[int, int, int]
    count_in_range: int


class MemorySnapshot(BaseModel):
    goal: str
    pinned: dict[str, Any]
    recent_events: list[str]
    longterm: list[str] | None = None
    pending_craft: dict[str, Any] | None = None


class Observation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Status
    inventory: Inventory
    entities: list[EntityObservation]
    blocks_of_interest: list[BlockObservation]
    last_action: LastAction | None
    memory: MemorySnapshot


class ToolCall(BaseModel):
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)

    def key(self) -> tuple[str, str]:
        """Identity used to detect repeated identical calls (loop-breaker)."""
        return (self.tool, canonical_args(self.args))


class ToolResult(BaseModel):
    status: ToolStatus
    detail: str


def load_config(path: Path) -> Config:
    data = yaml.safe_load(path.read_text()) if path.exists() else {}
    return Config.model_validate(data or {})


def ordered_pinned(initial: dict[str, Any] | None = None) -> OrderedDict[str, Any]:
    return OrderedDict(initial or {})
