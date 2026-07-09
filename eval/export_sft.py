from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

if __package__ in {None, ""}:
    sys.path.append(str(Path(__file__).resolve().parents[1]))
    __package__ = "eval"

from brain.models import Observation
from brain.prompts import apply_prompt_extras, build_user_prompt, system_prompt_with_history


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf8").splitlines() if line.strip()]


def render_messages(components: dict[str, Any]) -> list[dict[str, str]]:
    """Re-render the exact messages LLMPlanner.decide would have sent, from
    recorded components only (no rendered prompt text is ever stored)."""
    observation = Observation.model_validate(components["observation"])
    user_prompt = apply_prompt_extras(
        build_user_prompt(
            observation,
            components["goal"],
            components["stage"],
            components["next_milestone"],
            components["hint"],
        ),
        # "extras" is absent on pre-v2.4 records.
        components.get("extras") or [],
    )
    return [
        {"role": "system", "content": system_prompt_with_history(components["history_summary"])},
        {"role": "user", "content": user_prompt},
    ]


def tool_call_message(tool_call: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": "call_0",
                "type": "function",
                "function": {
                    "name": tool_call["tool"],
                    "arguments": json.dumps(tool_call["args"], ensure_ascii=True),
                },
            }
        ],
    }


def build_label(result: dict[str, Any], outcome: dict[str, Any] | None, critic: dict[str, Any] | None = None) -> dict[str, Any]:
    label: dict[str, Any] = {"status": result.get("status")}
    if label["status"] != "success":
        label["failure_detail"] = result.get("detail")
    if critic:
        label["critic"] = critic
    if outcome is not None:
        label.update(outcome)
    return label


def export_examples(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    footer = next((record for record in records if record.get("type") == "footer"), None)
    outcome = footer.get("outcome") if footer is not None else None

    examples = []
    for record in records:
        if record.get("type") != "decision":
            continue
        messages = render_messages(record["components"]) + [tool_call_message(record["tool_call"])]
        label = build_label(record.get("result") or {}, outcome, record.get("critic"))
        examples.append({"messages": messages, "label": label})
    return examples


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert one episode's decision records into chat-format SFT examples.")
    parser.add_argument("decisions_path", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    records = read_jsonl(args.decisions_path)
    for example in export_examples(records):
        print(json.dumps(example, ensure_ascii=True))


if __name__ == "__main__":
    main()
