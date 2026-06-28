"""Tests for GET /-/paper/api/link-search.

Permission-scoped, title-filtered autocomplete over the actor's viewable,
active, non-template docs. See routes/docs.py::link_search.
"""

import pytest

from conftest import create_doc, grant_role, setup_paper_datasette


@pytest.mark.asyncio
async def test_link_search_anonymous_ungated_but_empty():
    # Listing is ungated; an anonymous actor reaches the endpoint but sees no
    # docs (results are scoped to viewable_doc_ids, which is empty here).
    ds, _ = await setup_paper_datasette(granted=False, actor=None)
    resp = await ds.client.get("/-/paper/api/link-search")
    assert resp.status_code == 200
    assert resp.json() == {"results": []}


@pytest.mark.asyncio
async def test_link_search_scoped_to_viewable():
    ds, _ = await setup_paper_datasette()
    a1 = await create_doc(ds, "Apple One", actor_id="alice")
    a2 = await create_doc(ds, "Apple Two", actor_id="alice")
    c1 = await create_doc(ds, "Carol Private", actor_id="carol")

    resp = await ds.client.get("/-/paper/api/link-search")
    assert resp.status_code == 200
    ids = {r["id"] for r in resp.json()["results"]}
    assert a1 in ids
    assert a2 in ids
    assert c1 not in ids

    # Grant alice Viewer on C1 → it now appears.
    await grant_role(ds, c1, "alice")
    resp = await ds.client.get("/-/paper/api/link-search")
    assert resp.status_code == 200
    ids = {r["id"] for r in resp.json()["results"]}
    assert c1 in ids


@pytest.mark.asyncio
async def test_link_search_prefix_ranks_before_substring():
    ds, _ = await setup_paper_datasette()
    await create_doc(ds, "Alpha", actor_id="alice")
    await create_doc(ds, "My Alpha thing", actor_id="alice")

    resp = await ds.client.get("/-/paper/api/link-search?q=Al")
    assert resp.status_code == 200
    names = [r["name"] for r in resp.json()["results"]]
    assert "Alpha" in names
    assert "My Alpha thing" in names
    assert names.index("Alpha") < names.index("My Alpha thing")


@pytest.mark.asyncio
async def test_link_search_excludes_non_active_and_templates():
    ds, paper_db = await setup_paper_datasette()
    active = await create_doc(ds, "Zebra active", actor_id="alice")
    archived = await create_doc(ds, "Zebra archived", actor_id="alice")
    template = await create_doc(ds, "Zebra template", actor_id="alice")

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
        await create_doc(ds, f"Doc number {i}", actor_id="alice")

    resp = await ds.client.get("/-/paper/api/link-search?q=&limit=3")
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 3
    for r in results:
        assert r["state"] == "active"
        assert r["kind"] == "doc"
