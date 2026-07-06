from __future__ import annotations

import json
import math
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Callable

Record = dict[str, Any]


def atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=True, indent=2, sort_keys=True), encoding="utf8")
    os.replace(tmp, path)


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9_]+", text.lower()))


def _distance(a: list[float] | tuple[float, float, float], b: list[float] | tuple[float, float, float]) -> float:
    return math.sqrt(sum((float(left) - float(right)) ** 2 for left, right in zip(a, b, strict=True)))


class LongTermStore:
    def __init__(self, path: Path, clock: Callable[[], float] | None = None, max_records: int = 200) -> None:
        self.path = path
        self.clock = clock or time.time
        self.max_records = max_records
        self.records: list[Record] = []
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            self.records = []
            return
        data = json.loads(self.path.read_text(encoding="utf8"))
        if isinstance(data, list):
            self.records = [dict(record) for record in data]
        else:
            self.records = []

    def upsert(self, record: Record) -> Record:
        now = self.clock()
        normalized = dict(record)
        normalized["id"] = str(normalized.get("id") or uuid.uuid4())
        normalized["created_ts"] = float(normalized.get("created_ts", now))
        normalized["last_used_ts"] = float(normalized.get("last_used_ts", now))
        normalized["importance"] = int(normalized.get("importance", 1))
        normalized["pos"] = list(normalized["pos"]) if normalized.get("pos") is not None else None

        replacement_index = next(
            (
                index
                for index, current in enumerate(self.records)
                if current.get("type") == normalized.get("type") and current.get("key") == normalized.get("key")
            ),
            None,
        )
        if replacement_index is not None:
            existing = self.records[replacement_index]
            normalized["id"] = str(record.get("id") or existing.get("id") or normalized["id"])
            normalized["created_ts"] = float(record.get("created_ts", existing.get("created_ts", normalized["created_ts"])))
            self.records[replacement_index] = {**existing, **normalized}
        else:
            self.records.append(normalized)

        self._evict()
        self._write()
        return normalized

    def retrieve(self, position: list[float] | tuple[float, float, float], goal_text: str, k: int = 5) -> list[Record]:
        goal_tokens = _tokens(goal_text)
        scored: list[tuple[float, float, Record]] = []
        for record in self.records:
            importance = float(record.get("importance", 1))
            if record.get("type") == "place" and record.get("pos") is not None:
                score = importance / (1 + _distance(position, record["pos"]) / 100)
            else:
                record_tokens = _tokens(f"{record.get('key', '')} {record.get('value', '')}")
                score = float(len(goal_tokens & record_tokens))
            scored.append((score, float(record.get("last_used_ts", 0)), record))

        selected = [record for _, _, record in sorted(scored, key=lambda item: (item[0], item[1]), reverse=True)[:k]]
        if selected:
            now = self.clock()
            selected_ids = {record.get("id") for record in selected}
            for record in self.records:
                if record.get("id") in selected_ids:
                    record["last_used_ts"] = now
            self._write()
        return [dict(record) for record in selected]

    def _evict(self) -> None:
        while len(self.records) > self.max_records:
            victim = min(range(len(self.records)), key=lambda index: (self.records[index].get("importance", 1), self.records[index].get("last_used_ts", 0)))
            self.records.pop(victim)

    def _write(self) -> None:
        atomic_write_json(self.path, self.records)


def format_record(record: Record) -> str:
    kind = str(record.get("type", "fact"))
    key = str(record.get("key", ""))
    value = str(record.get("value", ""))
    pos = record.get("pos")
    if pos is not None:
        return f"{kind} {key} [{int(pos[0])},{int(pos[1])},{int(pos[2])}]"
    return f"{kind} {key}: {value}"
