# @feat paper-link: tests the write-tail edge reindex into _datasette_paper_link
"""Tests for the write-tail paper_link edge reindex.

Every write funnels through ``Instance._persist_and_broadcast``, whose tail
calls ``Instance.reindex_links`` to rebuild the doc's outgoing edge set in
``_datasette_paper_link`` wholesale (delete-all + re-insert per src). The
exercises here drive real writes via ``append_fragment`` and assert the
persisted edge rows.
"""

from __future__ import annotations

import pytest

from datasette_paper.instance import Instance


def _link_paragraph(*doc_ids: int) -> dict:
    """A paragraph block containing one paper_link per ``doc_ids`` arg."""
    return {
        "type": "paragraph",
        "content": [{"type": "paper_link", "attrs": {"docId": did}} for did in doc_ids],
    }


async def _edges(ds, doc_id: int) -> set[tuple[int, int, int]]:
    rows = await ds.get_internal_database().execute(
        "SELECT src_doc_id, dst_doc_id, occurrences "
        "FROM _datasette_paper_link WHERE src_doc_id = ?",
        [doc_id],
    )
    return {(r["src_doc_id"], r["dst_doc_id"], r["occurrences"]) for r in rows.rows}


@pytest.mark.asyncio
async def test_reindex_counts_repeats(ds_paper):
    ds, db = ds_paper
    src = await db.insert_doc(name="Src")

    inst = await Instance.hydrate(db, src.id)
    # paper_link(A), paper_link(A), paper_link(B) across two paragraphs.
    await inst.append_fragment(
        [_link_paragraph(10, 10), _link_paragraph(20)],
        actor_id="alice",
    )

    assert await _edges(ds, src.id) == {(src.id, 10, 2), (src.id, 20, 1)}


@pytest.mark.asyncio
async def test_link_free_append_preserves_then_adds(ds_paper):
    ds, db = ds_paper
    src = await db.insert_doc(name="Src")

    inst = await Instance.hydrate(db, src.id)
    await inst.append_fragment([_link_paragraph(10)], actor_id="alice")
    assert await _edges(ds, src.id) == {(src.id, 10, 1)}

    # A plain paragraph adds no links. Reindex rebuilds from the *whole* doc,
    # which still contains the earlier link, so the existing edge survives.
    await inst.append_fragment(
        [{"type": "paragraph", "content": [{"type": "text", "text": "hi"}]}],
        actor_id="alice",
    )
    assert await _edges(ds, src.id) == {(src.id, 10, 1)}

    # Appending a fragment with a new link adds that edge.
    await inst.append_fragment([_link_paragraph(30)], actor_id="alice")
    assert await _edges(ds, src.id) == {(src.id, 10, 1), (src.id, 30, 1)}


@pytest.mark.asyncio
async def test_removal_clears_edges(ds_paper):
    ds, db = ds_paper
    src = await db.insert_doc(name="Src")

    inst = await Instance.hydrate(db, src.id)
    await inst.append_fragment([_link_paragraph(10)], actor_id="alice")
    assert await _edges(ds, src.id) == {(src.id, 10, 1)}

    # Real write path that removes the link: replace the whole doc with a
    # link-free markdown body. reindex rebuilds from the now link-free doc.
    await inst.apply_markdown_edit(lambda _md: "no links here", actor_id="alice")

    assert await _edges(ds, src.id) == set()


@pytest.mark.asyncio
async def test_src_hard_delete_cascades(ds_paper):
    ds, db = ds_paper
    src = await db.insert_doc(name="Src")

    inst = await Instance.hydrate(db, src.id)
    await inst.append_fragment([_link_paragraph(10)], actor_id="alice")
    assert await _edges(ds, src.id) == {(src.id, 10, 1)}

    internal = ds.get_internal_database()

    # Whether ON DELETE CASCADE fires depends on PRAGMA foreign_keys for the
    # connection. Probe it on this exact connection; if FKs are off, fall back
    # to asserting the schema carries the cascade clause.
    fk_rows = await internal.execute("PRAGMA foreign_keys")
    fk_on = bool(fk_rows.rows and fk_rows.rows[0][0])

    if fk_on:
        await internal.execute_write(
            "DELETE FROM _datasette_paper_doc WHERE id = ?", [src.id]
        )
        assert await _edges(ds, src.id) == set()
    else:
        schema_rows = await internal.execute(
            "SELECT sql FROM sqlite_master "
            "WHERE type='table' AND name='_datasette_paper_link'"
        )
        sql = schema_rows.rows[0][0]
        assert "REFERENCES _datasette_paper_doc(id) ON DELETE CASCADE" in sql
