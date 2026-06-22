"""Tests for the forward-links + backlinks endpoints.

GET /-/paper/api/docs/{id}/links     — outgoing link edges, each resolved
GET /-/paper/api/docs/{id}/backlinks — incoming edges from viewable sources

Both reuse the link-resolve contract (08 Q4): statuses ok / denied /
not_found, with denied & not_found carrying NO title. Edges are seeded
directly via PaperDB.replace_links (dst_doc_id is not a FK, so a missing
dst exercises 'not_found'). See routes/docs.py::_resolve_map.
"""

import pytest

from conftest import setup_paper_datasette
from datasette_paper.db import PaperDB


async def _create_doc(ds, name, actor_id):
    """Create a doc as ``actor_id`` and return its new id."""
    cookie = ds.sign({"a": {"id": actor_id}}, "actor")
    resp = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": name},
        cookies={"ds_actor": cookie},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.asyncio
async def test_forward_links_mixes_statuses():
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    src = await _create_doc(ds, "Source", "alice")
    viewable = await _create_doc(ds, "Alice Target", "alice")
    carol_doc = await _create_doc(ds, "Carol Private", "carol")
    missing_id = 999999

    await db.replace_links(
        src_doc_id=src,
        src_version=1,
        edges={viewable: 3, carol_doc: 1, missing_id: 2},
    )

    resp = await ds.client.get(f"/-/paper/api/docs/{src}/links")
    assert resp.status_code == 200, resp.text
    by_id = {e["id"]: e for e in resp.json()["links"]}

    ok = by_id[viewable]
    assert ok["status"] == "ok"
    assert ok["title"] == "Alice Target"
    assert ok["occurrences"] == 3

    denied = by_id[carol_doc]
    assert denied["status"] == "denied"
    assert "title" not in denied
    assert "name" not in denied
    assert denied["occurrences"] == 1

    not_found = by_id[missing_id]
    assert not_found["status"] == "not_found"
    assert "title" not in not_found
    assert not_found["occurrences"] == 2


@pytest.mark.asyncio
async def test_backlinks_excludes_non_viewable_sources():
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    dst = await _create_doc(ds, "Target", "alice")
    alice_src = await _create_doc(ds, "Alice Source", "alice")
    carol_src = await _create_doc(ds, "Carol Source", "carol")

    await db.replace_links(src_doc_id=alice_src, src_version=1, edges={dst: 1})
    await db.replace_links(src_doc_id=carol_src, src_version=1, edges={dst: 1})

    resp = await ds.client.get(f"/-/paper/api/docs/{dst}/backlinks")
    assert resp.status_code == 200, resp.text
    ids = {e["id"] for e in resp.json()["backlinks"]}

    assert alice_src in ids
    assert carol_src not in ids


@pytest.mark.asyncio
async def test_forward_and_backlinks_403_for_non_viewer():
    ds, _ = await setup_paper_datasette()
    # carol owns this doc; alice has list+create (fixture grants) but no
    # view grant on it, so she's a genuine non-viewer.
    carol_doc = await _create_doc(ds, "Carol Only", "carol")

    resp = await ds.client.get(f"/-/paper/api/docs/{carol_doc}/links")
    assert resp.status_code == 403

    resp = await ds.client.get(f"/-/paper/api/docs/{carol_doc}/backlinks")
    assert resp.status_code == 403
