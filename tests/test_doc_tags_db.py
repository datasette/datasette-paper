"""Storage-layer tests for document-level tags (PaperDB + normalize_tag).

Endpoint/permission coverage lives in test_doc_tags.py; this file exercises
the db helpers and the normalization rule directly.
"""

import pytest
from datasette.app import Datasette

from datasette_paper.db import PaperDB
from datasette_paper.migrations import ensure_migrations
from datasette_paper.util import normalize_tag


async def make_paper_db() -> PaperDB:
    ds = Datasette(memory=True)
    internal = ds.get_internal_database()
    await ensure_migrations(internal)
    return PaperDB(internal)


# ---------------------------------------------------------------------------
# normalize_tag
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Road Map", "road-map"),
        ("  road-map  ", "road-map"),
        ("ROADMAP", "roadmap"),
        ("inbox/to-read", "inbox/to-read"),
        ("a   b", "a-b"),
        ("c++ stuff!", "c-stuff"),
        ("--lead--trail--", "lead-trail"),
        ("", None),
        ("   ", None),
        ("!!!", None),
        ("x" * 65, None),
        (None, None),
    ],
)
def test_normalize_tag(raw, expected):
    assert normalize_tag(raw) == expected


# ---------------------------------------------------------------------------
# db helpers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_add_list_remove_doc_tag():
    paper = await make_paper_db()
    doc = await paper.insert_doc(name="Doc", created_by="alice")

    await paper.add_doc_tag(doc_id=doc.id, tag="roadmap")
    await paper.add_doc_tag(doc_id=doc.id, tag="q3")
    assert await paper.list_tags_for_doc(doc_id=doc.id) == ["q3", "roadmap"]

    # Duplicate add is a no-op (INSERT OR IGNORE).
    await paper.add_doc_tag(doc_id=doc.id, tag="roadmap")
    assert await paper.list_tags_for_doc(doc_id=doc.id) == ["q3", "roadmap"]

    await paper.remove_doc_tag(doc_id=doc.id, tag="q3")
    assert await paper.list_tags_for_doc(doc_id=doc.id) == ["roadmap"]


@pytest.mark.asyncio
async def test_set_doc_tags_replaces_atomically():
    paper = await make_paper_db()
    doc = await paper.insert_doc(name="Doc", created_by="alice")

    await paper.set_doc_tags(doc_id=doc.id, tags=["a", "b", "c"])
    assert await paper.list_tags_for_doc(doc_id=doc.id) == ["a", "b", "c"]

    await paper.set_doc_tags(doc_id=doc.id, tags=["b", "d"])
    assert await paper.list_tags_for_doc(doc_id=doc.id) == ["b", "d"]

    await paper.set_doc_tags(doc_id=doc.id, tags=[])
    assert await paper.list_tags_for_doc(doc_id=doc.id) == []


@pytest.mark.asyncio
async def test_list_tags_for_docs_batches():
    paper = await make_paper_db()
    d1 = await paper.insert_doc(name="One", created_by="alice")
    d2 = await paper.insert_doc(name="Two", created_by="alice")
    d3 = await paper.insert_doc(name="Three", created_by="alice")

    await paper.set_doc_tags(doc_id=d1.id, tags=["x", "y"])
    await paper.set_doc_tags(doc_id=d2.id, tags=["y"])

    by_doc = await paper.list_tags_for_docs(doc_ids=[d1.id, d2.id, d3.id])
    assert by_doc == {d1.id: ["x", "y"], d2.id: ["y"]}  # d3 absent (no tags)


@pytest.mark.asyncio
async def test_list_all_tags_counts_within_scope():
    paper = await make_paper_db()
    d1 = await paper.insert_doc(name="One", created_by="alice")
    d2 = await paper.insert_doc(name="Two", created_by="alice")
    d3 = await paper.insert_doc(name="Three", created_by="bob")

    await paper.set_doc_tags(doc_id=d1.id, tags=["shared", "only1"])
    await paper.set_doc_tags(doc_id=d2.id, tags=["shared"])
    await paper.set_doc_tags(doc_id=d3.id, tags=["shared", "hidden"])

    # Scope excludes d3 → its tags don't contribute.
    counts = dict(await paper.list_all_tags(doc_ids=[d1.id, d2.id]))
    assert counts == {"shared": 2, "only1": 1}


@pytest.mark.asyncio
async def test_filter_docs_by_tag_intersection():
    paper = await make_paper_db()
    d1 = await paper.insert_doc(name="One", created_by="alice")
    d2 = await paper.insert_doc(name="Two", created_by="alice")
    d3 = await paper.insert_doc(name="Three", created_by="alice")
    ids = [d1.id, d2.id, d3.id]

    await paper.set_doc_tags(doc_id=d1.id, tags=["a", "b"])
    await paper.set_doc_tags(doc_id=d2.id, tags=["a"])
    await paper.set_doc_tags(doc_id=d3.id, tags=["b"])

    async def filtered(tags):
        rows = await paper.list_docs_by_ids_states_kinds_and_tags(
            doc_ids=ids, states=["active"], kinds=["doc"], tags=tags
        )
        return {r.id for r in rows}

    # No tags → all docs match.
    assert await filtered([]) == set(ids)
    # Single tag.
    assert await filtered(["a"]) == {d1.id, d2.id}
    # Intersection: must carry BOTH.
    assert await filtered(["a", "b"]) == {d1.id}
    # Unknown tag → nothing.
    assert await filtered(["nope"]) == set()


# ---------------------------------------------------------------------------
# migrations
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_doc_tag_indexes_after_migrations():
    """m007 drops the redundant doc_id index but keeps the tag index.

    ``idx_paper_doc_tag_doc`` (doc_id) duplicates the leftmost prefix of
    ``PRIMARY KEY (doc_id, tag)``, so m007 removes it. ``idx_paper_doc_tag_tag``
    serves trailing-column (tag) lookups and must remain.
    """
    paper = await make_paper_db()
    rows = (
        await paper.database.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'index' AND tbl_name = '_datasette_paper_doc_tag'"
        )
    ).rows
    names = {row["name"] for row in rows}
    assert "idx_paper_doc_tag_doc" not in names
    assert "idx_paper_doc_tag_tag" in names
