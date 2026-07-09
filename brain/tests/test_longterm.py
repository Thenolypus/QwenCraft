import json

from brain.longterm import LongTermStore, atomic_write_json, category_for_record, format_record


def test_longterm_evicts_lowest_importance_then_oldest(tmp_path):
    store = LongTermStore(tmp_path / "longterm.json", max_records_per_category=2)
    store.upsert({"type": "fact", "key": "old_low", "value": "a", "importance": 1, "last_used_ts": 1})
    store.upsert({"type": "fact", "key": "new_low", "value": "b", "importance": 1, "last_used_ts": 2})
    store.upsert({"type": "fact", "key": "high", "value": "c", "importance": 5, "last_used_ts": 0})

    assert {record["key"] for record in store.records} == {"new_low", "high"}


def test_longterm_retrieves_nearest_place(tmp_path):
    store = LongTermStore(tmp_path / "longterm.json")
    store.upsert({"type": "place", "key": "far_shelter", "value": "far", "pos": [500, 64, 0], "importance": 5})
    store.upsert({"type": "place", "key": "near_shelter", "value": "near", "pos": [10, 64, 0], "importance": 5})

    records = store.retrieve([0, 64, 0], "find shelter", k=1)

    assert records[0]["key"] == "near_shelter"
    assert format_record(records[0]) == "place near_shelter [10,64,0]"


def test_longterm_persistence_round_trip(tmp_path):
    path = tmp_path / "longterm.json"
    store = LongTermStore(path)
    store.upsert({"type": "death", "key": "last_death", "value": "fell", "pos": [1, 2, 3], "importance": 4})

    loaded = LongTermStore(path)

    assert loaded.records[0]["type"] == "death"
    assert loaded.records[0]["pos"] == [1, 2, 3]


def test_atomic_write_temp_without_rename_leaves_old_file_intact(tmp_path):
    path = tmp_path / "longterm.json"
    atomic_write_json(path, [{"key": "old"}])
    path.with_name(f"{path.name}.tmp").write_text(json.dumps([{"key": "new"}]), encoding="utf8")

    loaded = LongTermStore(path)

    assert loaded.records == [{"key": "old"}]


def test_kinds_map_to_knowledge_or_experience():
    assert category_for_record({"type": "fact"}) == "knowledge"
    assert category_for_record({"type": "lesson"}) == "knowledge"
    for kind in ("place", "death", "achievement", "shelter"):
        assert category_for_record({"type": kind}) == "experience"


def test_caps_and_eviction_stay_within_category(tmp_path):
    store = LongTermStore(tmp_path / "longterm.json", max_records_per_category=2)
    store.upsert({"type": "place", "key": "low_place", "value": "p1", "importance": 1, "last_used_ts": 1})
    store.upsert({"type": "place", "key": "high_place", "value": "p2", "importance": 5, "last_used_ts": 1})
    store.upsert({"type": "fact", "key": "fact_a", "value": "f1", "importance": 1, "last_used_ts": 1})
    store.upsert({"type": "fact", "key": "fact_b", "value": "f2", "importance": 1, "last_used_ts": 2})

    # A third fact overflows knowledge only; the low-importance place must survive.
    store.upsert({"type": "lesson", "key": "lesson_a", "value": "l1", "importance": 5, "last_used_ts": 3})

    keys = {record["key"] for record in store.records}
    assert "low_place" in keys and "high_place" in keys
    assert "fact_a" not in keys  # evicted within knowledge (lowest importance, oldest)
    assert "fact_b" in keys and "lesson_a" in keys


def test_migration_trims_legacy_200_record_file_per_category(tmp_path):
    path = tmp_path / "longterm.json"
    legacy = [
        {"type": "fact", "key": f"fact_{i}", "value": "v", "importance": 1 + i % 5, "last_used_ts": i, "id": f"f{i}"}
        for i in range(120)
    ] + [
        {"type": "place", "key": f"place_{i}", "value": "v", "pos": [i, 64, 0], "importance": 3, "last_used_ts": i, "id": f"p{i}"}
        for i in range(80)
    ]
    atomic_write_json(path, legacy)

    store = LongTermStore(path)

    knowledge = [record for record in store.records if category_for_record(record) == "knowledge"]
    experience = [record for record in store.records if category_for_record(record) == "experience"]
    assert len(knowledge) == 100  # trimmed by importance+recency eviction
    assert len(experience) == 80  # under its cap: no data loss
    # Trimmed state is persisted, so the next load does not re-migrate.
    on_disk = json.loads(path.read_text(encoding="utf8"))
    assert len(on_disk) == 180


def test_migration_keeps_legacy_file_within_caps_intact(tmp_path):
    path = tmp_path / "longterm.json"
    legacy = [
        {"type": "fact", "key": "f", "value": "v", "importance": 1, "id": "f0"},
        {"type": "death", "key": "last_death", "value": "fell", "pos": [1, 2, 3], "importance": 4, "id": "d0"},
    ]
    atomic_write_json(path, legacy)

    store = LongTermStore(path)

    assert store.records == legacy


def test_retrieval_returns_a_mix_of_both_categories(tmp_path):
    store = LongTermStore(tmp_path / "longterm.json")
    for i in range(5):
        store.upsert({"type": "place", "key": f"shelter_{i}", "value": "shelter", "pos": [i, 64, 0], "importance": 5})
        store.upsert({"type": "lesson", "key": f"lesson_{i}", "value": f"shelter lesson {i}", "importance": 5})

    records = store.retrieve([0, 64, 0], "build a shelter", k=5)

    categories = [category_for_record(record) for record in records]
    assert len(records) == 5
    assert categories.count("experience") == 3
    assert categories.count("knowledge") == 2


def test_retrieval_backfills_when_one_category_is_sparse(tmp_path):
    store = LongTermStore(tmp_path / "longterm.json")
    for i in range(5):
        store.upsert({"type": "place", "key": f"shelter_{i}", "value": "shelter", "pos": [i, 64, 0], "importance": 5})

    records = store.retrieve([0, 64, 0], "build a shelter", k=5)

    assert len(records) == 5
    assert all(category_for_record(record) == "experience" for record in records)
