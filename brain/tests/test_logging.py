import gzip
import json
import os

from brain.main import rotate_episode_logs, slim_llm_response


def test_rotate_episode_logs_gzips_jsonl_and_keeps_newest_archives(tmp_path):
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    old_jsonl = log_dir / "episode_1.jsonl"
    new_jsonl = log_dir / "episode_2.jsonl"
    old_archive = log_dir / "episode_0.jsonl.gz"
    old_jsonl.write_text('{"old": true}\n', encoding="utf8")
    new_jsonl.write_text('{"new": true}\n', encoding="utf8")
    with gzip.open(old_archive, "wt", encoding="utf8") as handle:
        handle.write('{"archive": true}\n')
    os.utime(old_archive, (1, 1))
    os.utime(old_jsonl, (2, 2))
    os.utime(new_jsonl, (3, 3))

    rotate_episode_logs(log_dir, keep_archives=2)

    assert not old_jsonl.exists()
    assert not new_jsonl.exists()
    archives = sorted(path.name for path in log_dir.glob("episode_*.jsonl.gz"))
    assert archives == ["episode_1.jsonl.gz", "episode_2.jsonl.gz"]
    with gzip.open(log_dir / "episode_2.jsonl.gz", "rt", encoding="utf8") as handle:
        assert json.loads(handle.readline()) == {"new": True}


def test_slim_llm_response_keeps_only_message_and_usage_without_nulls():
    raw = {
        "id": "chatcmpl",
        "choices": [
            {
                "message": {
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "function": {"name": "stop", "arguments": "{}", "ignored": None},
                            "type": "function",
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": None},
        "timings": {"prompt_ms": 1},
    }

    assert slim_llm_response(raw) == {
        "tool_calls": [{"id": "call_1", "function": {"name": "stop", "arguments": "{}"}, "type": "function"}],
        "usage": {"prompt_tokens": 1},
    }
