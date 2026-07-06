from brain.curriculum import curriculum_status
from brain.models import Observation


def observation(items: dict[str, int] | None = None, pinned: dict[str, str] | None = None) -> Observation:
    return Observation.model_validate(
        {
            "status": {
                "position": [0, 64, 0],
                "health": 20,
                "hunger": 20,
                "oxygen": 20,
                "time": "day",
                "minutes_to_night": 5,
                "weather": "clear",
                "biome": "plains",
                "light": 15,
                "danger_flags": [],
            },
            "inventory": {
                "held": None,
                "items": items or {},
                "free_slots": 36,
                "armor": [None, None, None, None],
            },
            "entities": [],
            "blocks_of_interest": [],
            "last_action": None,
            "memory": {
                "goal": "progress",
                "pinned": pinned or {},
                "recent_events": [],
            },
        }
    )


def test_curriculum_starts_at_first_wood():
    status = curriculum_status(observation())

    assert status.stage == "first_wood"
    assert status.next_milestone == "first_wood"
    assert status.satisfied == []


def test_curriculum_advances_through_satisfied_predicates():
    status = curriculum_status(
        observation(
            {
                "spruce_log": 2,
                "wooden_pickaxe": 1,
                "stone_pickaxe": 1,
                "furnace": 1,
                "coal": 1,
            },
            {"shelter": "[0,64,0]"},
        )
    )

    assert status.satisfied == ["first_wood", "wooden_pickaxe", "stone_tools", "sheltered", "furnace_and_fuel"]
    assert status.stage == "iron_ingot"


def test_curriculum_detects_iron_gear_and_food_buffer():
    status = curriculum_status(
        observation(
            {
                "oak_log": 1,
                "wooden_pickaxe": 1,
                "stone_pickaxe": 1,
                "furnace": 1,
                "charcoal": 1,
                "iron_ingot": 1,
                "iron_pickaxe": 1,
                "iron_sword": 1,
                "bread": 8,
            },
            {"shelter": "[0,64,0]"},
        )
    )

    assert status.stage == "complete"
    assert "food_buffer" in status.satisfied
