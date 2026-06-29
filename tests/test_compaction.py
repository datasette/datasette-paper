"""Tests for step/snapshot compaction (instance.record_client_doc → compact_doc).

A snapshot at version V folds in every step with version <= V and supersedes
every earlier snapshot. ``record_client_doc`` prunes both after each snapshot
insert so ``_datasette_paper_step`` / ``_datasette_paper_snapshot`` don't grow
without bound. The doc must still materialize correctly afterwards, and a
stale-version client must still get the 410 (GoneError) → full re-bootstrap.
"""

from __future__ import annotations

import pytest

from datasette_paper.errors import GoneError
import datasette_paper.instance as instance_module
from datasette_paper.instance import Instance

from _steps import insert_at  # noqa: E402  (sibling helper)


async def _count(ds, sql, params):
    rows = (await ds.get_internal_database().execute(sql, params)).rows
    return rows[0][0]


@pytest.mark.asyncio
async def test_snapshot_prunes_superseded_steps_and_snapshots(ds_paper, monkeypatch):
    # Small threshold so a handful of edits crosses the snapshot cadence.
    monkeypatch.setattr(instance_module, "SNAPSHOT_THRESHOLD", 5)

    ds, db = ds_paper
    doc = await db.insert_doc(name="Compact me")
    inst = await Instance.hydrate(db, doc.id)

    # Drive past the threshold. insert_at(1) is position-stable so the doc
    # still materializes cleanly even after old steps are pruned.
    for _ in range(7):
        await inst.add_events(
            version=inst.version, client_id=1, actor_id="alice", steps=[insert_at(1)]
        )

    assert inst.version == 7
    # A snapshot landed at version 5 (the first crossing of the threshold).
    assert inst.snapshot_version == 5

    # Steps folded into the snapshot are gone; only steps > snapshot survive.
    surviving = (
        await ds.get_internal_database().execute(
            "SELECT version FROM _datasette_paper_step WHERE doc_id = ? ORDER BY version",
            [doc.id],
        )
    ).rows
    assert [r[0] for r in surviving] == [6, 7]
    assert (
        await _count(
            ds,
            "SELECT COUNT(*) FROM _datasette_paper_step WHERE doc_id = ? AND version <= ?",
            [doc.id, 5],
        )
        == 0
    )

    # Exactly one snapshot remains — the latest.
    snaps = (
        await ds.get_internal_database().execute(
            "SELECT version FROM _datasette_paper_snapshot WHERE doc_id = ?",
            [doc.id],
        )
    ).rows
    assert [r[0] for r in snaps] == [5]


@pytest.mark.asyncio
async def test_doc_still_materializes_after_compaction(ds_paper, monkeypatch):
    monkeypatch.setattr(instance_module, "SNAPSHOT_THRESHOLD", 5)

    ds, db = ds_paper
    doc = await db.insert_doc(name="Compact me")
    inst = await Instance.hydrate(db, doc.id)

    for _ in range(7):
        await inst.add_events(
            version=inst.version, client_id=1, actor_id="alice", steps=[insert_at(1)]
        )

    before = inst.materialize_live_doc()

    # Re-hydrate from the compacted log (snapshot + surviving steps only) and
    # confirm the materialized doc is byte-identical.
    fresh = await Instance.hydrate(db, doc.id)
    assert fresh.version == 7
    assert fresh.materialize_live_doc() == before
    # Body holds all 7 inserted characters.
    text = fresh.materialize_live_doc()["content"][0]["content"][0]["text"]
    assert len(text) == 7


@pytest.mark.asyncio
async def test_stale_client_gets_410_after_compaction(ds_paper, monkeypatch):
    monkeypatch.setattr(instance_module, "SNAPSHOT_THRESHOLD", 5)

    ds, db = ds_paper
    doc = await db.insert_doc(name="Compact me")
    inst = await Instance.hydrate(db, doc.id)

    for _ in range(7):
        await inst.add_events(
            version=inst.version, client_id=1, actor_id="alice", steps=[insert_at(1)]
        )

    # Re-hydrate: the tail now only covers steps after the snapshot (6, 7), so a
    # client asking for evicted history (version 0) gets GoneError → 410 →
    # full re-bootstrap. This is exactly what makes compaction safe.
    fresh = await Instance.hydrate(db, doc.id)
    assert len(fresh.steps_tail) == 2
    with pytest.raises(GoneError):
        fresh.get_events(since_version=0)
    with pytest.raises(GoneError):
        fresh.get_events(since_version=4)
    # The snapshot boundary (version 5) is the oldest still-available point, so
    # a client there catches up incrementally rather than being evicted.
    result = fresh.get_events(since_version=5)
    assert result is not None
    assert result["version"] == 7
    assert len(result["steps"]) == 2
