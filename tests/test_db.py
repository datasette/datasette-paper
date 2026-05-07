"""Tests for datasette_paper.db and datasette_paper.sql._queries."""

import json

import pytest
from datasette.app import Datasette

from datasette_paper.db import PaperDB
from datasette_paper.migrations import ensure_migrations


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def make_paper_db() -> PaperDB:
    """Create an in-memory Datasette, run paper migrations, return a PaperDB."""
    ds = Datasette(memory=True)
    internal = ds.get_internal_database()
    await ensure_migrations(internal)
    return PaperDB(internal)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_migrations_idempotent():
    """ensure_migrations() can be called twice without error."""
    ds = Datasette(memory=True)
    internal = ds.get_internal_database()
    await ensure_migrations(internal)
    await ensure_migrations(internal)

    # Verify the main table exists by querying it via PaperDB.
    paper = PaperDB(internal)
    rows = await paper.list_docs()
    assert rows == []


@pytest.mark.asyncio
async def test_insert_and_select_doc():
    """Inserted doc round-trips with correct defaults."""
    paper = await make_paper_db()

    doc = await paper.insert_doc(name="My Doc", created_by="alice")

    assert doc.id is not None
    assert doc.name == "My Doc"
    assert doc.created_by == "alice"
    assert doc.schema_name == "basic+list"
    assert doc.current_version == 0

    fetched = await paper.select_doc_by_id(doc.id)
    assert fetched is not None
    assert fetched.id == doc.id
    assert fetched.name == "My Doc"
    assert fetched.schema_name == "basic+list"
    assert fetched.current_version == 0


@pytest.mark.asyncio
async def test_insert_step_increments_version():
    """Inserting two steps bumps current_version to 2."""
    paper = await make_paper_db()

    doc = await paper.insert_doc(name="Step Doc")

    v1 = await paper.insert_step(
        doc_id=doc.id,
        client_id=1,
        step_json=json.dumps({"type": "replace", "from": 1, "to": 2, "slice": "a"}),
    )
    assert v1 == 1

    v2 = await paper.insert_step(
        doc_id=doc.id,
        client_id=1,
        step_json=json.dumps({"type": "replace", "from": 2, "to": 3, "slice": "b"}),
    )
    assert v2 == 2

    updated_doc = await paper.select_doc_by_id(doc.id)
    assert updated_doc is not None
    assert updated_doc.current_version == 2


@pytest.mark.asyncio
async def test_select_steps_after():
    """select_steps_after returns the right rows in version order."""
    paper = await make_paper_db()

    doc = await paper.insert_doc(name="Steps Doc")

    for i in range(1, 6):
        await paper.insert_step(
            doc_id=doc.id,
            client_id=1,
            step_json=json.dumps({"seq": i}),
        )

    steps = await paper.select_steps_after(doc_id=doc.id, after_version=2)
    assert len(steps) == 3
    assert [s.version for s in steps] == [3, 4, 5]


@pytest.mark.asyncio
async def test_snapshot_round_trip():
    """insert_snapshot + select_latest_snapshot returns the latest."""
    paper = await make_paper_db()

    doc = await paper.insert_doc(name="Snapshot Doc")

    await paper.insert_snapshot(doc_id=doc.id, version=1, doc_json='{"v":1}')
    await paper.insert_snapshot(doc_id=doc.id, version=5, doc_json='{"v":5}')

    snap = await paper.select_latest_snapshot(doc_id=doc.id)
    assert snap is not None
    assert snap.version == 5
    assert snap.doc_json == '{"v":5}'
