import asyncio

from brain.memory import MAX_EVENT_CHARS, MAX_HISTORY_CHARS, MemoryManager


class CompressingPlanner:
    def __init__(self, compressed: str = "compressed") -> None:
        self.compressed = compressed
        self.seen = ""

    async def summarize_events(self, events: list[str]) -> str:
        return "summary " + ("x" * 1300)

    async def compress_history(self, text: str) -> str:
        self.seen = text
        return self.compressed


def test_event_strings_are_capped_at_200_chars():
    memory = MemoryManager()

    asyncio.run(memory.add_event("a" * 300))

    assert len(memory.recent_events[0]) == MAX_EVENT_CHARS
    assert memory.recent_events[0].endswith("…")


def test_history_budget_uses_planner_compression():
    memory = MemoryManager()
    planner = CompressingPlanner("short history")

    for index in range(16):
        asyncio.run(memory.add_event(f"event {index}", planner))

    assert planner.seen
    assert memory.history_summary == "short history"


def test_history_budget_falls_back_to_final_1200_chars():
    memory = MemoryManager()
    planner = CompressingPlanner("y" * 601)

    for index in range(16):
        asyncio.run(memory.add_event(f"event {index}", planner))

    assert len(memory.history_summary) == MAX_HISTORY_CHARS
    assert memory.history_summary == planner.seen[-MAX_HISTORY_CHARS:]


def test_brain_state_persists_goal_pins_and_history(tmp_path):
    path = tmp_path / "brain_state.json"
    memory = MemoryManager(path)
    memory.set_goal("reach iron")
    memory.note("shelter", "[1,2,3]")
    memory.set_pending_craft("wooden_pickaxe", 1, "no crafting_table nearby")
    memory.history_summary = "crafted table"
    memory._save_state()

    loaded = MemoryManager(path)

    assert loaded.goal == "reach iron"
    assert loaded.pinned == {"shelter": "[1,2,3]"}
    assert loaded.pending_craft == {"item": "wooden_pickaxe", "count": 1, "reason": "no crafting_table nearby"}
    assert loaded.history_summary == "crafted table"
