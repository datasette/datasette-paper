"""Storage-layer tests for the document authors byline (PaperDB).

Endpoint / permission / eligibility coverage lives in test_authors.py; this
file exercises the db helpers directly: append order, idempotence, remove,
reorder (set), and the hard-delete cascade.
"""

import pytest
from datasette.app import Datasette
from sqlite_utils import Database

from datasette_paper.db import PaperDB
from datasette_paper.migrations import ensure_migrations, m009_backfill_authors


async def make_paper_db() -> PaperDB:
    ds = Datasette(memory=True)
    internal = ds.get_internal_database()
    await ensure_migrations(internal)
    return PaperDB(internal)


async def run_backfill(db: PaperDB) -> None:
    """Run the m009 creator backfill directly.

    A doc inserted via ``PaperDB.insert_doc`` gets no byline (only the create
    *route* seeds one), so it's a faithful pre-feature doc; m009 already ran on
    the empty DB at startup, and its NOT EXISTS guard makes this re-run safe.
    """
    await db.database.execute_write_fn(
        lambda conn: m009_backfill_authors(Database(conn))
    )


async def _new_doc(db: PaperDB) -> int:
    doc = await db.insert_doc(name="Doc", created_by="alice")
    return doc.id


@pytest.mark.asyncio
async def test_add_appends_in_order():
    db = await make_paper_db()
    doc_id = await _new_doc(db)

    await db.add_doc_author(doc_id=doc_id, actor_id="alice", added_by="alice")
    await db.add_doc_author(doc_id=doc_id, actor_id="bob", added_by="alice")
    await db.add_doc_author(doc_id=doc_id, actor_id="carol", added_by="alice")

    assert await db.list_authors_for_doc(doc_id=doc_id) == ["alice", "bob", "carol"]


@pytest.mark.asyncio
async def test_add_is_idempotent():
    db = await make_paper_db()
    doc_id = await _new_doc(db)

    await db.add_doc_author(doc_id=doc_id, actor_id="bob", added_by="alice")
    await db.add_doc_author(doc_id=doc_id, actor_id="bob", added_by="alice")

    # No duplicate row, no phantom position bump.
    assert await db.list_authors_for_doc(doc_id=doc_id) == ["bob"]


@pytest.mark.asyncio
async def test_remove_preserves_order_of_the_rest():
    db = await make_paper_db()
    doc_id = await _new_doc(db)
    for aid in ("alice", "bob", "carol"):
        await db.add_doc_author(doc_id=doc_id, actor_id=aid, added_by="alice")

    await db.remove_doc_author(doc_id=doc_id, actor_id="bob")
    assert await db.list_authors_for_doc(doc_id=doc_id) == ["alice", "carol"]

    # Removing an absent id is a no-op.
    await db.remove_doc_author(doc_id=doc_id, actor_id="nobody")
    assert await db.list_authors_for_doc(doc_id=doc_id) == ["alice", "carol"]


@pytest.mark.asyncio
async def test_add_after_remove_never_collides():
    """A remove may leave a position gap; the next add must still land last."""
    db = await make_paper_db()
    doc_id = await _new_doc(db)
    for aid in ("alice", "bob", "carol"):
        await db.add_doc_author(doc_id=doc_id, actor_id=aid, added_by="alice")

    await db.remove_doc_author(doc_id=doc_id, actor_id="carol")  # drops last
    await db.add_doc_author(doc_id=doc_id, actor_id="dave", added_by="alice")

    assert await db.list_authors_for_doc(doc_id=doc_id) == ["alice", "bob", "dave"]


@pytest.mark.asyncio
async def test_set_replaces_and_reorders():
    db = await make_paper_db()
    doc_id = await _new_doc(db)
    for aid in ("alice", "bob"):
        await db.add_doc_author(doc_id=doc_id, actor_id=aid, added_by="alice")

    await db.set_doc_authors(
        doc_id=doc_id, actor_ids=["carol", "alice"], added_by="alice"
    )
    assert await db.list_authors_for_doc(doc_id=doc_id) == ["carol", "alice"]

    # Empty list clears the byline.
    await db.set_doc_authors(doc_id=doc_id, actor_ids=[], added_by="alice")
    assert await db.list_authors_for_doc(doc_id=doc_id) == []


@pytest.mark.asyncio
async def test_hard_delete_removes_authors():
    db = await make_paper_db()
    doc_id = await _new_doc(db)
    await db.add_doc_author(doc_id=doc_id, actor_id="alice", added_by="alice")
    await db.add_doc_author(doc_id=doc_id, actor_id="bob", added_by="alice")

    await db.hard_delete_doc(doc_id=doc_id)
    assert await db.list_authors_for_doc(doc_id=doc_id) == []


# ---------------------------------------------------------------------------
# m009 backfill — credit the creator as author #0 on pre-feature docs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_backfill_credits_creator():
    db = await make_paper_db()
    doc = await db.insert_doc(name="Old", created_by="alice")  # legacy: no byline
    assert await db.list_authors_for_doc(doc_id=doc.id) == []

    await run_backfill(db)

    assert await db.list_authors_for_doc(doc_id=doc.id) == ["alice"]
    # position 0, credited by the creator, timestamped at the doc's creation.
    rows = (
        await db.database.execute(
            "SELECT position, added_by, added_at FROM _datasette_paper_doc_author"
            " WHERE doc_id = ?",
            [doc.id],
        )
    ).rows
    assert rows[0]["position"] == 0
    assert rows[0]["added_by"] == "alice"
    doc_rows = (
        await db.database.execute(
            "SELECT created_at FROM _datasette_paper_doc WHERE id = ?", [doc.id]
        )
    ).rows
    assert rows[0]["added_at"] == doc_rows[0]["created_at"]


@pytest.mark.asyncio
async def test_backfill_skips_anonymous():
    db = await make_paper_db()
    doc = await db.insert_doc(name="Anon", created_by=None)  # anonymous creator

    await run_backfill(db)

    assert await db.list_authors_for_doc(doc_id=doc.id) == []


@pytest.mark.asyncio
async def test_backfill_is_idempotent_and_preserves_existing_byline():
    db = await make_paper_db()
    doc = await db.insert_doc(name="Doc", created_by="alice")
    # A doc that already has a (different, ordered) byline must be left alone.
    await db.set_doc_authors(
        doc_id=doc.id, actor_ids=["carol", "alice"], added_by="alice"
    )

    await run_backfill(db)  # first run: skips it (already has a byline)
    await run_backfill(db)  # second run: still a no-op

    assert await db.list_authors_for_doc(doc_id=doc.id) == ["carol", "alice"]
