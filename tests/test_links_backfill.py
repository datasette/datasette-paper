"""Tests for the one-time, marker-guarded link-edge backfill.

``backfill_links`` walks every existing doc and runs the same idempotent
reindex the write tail uses, so docs created before the write-tail reindex
existed (no rows in ``_datasette_paper_link``) get their outgoing edges
materialized once. A marker row in ``_datasette_paper_link_backfill`` makes
repeat runs a no-op; ``force=True`` bypasses it.

These plant a snapshot whose doc_json contains a paper_link DIRECTLY (bumping
current_version to match) so the write-tail reindex never ran and no edge
exists pre-backfill — the exact gap the backfill fills.
"""

from __future__ import annotations

import json

import pytest

from datasette_paper.instance import (
    _LINK_BACKFILL_TABLE,
    backfill_links,
    get_registry,
)


def _doc_with_link(dst: int) -> dict:
    """A minimal doc whose single paragraph holds one paper_link(dst)."""
    return {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "paper_link", "attrs": {"docId": dst}}],
            }
        ],
    }


async def _edges(ds, doc_id: int) -> set[tuple[int, int, int]]:
    rows = await ds.get_internal_database().execute(
        "SELECT src_doc_id, dst_doc_id, occurrences "
        "FROM _datasette_paper_link WHERE src_doc_id = ?",
        [doc_id],
    )
    return {(r["src_doc_id"], r["dst_doc_id"], r["occurrences"]) for r in rows.rows}


async def _plant_link_doc(ds, db, *, dst: int, version: int = 1) -> int:
    """Create a doc and plant a version-N snapshot containing paper_link(dst).

    Bypasses append_fragment/apply_markdown_edit so the write-tail reindex
    never runs — there is no edge row afterwards. Bumps current_version so
    ``materialize_live_doc`` returns the planted snapshot, and pops any cached
    instance so a fresh hydrate sees it.
    """
    doc = await db.insert_doc(name="Src")
    await db.insert_snapshot(
        doc_id=doc.id,
        version=version,
        doc_json=json.dumps(_doc_with_link(dst)),
        actor_id=None,
    )
    internal = ds.get_internal_database()
    await internal.execute_write(
        "UPDATE _datasette_paper_doc SET current_version = ? WHERE id = ?",
        [version, doc.id],
    )
    get_registry(ds)._instances.pop(doc.id, None)
    return doc.id


@pytest.mark.asyncio
async def test_backfill_indexes_preexisting_doc(ds_paper):
    ds, db = ds_paper
    doc_id = await _plant_link_doc(ds, db, dst=42)

    # No edge yet: the link only ever entered via a planted snapshot, not a
    # write that would have triggered reindex_links.
    assert await _edges(ds, doc_id) == set()

    stats = await backfill_links(ds, force=True)
    assert stats["skipped"] is False
    assert stats["docs"] >= 1

    assert await _edges(ds, doc_id) == {(doc_id, 42, 1)}


@pytest.mark.asyncio
async def test_backfill_is_marker_guarded_and_idempotent(ds_paper):
    ds, db = ds_paper
    doc_id = await _plant_link_doc(ds, db, dst=7)

    # The fixture's startup already ran (and marked) one unforced backfill
    # before this doc existed. Clear the marker so the first unforced run
    # below actually scans, exercising the mark-then-skip cycle.
    await ds.get_internal_database().execute_write(
        f"DELETE FROM {_LINK_BACKFILL_TABLE}"
    )

    # First unforced run materializes the edge and sets the marker.
    first = await backfill_links(ds)
    assert first["skipped"] is False
    assert await _edges(ds, doc_id) == {(doc_id, 7, 1)}

    # Second unforced run sees the marker and is a no-op.
    second = await backfill_links(ds)
    assert second == {"docs": 0, "skipped": True}

    # Edges unchanged after the skipped run.
    assert await _edges(ds, doc_id) == {(doc_id, 7, 1)}
