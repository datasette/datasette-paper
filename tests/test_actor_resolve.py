"""Tests for POST /-/paper/api/actors/resolve.

Batch-resolves a list of actor ids to {name, avatar_url} for rendering
existing mentions on doc load. The profile lookup is gated on the
``profile_access`` action (datasette-user-profiles' own gate); actors
without it get every id echoed back as its own name (no leak), so the
endpoint never 403s. Unknown ids fall back to the id itself as the name.
Caps the id list at 200. JSON object keys are strings.
See routes/docs.py::resolve_actors.
"""

import pytest
from datasette.app import Datasette

from conftest import setup_paper_datasette


@pytest.mark.asyncio
async def test_resolve_falls_back_to_id():
    ds, _ = await setup_paper_datasette()
    resp = await ds.client.post(
        "/-/paper/api/actors/resolve", json={"ids": ["bob", "carol"]}
    )
    assert resp.status_code == 200, resp.text
    actors = resp.json()["actors"]
    # No profile source installed → name falls back to the id, avatar None.
    assert actors == {
        "bob": {"name": "bob", "avatar_url": None},
        "carol": {"name": "carol", "avatar_url": None},
    }


@pytest.mark.asyncio
async def test_resolve_coerces_and_skips_falsy():
    ds, _ = await setup_paper_datasette()
    resp = await ds.client.post(
        "/-/paper/api/actors/resolve", json={"ids": [123, "", None, "dave"]}
    )
    assert resp.status_code == 200, resp.text
    actors = resp.json()["actors"]
    # Falsy ids ("" / None) are skipped; ints are coerced to string keys.
    assert set(actors) == {"123", "dave"}
    assert actors["123"]["name"] == "123"


@pytest.mark.asyncio
async def test_resolve_empty_ids():
    ds, _ = await setup_paper_datasette()
    resp = await ds.client.post("/-/paper/api/actors/resolve", json={"ids": []})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"actors": {}}


@pytest.mark.asyncio
async def test_resolve_gated_on_profile_access(monkeypatch):
    """Profile lookup runs only for actors holding ``profile_access``.

    A profile source is stubbed in so the gate is observable: with the
    action denied the endpoint degrades to id-only (no name/avatar leak);
    with it granted the stubbed profiles flow through.
    """
    import datasette_paper.routes.docs as docs

    async def fake_profiles(datasette, ids):
        return {i: {"name": f"Name {i}", "avatar_url": f"/pic/{i}"} for i in ids}

    monkeypatch.setattr(docs, "resolve_actor_profiles", fake_profiles)

    # Default fixture grants paper-create but NOT profile_access → degraded.
    ds, _ = await setup_paper_datasette()
    resp = await ds.client.post("/-/paper/api/actors/resolve", json={"ids": ["bob"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["actors"] == {"bob": {"name": "bob", "avatar_url": None}}

    # profile_access granted → the stubbed profile flows through.
    ds2 = Datasette(
        memory=True,
        config={"permissions": {"profile_access": True}},
    )
    await ds2.invoke_startup()
    cookie = ds2.sign({"a": {"id": "alice"}}, "actor")
    resp = await ds2.client.post(
        "/-/paper/api/actors/resolve",
        json={"ids": ["bob"]},
        cookies={"ds_actor": cookie},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["actors"] == {
        "bob": {"name": "Name bob", "avatar_url": "/pic/bob"}
    }


@pytest.mark.asyncio
async def test_resolve_caps_at_200():
    ds, _ = await setup_paper_datasette()
    resp = await ds.client.post(
        "/-/paper/api/actors/resolve",
        json={"ids": [f"actor-{i}" for i in range(250)]},
    )
    assert resp.status_code == 200, resp.text
    actors = resp.json()["actors"]
    assert len(actors) == 200
    # The first 200 are kept; the tail is truncated.
    assert "actor-0" in actors
    assert "actor-200" not in actors
