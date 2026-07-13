"""Tests for the profile activity rollup (`_datasette_paper_doc_activity`).

@feat profile-papers: durable per-(doc, actor) last-edited attribution backing
the profile "Papers" section. One row per (doc, actor), bumped on every
accepted step, surviving step compaction and purged on doc hard-delete.

Covers the data layer only (T01): the upsert on step insert, anonymous edits
not attributing, compaction survival, the migration backfill from surviving
history, and hard-delete purge. The endpoint + web component (T02+) land in
the follow-up PR with their own tests.
"""

import asyncio

import pytest
from datasette.app import Datasette
from sqlite_utils import Database

import datasette_paper.instance as instance_module
from datasette_paper.db import PaperDB
from datasette_paper.instance import Instance
from datasette_paper.migrations import ensure_migrations, migrations

from _steps import insert_at  # noqa: E402  (sibling helper)


async def make_paper_db() -> tuple[Datasette, PaperDB]:
    ds = Datasette(memory=True)
    internal = ds.get_internal_database()
    await ensure_migrations(internal)
    return ds, PaperDB(internal)


async def activity_rows(ds: Datasette, doc_id: int):
    """Return {actor_id: last_edited_at} for a doc's activity rows."""
    rows = (
        await ds.get_internal_database().execute(
            "SELECT actor_id, last_edited_at FROM _datasette_paper_doc_activity "
            "WHERE doc_id = ? ORDER BY actor_id",
            [doc_id],
        )
    ).rows
    return {r[0]: r[1] for r in rows}


@pytest.mark.asyncio
async def test_two_steps_same_actor_one_row_bumped():
    """Two edits by one actor collapse to a single row at the later time."""
    ds, paper = await make_paper_db()
    doc = await paper.insert_doc(name="Notes", created_by="alice")

    await paper.insert_step(
        doc_id=doc.id, client_id=1, actor_id="alice", step_json="{}"
    )
    first = (await activity_rows(ds, doc.id))["alice"]

    # Stamps are SQL-side with millisecond precision; a 2ms sleep guarantees
    # the second edit lands on a strictly later stamp.
    await asyncio.sleep(0.002)
    await paper.insert_step(
        doc_id=doc.id, client_id=1, actor_id="alice", step_json="{}"
    )

    rows = await activity_rows(ds, doc.id)
    assert set(rows) == {"alice"}
    assert rows["alice"] > first


@pytest.mark.asyncio
async def test_anonymous_step_records_no_activity():
    """A step with actor_id=None never attributes — no row appears."""
    ds, paper = await make_paper_db()
    doc = await paper.insert_doc(name="Notes")

    await paper.insert_step(doc_id=doc.id, client_id=1, actor_id=None, step_json="{}")

    assert await activity_rows(ds, doc.id) == {}


@pytest.mark.asyncio
async def test_activity_survives_compaction(monkeypatch):
    """Compaction prunes the step log but must leave activity intact — the
    whole point of the rollup. Drives real edits through Instance, whose
    write closure (not PaperDB.insert_step) is the live append path."""
    monkeypatch.setattr(instance_module, "SNAPSHOT_THRESHOLD", 5)

    ds, paper = await make_paper_db()
    doc = await paper.insert_doc(name="Compact me")
    inst = await Instance.hydrate(paper, doc.id)

    for _ in range(7):
        await inst.add_events(
            version=inst.version, client_id=1, actor_id="alice", steps=[insert_at(1)]
        )

    # Steps <= the snapshot version (5) are gone...
    surviving = (
        await ds.get_internal_database().execute(
            "SELECT COUNT(*) FROM _datasette_paper_step "
            "WHERE doc_id = ? AND version <= 5",
            [doc.id],
        )
    ).single_value()
    assert surviving == 0

    # ...but alice's activity row is still there.
    rows = await activity_rows(ds, doc.id)
    assert set(rows) == {"alice"}
    assert rows["alice"] is not None


@pytest.mark.asyncio
async def test_hard_delete_purges_activity():
    """Hard-deleting a doc removes its activity rows (no FK cascade)."""
    ds, paper = await make_paper_db()
    doc = await paper.insert_doc(name="Doomed", created_by="alice")
    await paper.insert_step(
        doc_id=doc.id, client_id=1, actor_id="alice", step_json="{}"
    )

    assert set(await activity_rows(ds, doc.id)) == {"alice"}

    await paper.hard_delete_doc(doc_id=doc.id)

    assert await activity_rows(ds, doc.id) == {}


async def _apply_through(database, *, stop_before=None):
    def _apply(connection):
        migrations.apply(Database(connection), stop_before=stop_before)

    await database.execute_write_fn(_apply)


@pytest.mark.asyncio
async def test_migration_backfills_from_surviving_history():
    """m008 seeds activity from whatever the step/snapshot log still holds,
    keeping the max created_at per (doc, actor) across both sources and
    ignoring anonymous rows."""
    ds = Datasette(memory=True)
    internal = ds.get_internal_database()
    # Apply through m007 — the activity table doesn't exist yet.
    await _apply_through(internal, stop_before="m008_doc_activity")

    async def w(sql, params):
        await internal.execute_write(sql, params)

    await w("INSERT INTO _datasette_paper_doc (id, name) VALUES (1, 'Doc')", [])
    # alice edited across steps and a snapshot; the snapshot (Jan 2) sits
    # between two steps (Jan 1, Jan 3) — max is the later step.
    await w(
        "INSERT INTO _datasette_paper_step "
        "(doc_id, version, client_id, actor_id, step_json, created_at) "
        "VALUES (1, 1, 1, 'alice', '{}', '2026-01-01T00:00:00.000Z')",
        [],
    )
    await w(
        "INSERT INTO _datasette_paper_step "
        "(doc_id, version, client_id, actor_id, step_json, created_at) "
        "VALUES (1, 2, 1, 'alice', '{}', '2026-01-03T00:00:00.000Z')",
        [],
    )
    # An anonymous step never attributes.
    await w(
        "INSERT INTO _datasette_paper_step "
        "(doc_id, version, client_id, actor_id, step_json, created_at) "
        "VALUES (1, 3, 1, NULL, '{}', '2026-01-09T00:00:00.000Z')",
        [],
    )
    await w(
        "INSERT INTO _datasette_paper_snapshot "
        "(doc_id, version, doc_json, actor_id, created_at) "
        "VALUES (1, 2, '{}', 'alice', '2026-01-02T00:00:00.000Z')",
        [],
    )
    # bob only appears in a snapshot — still backfilled.
    await w(
        "INSERT INTO _datasette_paper_snapshot "
        "(doc_id, version, doc_json, actor_id, created_at) "
        "VALUES (1, 5, '{}', 'bob', '2026-02-01T00:00:00.000Z')",
        [],
    )

    # Now apply m008 (runs the backfill).
    await _apply_through(internal)

    assert await activity_rows(ds, 1) == {
        "alice": "2026-01-03T00:00:00.000Z",
        "bob": "2026-02-01T00:00:00.000Z",
    }


@pytest.mark.asyncio
async def test_list_profile_docs_filters_and_orders():
    """The listProfileDocs helper: created-or-edited, active-only, scoped to
    the viewer's id set, newest-activity first (created-only falls back to
    creation time)."""
    ds, paper = await make_paper_db()

    created = await paper.insert_doc(name="Created", created_by="alice")
    edited = await paper.insert_doc(name="Edited", created_by="alice")
    shared = await paper.insert_doc(name="Shared", created_by="carol")
    await paper.insert_doc(name="Stranger", created_by="dave")  # outside viewable

    # The edits below must sort ahead of "Created"'s COALESCE fallback (its
    # created_at); stamps have millisecond precision, so a 2ms sleep keeps
    # them strictly later.
    await asyncio.sleep(0.002)

    # bob edited carol's "Shared" doc; alice edited her own "Edited" doc.
    await paper.insert_step(
        doc_id=shared.id, client_id=1, actor_id="bob", step_json="{}"
    )
    await paper.insert_step(
        doc_id=edited.id, client_id=1, actor_id="alice", step_json="{}"
    )

    viewable = [created.id, edited.id, shared.id]  # stranger not visible

    # bob: only "Shared" (edited, not created) — "stranger" is outside the set.
    bob_docs = await paper.list_profile_docs(doc_ids=viewable, actor="bob", limit=25)
    assert [d.name for d in bob_docs] == ["Shared"]
    assert bob_docs[0].last_edited_at is not None

    # alice: "Edited" (has activity, newest) then "Created" (created-only,
    # last_edited_at is NULL, sorted by created_at).
    alice_docs = await paper.list_profile_docs(
        doc_ids=viewable, actor="alice", limit=25
    )
    assert [d.name for d in alice_docs] == ["Edited", "Created"]
    by_name = {d.name: d for d in alice_docs}
    assert by_name["Edited"].last_edited_at > by_name["Created"].created_at
    assert by_name["Created"].last_edited_at is None

    # Empty visible set → no rows.
    assert await paper.list_profile_docs(doc_ids=[], actor="alice", limit=25) == []
