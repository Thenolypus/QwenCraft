import json

from brain.longterm import LongTermStore, atomic_write_json, format_record


def test_longterm_evicts_lowest_importance_then_oldest(tmp_path):
    store = LongTermStore(tmp_path / "longterm.json", max_records=2)
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
