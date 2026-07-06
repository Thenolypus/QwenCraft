from types import SimpleNamespace

from brain.main import clear_satisfied_pending_craft, update_pending_craft
from brain.memory import MemoryManager
from brain.models import ToolCall, ToolResult


def test_pending_craft_keeps_original_goal_through_dependency_work():
    memory = MemoryManager()

    update_pending_craft(
        ToolCall(tool="craft", args={"item": "wooden_pickaxe", "count": 1}),
        ToolResult(status="failed", detail="craft failed: no crafting_table nearby (craft or place one)"),
        memory,
    )
    update_pending_craft(
        ToolCall(tool="craft", args={"item": "crafting_table", "count": 1}),
        ToolResult(status="failed", detail="craft failed: missing 4 oak_planks"),
        memory,
    )
    update_pending_craft(
        ToolCall(tool="craft", args={"item": "crafting_table", "count": 1}),
        ToolResult(status="success", detail="crafted 1 crafting_table"),
        memory,
    )

    assert memory.pending_craft == {
        "item": "wooden_pickaxe",
        "count": 1,
        "reason": "no crafting_table nearby (craft or place one)",
    }

    update_pending_craft(
        ToolCall(tool="craft", args={"item": "wooden_pickaxe", "count": 1}),
        ToolResult(status="success", detail="crafted 1 wooden_pickaxe"),
        memory,
    )

    assert memory.pending_craft is None


def test_satisfied_pending_craft_clears_from_observation_inventory():
    memory = MemoryManager()
    memory.set_pending_craft("stone_pickaxe", 1, "missing 3 cobblestone")
    observation = SimpleNamespace(inventory=SimpleNamespace(items={"stone_pickaxe": 1}))

    clear_satisfied_pending_craft(observation, memory)

    assert memory.pending_craft is None
