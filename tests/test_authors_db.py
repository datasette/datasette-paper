"""Storage-layer tests for the document authors byline (PaperDB).

Endpoint / permission / eligibility coverage lives in test_authors.py; this
file exercises the db helpers directly: append order, idempotence, remove,
reorder (set), and the hard-delete cascade.
"""

import pytest
from datasette.app import Datasette

from datasette_paper.db import PaperDB
from datasette_paper.migrations import ensure_migrations


async def make_paper_db() -> PaperDB:
    ds = Datasette(memory=True)
    internal = ds.get_internal_database()
    await ensure_migrations(internal)
    return PaperDB(internal)


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
