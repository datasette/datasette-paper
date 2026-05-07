"""Tests for the presence/cursors backend."""

import asyncio

import pytest

from datasette_paper.instance import Instance, get_registry


@pytest.mark.asyncio
async def test_update_presence_stores_entry(ds_paper):
    _, db = ds_paper
    doc = await db.insert_doc(name="P")
    inst = await Instance.hydrate(db, doc.id)

    inst.update_presence(client_id=42, actor_id="alice", anchor=3, head=7)

    assert 42 in inst.presence
    assert inst.presence[42]["actor_id"] == "alice"
    assert inst.presence[42]["anchor"] == 3
    assert inst.presence[42]["head"] == 7


@pytest.mark.asyncio
async def test_update_presence_broadcasts_to_subscribers(ds_paper):
    _, db = ds_paper
    doc = await db.insert_doc(name="P")
    inst = await Instance.hydrate(db, doc.id)

    q_a = await inst.subscribe(client_id=1)
    q_b = await inst.subscribe(client_id=2)

    inst.update_presence(client_id=2, actor_id="bob", anchor=5, head=5)

    msg_a = await asyncio.wait_for(q_a.get(), timeout=1.0)
    msg_b = await asyncio.wait_for(q_b.get(), timeout=1.0)

    for msg in (msg_a, msg_b):
        assert msg["kind"] == "presence"
        users = {u["clientID"]: u for u in msg["users"]}
        assert 2 in users
        assert users[2]["actorID"] == "bob"
        assert users[2]["anchor"] == 5


@pytest.mark.asyncio
async def test_unsubscribe_removes_presence_and_rebroadcasts(ds_paper):
    _, db = ds_paper
    doc = await db.insert_doc(name="P")
    inst = await Instance.hydrate(db, doc.id)

    q_a = await inst.subscribe(client_id=10)
    q_b = await inst.subscribe(client_id=20)

    inst.update_presence(client_id=10, actor_id="alice", anchor=0, head=0)

    await asyncio.wait_for(q_b.get(), timeout=1.0)
    await asyncio.wait_for(q_a.get(), timeout=1.0)

    inst.unsubscribe(q_a)

    msg = await asyncio.wait_for(q_b.get(), timeout=1.0)
    assert msg["kind"] == "presence"
    assert all(u["clientID"] != 10 for u in msg["users"])
    assert 10 not in inst.presence


# ---------------------------------------------------------------------------
# Route tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_presence_endpoint(ds_paper):
    ds, paper_db = ds_paper

    create = await ds.client.post("/-/paper/api/docs", json={"name": "P"})
    doc_id = create.json()["id"]

    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/presence",
        json={"clientID": 99, "anchor": 4, "head": 12},
    )
    assert resp.status_code == 204

    registry = get_registry(ds)
    inst = await registry.get(paper_db, doc_id)
    assert 99 in inst.presence
    assert inst.presence[99]["anchor"] == 4
    assert inst.presence[99]["head"] == 12


@pytest.mark.asyncio
async def test_post_presence_unknown_doc_403(ds):
    """Per-doc view permission denies unknown docs at the gate."""
    resp = await ds.client.post(
        "/-/paper/api/docs/99999/presence",
        json={"clientID": 1, "anchor": 0, "head": 0},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_post_presence_400_invalid_body(ds):
    create = await ds.client.post("/-/paper/api/docs", json={"name": "P"})
    doc_id = create.json()["id"]
    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/presence",
        json={"oops": "wrong shape"},
    )
    assert resp.status_code == 400
