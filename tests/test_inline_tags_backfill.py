"""Tests for the one-time, marker-guarded inline-#tag index backfill.

``backfill_inline_tags`` walks every existing doc and runs the same idempotent
reindex the write tail uses, so docs that carried inline ``#tag`` nodes before
the index (migration m008) existed get their rows materialized once. A marker
row in ``_datasette_paper_inline_tag_backfill`` makes repeat runs a no-op;
``force=True`` bypasses it. Mirrors ``test_links_backfill``.

These plant a snapshot whose doc_json contains a tag node DIRECTLY (bumping
current_version to match) so the write-tail reindex never ran and no index row
exists pre-backfill — the exact gap the backfill fills.
"""

from __future__ import annotations

import json

import pytest

from datasette_paper.instance import (
    _TAG_BACKFILL_TABLE,
    backfill_inline_tags,
    get_registry,
)


def _doc_with_tag(slug: str, *, repeats: int = 1) -> dict:
    content: list[dict] = []
    for _ in range(repeats):
        content.append({"type": "tag", "attrs": {"tag": slug}})
        content.append({"type": "text", "text": " "})
    return {"type": "doc", "content": [{"type": "paragraph", "content": content}]}


async def _index_rows(ds, doc_id: int) -> set[tuple[str, int]]:
    rows = await ds.get_internal_database().execute(
        "SELECT tag, occurrences FROM _datasette_paper_inline_tag WHERE doc_id = ?",
        [doc_id],
    )
    return {(r["tag"], r["occurrences"]) for r in rows.rows}


async def _plant_tag_doc(
    ds, db, *, slug: str, repeats: int = 1, version: int = 1
) -> int:
    """Create a doc and plant a snapshot containing a tag node, bypassing reindex."""
    doc = await db.insert_doc(name="Tagged")
    await db.insert_snapshot(
        doc_id=doc.id,
        version=version,
        doc_json=json.dumps(_doc_with_tag(slug, repeats=repeats)),
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
    doc_id = await _plant_tag_doc(ds, db, slug="omega", repeats=2)

    # No index row yet: the tag only entered via a planted snapshot.
    assert await _index_rows(ds, doc_id) == set()

    stats = await backfill_inline_tags(ds, force=True)
    assert stats["skipped"] is False
    assert stats["docs"] >= 1

    assert await _index_rows(ds, doc_id) == {("omega", 2)}


@pytest.mark.asyncio
async def test_backfill_is_marker_guarded_and_idempotent(ds_paper):
    ds, db = ds_paper
    doc_id = await _plant_tag_doc(ds, db, slug="sigma")

    # The fixture's startup already ran (and marked) one unforced backfill
    # before this doc existed. Clear the marker so the first unforced run below
    # actually scans, exercising the mark-then-skip cycle.
    await ds.get_internal_database().execute_write(f"DELETE FROM {_TAG_BACKFILL_TABLE}")

    first = await backfill_inline_tags(ds)
    assert first["skipped"] is False
    assert await _index_rows(ds, doc_id) == {("sigma", 1)}

    second = await backfill_inline_tags(ds)
    assert second == {"docs": 0, "skipped": True}

    assert await _index_rows(ds, doc_id) == {("sigma", 1)}
