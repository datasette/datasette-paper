"""Tests for POST /-/paper/api/links/resolve.

Batch-resolves a list of doc ids to per-id ``{status, …}`` for the link
NodeView. Three statuses only: ``ok`` / ``denied`` / ``not_found``.
``denied`` and ``not_found`` must leak NO title and NO name. A trashed or
archived doc still has a ROW, so it resolves ``ok`` with its state — not
``not_found``. See routes/docs.py::resolve_links.

NOTE: JSON object keys serialize as STRINGS, so the ``links`` map is keyed
by string ids (e.g. "12", not 12) — assertions use ``str(id)``.
"""

import pytest

from conftest import setup_paper_datasette


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
async def test_resolve_ok_active():
    ds, _ = await setup_paper_datasette()
    doc_id = await _create_doc(ds, "Active Doc", "alice")

    resp = await ds.client.post("/-/paper/api/links/resolve", json={"ids": [doc_id]})
    assert resp.status_code == 200, resp.text
    # JSON object keys are strings.
    entry = resp.json()["links"][str(doc_id)]
    assert entry == {
        "status": "ok",
        "title": "Active Doc",
        "state": "active",
        "kind": "doc",
        "href": f"/-/paper/doc/{doc_id}",
    }


@pytest.mark.asyncio
async def test_resolve_archived_doc_is_ok():
    ds, _ = await setup_paper_datasette()
    doc_id = await _create_doc(ds, "Archived Doc", "alice")
    # alice owns it — the fixture binds alice.
    resp = await ds.client.post(f"/-/paper/api/docs/{doc_id}/archive")
    assert resp.status_code == 200, resp.text

    resp = await ds.client.post("/-/paper/api/links/resolve", json={"ids": [doc_id]})
    assert resp.status_code == 200, resp.text
    entry = resp.json()["links"][str(doc_id)]
    assert entry["status"] == "ok"
    assert entry["state"] == "archived"


@pytest.mark.asyncio
async def test_resolve_trashed_doc_is_ok():
    ds, _ = await setup_paper_datasette()
    doc_id = await _create_doc(ds, "Trashed Doc", "alice")
    resp = await ds.client.post(f"/-/paper/api/docs/{doc_id}/trash")
    assert resp.status_code == 200, resp.text

    resp = await ds.client.post("/-/paper/api/links/resolve", json={"ids": [doc_id]})
    assert resp.status_code == 200, resp.text
    # A trashed row still EXISTS → "ok" with state "trashed", not not_found.
    entry = resp.json()["links"][str(doc_id)]
    assert entry["status"] == "ok"
    assert entry["state"] == "trashed"


@pytest.mark.asyncio
async def test_resolve_denied_has_no_title():
    ds, _ = await setup_paper_datasette()
    # carol's private doc — alice cannot view it.
    doc_id = await _create_doc(ds, "Carol Private", "carol")

    resp = await ds.client.post("/-/paper/api/links/resolve", json={"ids": [doc_id]})
    assert resp.status_code == 200, resp.text
    entry = resp.json()["links"][str(doc_id)]
    assert entry["status"] == "denied"
    # Must not leak the name under any key.
    assert "title" not in entry
    assert "name" not in entry


@pytest.mark.asyncio
async def test_resolve_not_found():
    ds, _ = await setup_paper_datasette()

    resp = await ds.client.post("/-/paper/api/links/resolve", json={"ids": [999999]})
    assert resp.status_code == 200, resp.text
    entry = resp.json()["links"]["999999"]
    assert entry["status"] == "not_found"
    assert "title" not in entry


@pytest.mark.asyncio
async def test_resolve_anonymous_403():
    ds, _ = await setup_paper_datasette(granted=False, actor=None)
    resp = await ds.client.post("/-/paper/api/links/resolve", json={"ids": [1]})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_resolve_caps_at_200():
    ds, _ = await setup_paper_datasette()
    resp = await ds.client.post(
        "/-/paper/api/links/resolve", json={"ids": list(range(1, 251))}
    )
    assert resp.status_code == 200, resp.text
    links = resp.json()["links"]
    assert len(links) <= 200
