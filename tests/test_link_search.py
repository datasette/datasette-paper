"""Tests for GET /-/paper/api/link-search.

Permission-scoped, title-filtered autocomplete over the actor's viewable,
active, non-template docs. See routes/docs.py::link_search.
"""

import pytest

from datasette_acl.grants import grant, Principal
from datasette_paper.permissions import (
    PAPER_DOC_RESOURCE_TYPE,
    PAPER_DOCS_PARENT,
)

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


async def _grant_viewer(ds, doc_id, actor_id):
    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.actor(actor_id),
        role="Viewer",
        by_actor="alice",
    )


@pytest.mark.asyncio
async def test_link_search_anonymous_403():
    ds, _ = await setup_paper_datasette(granted=False, actor=None)
    resp = await ds.client.get("/-/paper/api/link-search")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_link_search_scoped_to_viewable():
    ds, _ = await setup_paper_datasette()
    a1 = await _create_doc(ds, "Apple One", "alice")
    a2 = await _create_doc(ds, "Apple Two", "alice")
    c1 = await _create_doc(ds, "Carol Private", "carol")

    resp = await ds.client.get("/-/paper/api/link-search")
    assert resp.status_code == 200
    ids = {r["id"] for r in resp.json()["results"]}
    assert a1 in ids
    assert a2 in ids
    assert c1 not in ids

    # Grant alice Viewer on C1 → it now appears.
    await _grant_viewer(ds, c1, "alice")
    resp = await ds.client.get("/-/paper/api/link-search")
    assert resp.status_code == 200
    ids = {r["id"] for r in resp.json()["results"]}
    assert c1 in ids


@pytest.mark.asyncio
async def test_link_search_prefix_ranks_before_substring():
    ds, _ = await setup_paper_datasette()
    await _create_doc(ds, "Alpha", "alice")
    await _create_doc(ds, "My Alpha thing", "alice")

    resp = await ds.client.get("/-/paper/api/link-search?q=Al")
    assert resp.status_code == 200
    names = [r["name"] for r in resp.json()["results"]]
    assert "Alpha" in names
    assert "My Alpha thing" in names
    assert names.index("Alpha") < names.index("My Alpha thing")


@pytest.mark.asyncio
async def test_link_search_excludes_non_active_and_templates():
    ds, paper_db = await setup_paper_datasette()
    active = await _create_doc(ds, "Zebra active", "alice")
    archived = await _create_doc(ds, "Zebra archived", "alice")
    template = await _create_doc(ds, "Zebra template", "alice")

    # Archive one doc via the existing route; promote another to a template.
    resp = await ds.client.post(f"/-/paper/api/docs/{archived}/archive")
    assert resp.status_code == 200, resp.text
    resp = await ds.client.post(f"/-/paper/api/docs/{template}/make_template")
    assert resp.status_code == 200, resp.text

    resp = await ds.client.get("/-/paper/api/link-search?q=Zebra")
    assert resp.status_code == 200
    ids = {r["id"] for r in resp.json()["results"]}
    assert ids == {active}


@pytest.mark.asyncio
async def test_link_search_empty_q_returns_viewable_capped_by_limit():
    ds, _ = await setup_paper_datasette()
    for i in range(5):
        await _create_doc(ds, f"Doc number {i}", "alice")

    resp = await ds.client.get("/-/paper/api/link-search?q=&limit=3")
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 3
    for r in results:
        assert r["state"] == "active"
        assert r["kind"] == "doc"
