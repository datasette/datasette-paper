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
# @feat presence: test: presence payload name fallback
async def test_presence_payload_includes_name_fallback(ds_paper):
    """Without a profile source the name falls back to the actor id."""
    ds, db = ds_paper
    doc = await db.insert_doc(name="P")
    inst = await Instance.hydrate(db, doc.id)

    await inst.ensure_actor_name(ds, "alice")
    inst.update_presence(client_id=7, actor_id="alice", anchor=0, head=0)

    user = {u["clientID"]: u for u in inst._presence_payload()["users"]}[7]
    assert user["actorID"] == "alice"
    assert user["name"] == "alice"


@pytest.mark.asyncio
async def test_post_presence_resolves_display_name(ds_paper):
    """A seeded user-profiles row surfaces as the presence cursor name."""
    ds, db = ds_paper
    create = await ds.client.post("/-/paper/api/docs", json={"name": "P"})
    doc_id = create.json()["id"]
    internal = ds.get_internal_database()
    await internal.execute_write(
        "INSERT INTO datasette_user_profiles (actor_id, display_name) VALUES (?, ?)",
        ["alice", "Alice Anderson"],
    )

    resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/presence",
        json={"clientID": 5, "anchor": 1, "head": 1},
    )
    assert resp.status_code == 204

    inst = await get_registry(ds).get(db, doc_id)
    assert inst._name_for("alice") == "Alice Anderson"
    user = {u["clientID"]: u for u in inst._presence_payload()["users"]}[5]
    assert user["name"] == "Alice Anderson"


@pytest.mark.asyncio
async def test_actor_name_refreshes_after_ttl(ds_paper, monkeypatch):
    """A profile rename surfaces once the cached name passes its TTL."""
    from datasette_paper import instance as instance_mod

    ds, db = ds_paper
    doc = await db.insert_doc(name="P")
    inst = await Instance.hydrate(db, doc.id)

    names = {"alice": "Alice One"}

    async def fake_resolve(datasette, actor_ids):
        return {a: {"name": names.get(a, a), "avatar_url": None} for a in actor_ids}

    monkeypatch.setattr("datasette_paper.util.resolve_actor_profiles", fake_resolve)

    await inst.ensure_actor_name(ds, "alice")
    assert inst._name_for("alice") == "Alice One"

    # Rename, but within the TTL the cached value is kept.
    names["alice"] = "Alice Two"
    await inst.ensure_actor_name(ds, "alice")
    assert inst._name_for("alice") == "Alice One"

    # Past the TTL the next resolve picks up the new name.
    monkeypatch.setattr(instance_mod, "ACTOR_NAME_TTL_SECONDS", -1)
    await inst.ensure_actor_name(ds, "alice")
    assert inst._name_for("alice") == "Alice Two"


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
