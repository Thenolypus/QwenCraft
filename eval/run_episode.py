from __future__ import annotations

import argparse
import json
import os
import signal
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
FOOD_ITEMS = {
    "apple",
    "baked_potato",
    "beef",
    "bread",
    "carrot",
    "chicken",
    "cod",
    "cooked_beef",
    "cooked_chicken",
    "cooked_cod",
    "cooked_mutton",
    "cooked_porkchop",
    "cooked_salmon",
    "melon_slice",
    "mutton",
    "porkchop",
    "salmon",
    "sweet_berries",
}


def load_config(path: Path) -> dict[str, Any]:
    return yaml.safe_load(path.read_text())


def compose_command() -> list[str]:
    docker = shutil.which("docker")
    if docker:
        probe = subprocess.run([docker, "compose", "version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            return [docker, "compose"]
    legacy = shutil.which("docker-compose")
    if legacy:
        return [legacy]
    raise RuntimeError("Docker Compose not found. Install the Docker Compose v2 plugin or legacy docker-compose.")


def start_process(command: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.Popen[str]:
    return subprocess.Popen(
        command,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        preexec_fn=os.setsid if hasattr(os, "setsid") else None,
    )


def terminate(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        if hasattr(os, "killpg"):
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        else:
            process.terminate()
        process.wait(timeout=10)
    except Exception:
        process.kill()


def latest_log(before: set[Path]) -> Path:
    logs = set((ROOT / "logs").glob("episode_*.jsonl")) - before
    if not logs:
        raise AssertionError("no episode log was created")
    return max(logs, key=lambda path: path.stat().st_mtime)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    final_obs = rows[-1]["observation"] if rows else {}
    inventory = final_obs.get("inventory", {}).get("items", {})
    row_inventories = [row["observation"]["inventory"]["items"] for row in rows]
    row_pins = [row["observation"]["memory"].get("pinned", {}) for row in rows]
    sheltered = any("shelter" in pinned for pinned in row_pins) or any(
        row["tool"] == "build_shelter" and row["result"]["status"] == "success" for row in rows
    )
    furnace_and_fuel = any(
        (inv.get("furnace", 0) >= 1 or "furnace" in pinned)
        and (inv.get("coal", 0) >= 1 or inv.get("charcoal", 0) >= 1)
        for inv, pinned in zip(row_inventories, row_pins, strict=True)
    )
    milestones = {
        "first_wood": any(any(name.endswith("_log") and count > 0 for name, count in inv.items()) for inv in row_inventories),
        "wooden_pickaxe": any(inv.get("wooden_pickaxe", 0) > 0 for inv in row_inventories),
        "stone_tools": any(inv.get("stone_pickaxe", 0) > 0 for inv in row_inventories),
        "sheltered": sheltered,
        "furnace_and_fuel": furnace_and_fuel,
        "iron_ingot": any(inv.get("iron_ingot", 0) > 0 for inv in row_inventories),
        "iron_gear": any(inv.get("iron_pickaxe", 0) > 0 and inv.get("iron_sword", 0) > 0 for inv in row_inventories),
        "food_buffer": any(sum(count for name, count in inv.items() if name in FOOD_ITEMS) >= 8 for inv in row_inventories),
        "shelter": sheltered,
        "iron": any("iron" in name for name in inventory),
    }
    deaths = 0
    previous_events: list[str] = []
    for row in rows:
        events = row["observation"]["memory"]["recent_events"]
        deaths += sum(1 for event in events if "death" in event and event not in previous_events)
        previous_events = events
    tool_errors = sum(1 for row in rows if row["result"]["status"] == "failed")
    return {
        "nights_survived": 1 if any(row["tool"] == "chat" and "survived night 1" in row["args"].get("message", "") for row in rows) else 0,
        "deaths": deaths,
        "final_inventory": inventory,
        "milestones": milestones,
        "tool_call_error_rate": tool_errors / max(1, len(rows)),
    }


def run_episode(mock: bool, seed: int, timeout_minutes: int, mc_version: str | None) -> dict[str, Any]:
    config = load_config(ROOT / "config.yaml")
    env = os.environ.copy()
    env["SEED"] = str(seed)
    if mc_version:
        env["MC_VERSION"] = mc_version
    else:
        env["MC_VERSION"] = str(config["mc_version"])

    subprocess.run([*compose_command(), "up", "-d"], cwd=ROOT, env=env, check=True)
    existing_logs = set((ROOT / "logs").glob("episode_*.jsonl"))
    bot = start_process(["npm", "start"], ROOT / "bot", env)
    brain_args = [sys.executable, "main.py"]
    if mock:
        brain_args.append("--mock")
    brain = start_process(brain_args, ROOT / "brain", env)

    try:
        deadline = time.time() + timeout_minutes * 60
        while time.time() < deadline:
            if brain.poll() is not None:
                break
            time.sleep(2)
        if brain.poll() is None:
            raise TimeoutError(f"episode timed out after {timeout_minutes} minutes")
        log_path = latest_log(existing_logs)
        rows = read_jsonl(log_path)
        result = metrics(rows)
        final_obs = rows[-1]["observation"]
        assert result["deaths"] == 0, "bot died during episode"
        assert result["nights_survived"] >= 1, "bot did not survive to sunrise"
        assert final_obs["inventory"]["items"].get("wooden_pickaxe", 0) >= 1, "wooden_pickaxe missing at end"
        return result
    finally:
        terminate(brain)
        terminate(bot)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a seeded QwenCraft episode.")
    parser.add_argument("--mock", action="store_true", help="Use scripted mock LLM")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--timeout-minutes", type=int, default=35)
    parser.add_argument("--mc-version", default=None, help="Override docker server version, e.g. 1.21.11 for compatibility")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = run_episode(args.mock, args.seed, args.timeout_minutes, args.mc_version)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
