"""Tests for the inline-#tag search endpoint.

GET /-/paper/api/tags/{slug}/refs — docs whose BODY contains the inline `#slug`
tag node, ACL-filtered to the requester's viewable set. Separate namespace from
the doc-level `?tag=` filter / `_datasette_paper_doc_tag` table.

Backed by the derived ``_datasette_paper_inline_tag`` index (migration m007),
maintained by the write-tail reindex (and, in tests, by ``plant_snapshot``):
an exact, indexed JOIN — no ``step_json`` scan and no per-candidate
re-materialization. Tests plant synthetic snapshots (which also rebuild the
index) and force a registry re-hydrate.
"""

import pytest

from conftest import create_doc, plant_snapshot, setup_paper_datasette
from datasette_paper.db import PaperDB
from datasette_paper.instance import get_registry
from datasette_paper.util import paper_db


def _doc_with_tag(slug, *, repeats=1):
    """A minimal doc whose paragraph contains ``repeats`` `#slug` tag nodes."""
    content = []
    for _ in range(repeats):
        content.append({"type": "tag", "attrs": {"tag": slug}})
        content.append({"type": "text", "text": " "})
    return {"type": "doc", "content": [{"type": "paragraph", "content": content}]}


@pytest.mark.asyncio
async def test_tag_refs_returns_only_docs_containing_the_tag():
    ds, _ = await setup_paper_datasette()

    tagged = await create_doc(ds, "Has Alpha", actor_id="alice")
    untagged = await create_doc(ds, "No Tags", actor_id="alice")
    other_tag = await create_doc(ds, "Has Beta", actor_id="alice")

    await plant_snapshot(ds, tagged, _doc_with_tag("alpha", repeats=2))
    await plant_snapshot(
        ds, untagged, {"type": "doc", "content": [{"type": "paragraph"}]}
    )
    await plant_snapshot(ds, other_tag, _doc_with_tag("beta"))

    resp = await ds.client.get("/-/paper/api/tags/alpha/refs")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tag"] == "alpha"
    ids = {d["id"] for d in body["docs"]}
    assert ids == {tagged}
    # Occurrences are counted from the materialized body.
    assert body["docs"][0]["occurrences"] == 2


@pytest.mark.asyncio
async def test_tag_refs_excludes_non_viewable_docs():
    ds, _ = await setup_paper_datasette()

    alice_doc = await create_doc(ds, "Alice Alpha", actor_id="alice")
    carol_doc = await create_doc(ds, "Carol Alpha", actor_id="carol")

    await plant_snapshot(ds, alice_doc, _doc_with_tag("alpha"))
    await plant_snapshot(ds, carol_doc, _doc_with_tag("alpha"))

    # Default fixture actor is alice; carol's doc is not in her viewable set.
    resp = await ds.client.get("/-/paper/api/tags/alpha/refs")
    assert resp.status_code == 200, resp.text
    ids = {d["id"] for d in resp.json()["docs"]}
    assert alice_doc in ids
    assert carol_doc not in ids


@pytest.mark.asyncio
async def test_tag_refs_400_on_slug_that_normalizes_to_none():
    ds, _ = await setup_paper_datasette()
    # "!!!" strips to empty after normalize_tag → 400.
    resp = await ds.client.get("/-/paper/api/tags/!!!/refs")
    assert resp.status_code == 400, resp.text


@pytest.mark.asyncio
async def test_tag_refs_normalizes_query_slug():
    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Alpha", actor_id="alice")
    await plant_snapshot(ds, doc_id, _doc_with_tag("alpha"))

    # Mixed-case / spaced query normalizes to "alpha" and still matches.
    resp = await ds.client.get("/-/paper/api/tags/Alpha/refs")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tag"] == "alpha"
    assert {d["id"] for d in body["docs"]} == {doc_id}


@pytest.mark.asyncio
async def test_tag_refs_finds_tag_added_via_live_step():
    """A tag typed via a real edit is indexed by the write tail and found.

    No snapshot is planted — ``append_fragment`` writes a step and the write
    tail's ``reindex_tags`` populates the inline-tag index, so the refs endpoint
    sees the live edit without any snapshot or step_json scan.
    """
    ds, _ = await setup_paper_datasette()
    db = paper_db(ds)

    doc_id = await create_doc(ds, "Typed Alpha", actor_id="alice")
    # No snapshot is planted — create_doc with no content writes none.
    registry = get_registry(ds)
    instance = await registry.get(db, doc_id)
    # Append a `tag` node the way live editing would: a step, not a snapshot.
    await instance.append_fragment(
        [
            {
                "type": "paragraph",
                "content": [{"type": "tag", "attrs": {"tag": "alpha"}}],
            }
        ],
        actor_id="alice",
    )

    resp = await ds.client.get("/-/paper/api/tags/alpha/refs")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {d["id"] for d in body["docs"]} == {doc_id}
    assert body["docs"][0]["occurrences"] == 1


@pytest.mark.asyncio
async def test_tag_refs_db_helper_indexed_lookup():
    """The DB helper is an exact, viewable-scoped JOIN against the index."""
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    a = await create_doc(ds, "A", actor_id="alice")
    b = await create_doc(ds, "B", actor_id="alice")
    # plant_snapshot rebuilds the inline-tag index for each doc.
    await plant_snapshot(ds, a, _doc_with_tag("gamma", repeats=3))
    await plant_snapshot(ds, b, {"type": "doc", "content": [{"type": "paragraph"}]})

    refs = await db.tag_refs(tag="gamma", viewable_ids=[a, b])
    by_id = {r.id: r for r in refs}
    assert a in by_id
    assert b not in by_id
    assert by_id[a].occurrences == 3

    # Scoping drops docs outside the viewable set even on a tag hit.
    refs = await db.tag_refs(tag="gamma", viewable_ids=[b])
    assert {r.id for r in refs} == set()


@pytest.mark.asyncio
async def test_inline_tag_index_maintained_on_step_apply():
    """The write-tail reindex populates _datasette_paper_inline_tag directly."""
    ds, _ = await setup_paper_datasette()
    db = paper_db(ds)

    doc_id = await create_doc(ds, "Indexed", actor_id="alice")
    instance = await get_registry(ds).get(db, doc_id)
    await instance.append_fragment(
        [
            {
                "type": "paragraph",
                "content": [
                    {"type": "tag", "attrs": {"tag": "epsilon"}},
                    {"type": "text", "text": " "},
                    {"type": "tag", "attrs": {"tag": "epsilon"}},
                ],
            }
        ],
        actor_id="alice",
    )

    rows = (
        await ds.get_internal_database().execute(
            "SELECT tag, occurrences FROM _datasette_paper_inline_tag WHERE doc_id = ?",
            [doc_id],
        )
    ).rows
    assert [(r["tag"], r["occurrences"]) for r in rows] == [("epsilon", 2)]


@pytest.mark.asyncio
async def test_tag_refs_reflects_tag_removal_on_reindex():
    """Removing a tag from the body clears its index rows."""
    ds, _ = await setup_paper_datasette()
    doc_id = await create_doc(ds, "Toggle", actor_id="alice")

    await plant_snapshot(ds, doc_id, _doc_with_tag("delta"))
    resp = await ds.client.get("/-/paper/api/tags/delta/refs")
    assert {d["id"] for d in resp.json()["docs"]} == {doc_id}

    # Re-plant with the tag gone; plant_snapshot rebuilds the index.
    await plant_snapshot(
        ds,
        doc_id,
        {"type": "doc", "content": [{"type": "paragraph"}]},
        version=1,
        replace=True,
    )
    resp = await ds.client.get("/-/paper/api/tags/delta/refs")
    assert resp.json()["docs"] == []
