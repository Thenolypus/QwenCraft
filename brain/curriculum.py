from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .models import Observation

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


@dataclass(frozen=True)
class Milestone:
    name: str
    hint: str
    predicate: Callable[[Observation], bool]


@dataclass(frozen=True)
class CurriculumStatus:
    stage: str
    next_milestone: str
    hint: str
    satisfied: list[str]


def item_count(observation: Observation, name: str) -> int:
    return observation.inventory.items.get(name, 0)


def has_logs(observation: Observation) -> bool:
    return any(name.endswith("_log") and count >= 1 for name, count in observation.inventory.items.items())


def has_shelter(observation: Observation) -> bool:
    return "shelter" in observation.memory.pinned


def has_furnace_and_fuel(observation: Observation) -> bool:
    has_furnace = item_count(observation, "furnace") >= 1 or "furnace" in observation.memory.pinned
    has_fuel = item_count(observation, "coal") >= 1 or item_count(observation, "charcoal") >= 1
    return has_furnace and has_fuel


def has_food_buffer(observation: Observation) -> bool:
    return sum(count for name, count in observation.inventory.items.items() if name in FOOD_ITEMS) >= 8


MILESTONES = [
    Milestone("first_wood", "gather logs", has_logs),
    Milestone("wooden_pickaxe", "craft a wooden pickaxe", lambda obs: item_count(obs, "wooden_pickaxe") >= 1),
    Milestone("stone_tools", "craft a stone pickaxe", lambda obs: item_count(obs, "stone_pickaxe") >= 1),
    Milestone("sheltered", "build or pin a shelter", has_shelter),
    Milestone("furnace_and_fuel", "secure a furnace with coal or charcoal", has_furnace_and_fuel),
    Milestone("iron_ingot", "smelt or collect an iron ingot", lambda obs: item_count(obs, "iron_ingot") >= 1),
    Milestone(
        "iron_gear",
        "craft an iron pickaxe and iron sword",
        lambda obs: item_count(obs, "iron_pickaxe") >= 1 and item_count(obs, "iron_sword") >= 1,
    ),
    Milestone("food_buffer", "hold at least 8 food items", has_food_buffer),
]


def curriculum_status(observation: Observation) -> CurriculumStatus:
    satisfied: list[str] = []
    for milestone in MILESTONES:
        if milestone.predicate(observation):
            satisfied.append(milestone.name)
            continue
        return CurriculumStatus(
            stage=milestone.name,
            next_milestone=milestone.name,
            hint=milestone.hint,
            satisfied=satisfied,
        )
    return CurriculumStatus(
        stage="complete",
        next_milestone="complete",
        hint="maintain supplies and improve the base",
        satisfied=[milestone.name for milestone in MILESTONES],
    )
