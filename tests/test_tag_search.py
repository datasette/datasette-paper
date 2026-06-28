"""Tests for the inline-#tag search endpoint.

GET /-/paper/api/tags/{slug}/refs — docs whose BODY contains the inline `#slug`
tag node, ACL-filtered to the requester's viewable set. Separate namespace from
the doc-level `?tag=` filter / `_datasette_paper_doc_tag` table.

LIKE-scan v1: candidate docs are matched by a LIKE over the latest snapshot OR
the step log (so live, unsnapshotted edits are seen), then confirmed in Python
by walking the materialized doc for a real `tag` node. Tests plant synthetic
snapshots and force a registry re-hydrate.
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
async def test_tag_refs_finds_tag_only_in_live_steps_no_snapshot():
    """A tag typed into a doc with no matching snapshot is still found.

    Regression: a freshly-edited doc (well under SNAPSHOT_THRESHOLD steps) has
    no snapshot reflecting the new tag — it may have no snapshot at all — so a
    candidate scan over snapshots only would silently miss it. The candidate
    scan must also LIKE-match the step log so live, unsnapshotted content is a
    candidate; the Python confirmation then walks the materialized live doc.
    """
    ds, _ = await setup_paper_datasette()
    db = paper_db(ds)

    doc_id = await create_doc(ds, "Typed Alpha", actor_id="alice")
    # No snapshot is planted — _create_doc with no content writes none.
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
async def test_tag_ref_candidates_db_helper_like_scan():
    """The DB candidate scan is a viewable-scoped LIKE over latest snapshots."""
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    a = await create_doc(ds, "A", actor_id="alice")
    b = await create_doc(ds, "B", actor_id="alice")
    await plant_snapshot(ds, a, _doc_with_tag("gamma"))
    await plant_snapshot(ds, b, {"type": "doc", "content": [{"type": "paragraph"}]})

    cands = await db.tag_ref_candidates(like="%gamma%", viewable_ids=[a, b])
    ids = {c.id for c in cands}
    assert a in ids
    assert b not in ids

    # Scoping drops docs outside the viewable set even on a LIKE hit.
    cands = await db.tag_ref_candidates(like="%gamma%", viewable_ids=[b])
    assert {c.id for c in cands} == set()
