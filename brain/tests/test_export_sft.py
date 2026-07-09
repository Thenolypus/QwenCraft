import json
import sys

from brain.models import Inventory, MemorySnapshot, Observation, Status
from brain.prompts import build_user_prompt, system_prompt_with_history
from eval.export_sft import export_examples, main, read_jsonl, render_messages


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
        inventory=Inventory(held="oak_log", items={"oak_log": 4}, free_slots=32, armor=(None, None, None, None)),
        entities=[],
        blocks_of_interest=[],
        last_action=None,
        memory=MemorySnapshot(goal="Survive as many nights as possible.", pinned={}, recent_events=["spawned"]),
    )


def make_components(observation: Observation, history_summary: str = "explored the spawn area") -> dict:
    return {
        "observation": observation.model_dump(mode="json"),
        "goal": observation.memory.goal,
        "stage": "first_wood",
        "next_milestone": "wooden_pickaxe",
        "hint": "craft a wooden pickaxe",
        "history_summary": history_summary,
    }


def test_render_messages_matches_llmplanner_prompt_construction():
    observation = make_observation()
    components = make_components(observation)

    # Same fixture, built through LLMPlanner.decide's own message construction.
    expected = [
        {"role": "system", "content": system_prompt_with_history(components["history_summary"])},
        {
            "role": "user",
            "content": build_user_prompt(
                observation,
                observation.memory.goal,
                components["stage"],
                components["next_milestone"],
                components["hint"],
            ),
        },
    ]

    # Round-trip components through real JSON text, as they would be read back from a decisions file.
    serialized = json.loads(json.dumps(components, ensure_ascii=True))
    actual = render_messages(serialized)

    assert actual == expected


def test_export_examples_labels_success_failure_and_footer_outcome(tmp_path):
    observation = make_observation()
    components = make_components(observation)
    decision_success = {
        "type": "decision",
        "components": components,
        "completion": {"tool_calls": [{"function": {"name": "mine_block", "arguments": "{}"}}]},
        "tool_call": {"tool": "mine_block", "args": {"type": "oak_log", "count": 4}},
        "fallback": False,
        "result": {"status": "success", "detail": "mined 4 oak_log"},
        "interrupt": None,
    }
    decision_failed = {
        **decision_success,
        "tool_call": {"tool": "craft", "args": {"item": "wooden_pickaxe", "count": 1}},
        "result": {"status": "failed", "detail": "craft failed: missing crafting_table"},
    }
    footer = {"type": "footer", "outcome": {"milestones_reached": ["first_wood"], "deaths": 1, "nights_survived": 1}}

    path = tmp_path / "decisions_test.jsonl"
    path.write_text(
        "\n".join(json.dumps(row) for row in (decision_success, decision_failed, footer)) + "\n",
        encoding="utf8",
    )

    examples = export_examples(read_jsonl(path))

    assert len(examples) == 2
    assert examples[0]["messages"][-1] == {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": "call_0",
                "type": "function",
                "function": {"name": "mine_block", "arguments": json.dumps({"type": "oak_log", "count": 4})},
            }
        ],
    }
    assert examples[0]["label"] == {
        "status": "success",
        "milestones_reached": ["first_wood"],
        "deaths": 1,
        "nights_survived": 1,
    }
    assert examples[1]["label"]["status"] == "failed"
    assert examples[1]["label"]["failure_detail"] == "craft failed: missing crafting_table"
    assert examples[1]["label"]["milestones_reached"] == ["first_wood"]


def test_render_messages_appends_recorded_prompt_extras():
    observation = make_observation()
    components = make_components(observation)
    components["extras"] = [
        "CRITIC (previous mine_block failure): timeout — too far. Lesson: mine closer trees",
        "BLOCKED: mine_block({...}) failed 2x in a row (timed out). Choose a different tool, target, or approach.",
    ]

    messages = render_messages(json.loads(json.dumps(components, ensure_ascii=True)))

    user_prompt = messages[1]["content"]
    assert user_prompt.endswith("\n\n" + "\n".join(components["extras"]))


def test_export_examples_labels_critic_and_tolerates_records_without_it(tmp_path):
    observation = make_observation()
    components = make_components(observation)
    critic = {"verdict": "timeout", "explanation": "too far", "lesson": "mine closer trees"}
    with_critic = {
        "type": "decision",
        "components": components,
        "completion": {"tool_calls": []},
        "tool_call": {"tool": "mine_block", "args": {"type": "oak_log", "count": 10}},
        "fallback": False,
        "result": {"status": "failed", "detail": "mine_block failed: timed out after 120s"},
        "interrupt": None,
        "critic": critic,
    }
    # Pre-v2.4 record: no critic key at all.
    without_critic = {
        "type": "decision",
        "components": components,
        "completion": {"tool_calls": []},
        "tool_call": {"tool": "stop", "args": {}},
        "fallback": False,
        "result": {"status": "success", "detail": "ok"},
        "interrupt": None,
    }
    path = tmp_path / "decisions_test.jsonl"
    path.write_text(
        "\n".join(json.dumps(row) for row in (with_critic, without_critic)) + "\n",
        encoding="utf8",
    )

    examples = export_examples(read_jsonl(path))

    assert examples[0]["label"]["critic"] == critic
    assert "critic" not in examples[1]["label"]


def test_export_examples_tolerates_missing_footer(tmp_path):
    observation = make_observation()
    decision = {
        "type": "decision",
        "components": make_components(observation),
        "completion": {"tool_calls": []},
        "tool_call": {"tool": "stop", "args": {}},
        "fallback": False,
        "result": {"status": "success", "detail": "ok"},
        "interrupt": None,
    }
    path = tmp_path / "decisions_test.jsonl"
    path.write_text(json.dumps(decision) + "\n", encoding="utf8")

    examples = export_examples(read_jsonl(path))

    assert len(examples) == 1
    assert examples[0]["label"] == {"status": "success"}


def test_main_prints_one_json_line_per_decision(tmp_path, monkeypatch, capsys):
    observation = make_observation()
    decision = {
        "type": "decision",
        "components": make_components(observation),
        "completion": {"tool_calls": []},
        "tool_call": {"tool": "stop", "args": {}},
        "fallback": False,
        "result": {"status": "success", "detail": "ok"},
        "interrupt": None,
    }
    footer = {"type": "footer", "outcome": {"milestones_reached": [], "deaths": 0, "nights_survived": 0}}
    path = tmp_path / "decisions_test.jsonl"
    path.write_text("\n".join(json.dumps(row) for row in (decision, footer)) + "\n", encoding="utf8")

    monkeypatch.setattr(sys, "argv", ["export_sft", str(path)])
    main()

    out_lines = capsys.readouterr().out.strip().splitlines()
    assert len(out_lines) == 1
    example = json.loads(out_lines[0])
    assert example["label"]["status"] == "success"
