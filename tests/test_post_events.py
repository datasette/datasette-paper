"""Tests for POST /-/paper/api/docs/:id/events."""

from __future__ import annotations

import asyncio
import json

import pytest

from datasette_paper.instance import get_registry


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_doc(datasette, name="Test Paper"):
    resp = await datasette.client.post(
        "/-/paper/api/docs",
        json={"name": name},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


STEP_BODY = {"stepType": "replace"}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_at_version_0_succeeds(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    body = {
        "version": 0,
        "clientID": 42,
        "steps": [json.dumps(STEP_BODY)],
    }
    resp = await ds.client.post(url, json=body)
    assert resp.status_code == 200
    data = resp.json()
    assert data["version"] == 1

    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert len(steps) == 1
    assert steps[0].client_id == 42


@pytest.mark.asyncio
async def test_post_stale_version_409(ds):
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    body = {
        "version": 0,
        "clientID": 1,
        "steps": [json.dumps(STEP_BODY)],
    }

    resp1 = await ds.client.post(url, json=body)
    assert resp1.status_code == 200

    resp2 = await ds.client.post(url, json=body)
    assert resp2.status_code == 409


@pytest.mark.asyncio
async def test_post_invalid_version_400(ds):
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    body = {
        "version": 99,
        "clientID": 1,
        "steps": [json.dumps(STEP_BODY)],
    }
    resp = await ds.client.post(url, json=body)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_post_unknown_doc_403(ds):
    """Per-doc edit permission denies unknown docs at the gate."""
    url = "/-/paper/api/docs/99999/events"
    body = {
        "version": 0,
        "clientID": 1,
        "steps": [json.dumps(STEP_BODY)],
    }
    resp = await ds.client.post(url, json=body)
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_post_persists_actor_id(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    url = f"/-/paper/api/docs/{doc_id}/events"
    body = {
        "version": 0,
        "clientID": 7,
        "steps": [json.dumps(STEP_BODY)],
    }

    actor_cookie = ds.client.actor_cookie({"id": "alice"})
    resp = await ds.client.post(url, json=body, cookies={"ds_actor": actor_cookie})
    assert resp.status_code == 200

    steps = await paper_db.select_steps_after(doc_id=doc_id, after_version=0)
    assert len(steps) == 1
    assert steps[0].actor_id == "alice"


@pytest.mark.asyncio
async def test_post_broadcasts_to_subscribers(ds_paper):
    ds, paper_db = ds_paper
    doc_id = await _create_doc(ds)

    registry = get_registry(ds)
    instance = await registry.get(paper_db, doc_id)

    q = await instance.subscribe()

    url = f"/-/paper/api/docs/{doc_id}/events"
    body = {
        "version": 0,
        "clientID": 5,
        "steps": [json.dumps(STEP_BODY)],
    }
    resp = await ds.client.post(url, json=body)
    assert resp.status_code == 200

    payload = await asyncio.wait_for(q.get(), timeout=1.0)
    assert payload["version"] == 1
    assert len(payload["steps"]) == 1
    assert payload["clientIDs"][0] == 5
