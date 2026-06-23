"""Tests for POST /-/paper/api/actors/resolve.

Batch-resolves a list of actor ids to {name, avatar_url} for rendering
existing mentions on doc load. Ungated; unknown ids fall back to the id
itself as the name. Caps the id list at 200. JSON object keys are strings.
See routes/docs.py::resolve_actors.
"""

import pytest

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
