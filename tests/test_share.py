"""Tests for the share endpoints + SSE revocation sweep."""

from __future__ import annotations

import asyncio

import pytest
from datasette.app import Datasette


def _cookie(ds, actor_id):
    return {"ds_actor": ds.sign({"a": {"id": actor_id}}, "actor")}


async def _make_ds():
    ds = Datasette(
        memory=True,
        config={
            "permissions": {
                "datasette-paper-list": True,
                "datasette-paper-create": True,
            }
        },
    )
    await ds.invoke_startup()
    return ds


async def _alice_doc(ds, name="P"):
    """Create a doc owned by alice; return its id."""
    r = await ds.client.post(
        "/-/paper/api/docs", json={"name": name}, cookies=_cookie(ds, "alice")
    )
    assert r.status_code == 201
    return r.json()["id"]


# ---------------------------------------------------------------------------
# GET /share
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_share_get_owner_sees_can_manage_true():
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)

    r = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}/share", cookies=_cookie(ds, "alice")
    )
    assert r.status_code == 200
    body = r.json()
    assert body["visibility"] == "private"
    assert body["owner"] == "alice"
    assert body["shares"] == []
    assert body["canManage"] is True


@pytest.mark.asyncio
async def test_share_get_viewer_403():
    """Viewer-share-recipient cannot read share state — editors+owner only."""
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)

    await ds.get_internal_database().execute_write(
        "INSERT INTO _datasette_paper_share (doc_id, actor_id, role, granted_by) "
        "VALUES (?, ?, 'viewer', 'alice')",
        [doc_id, "bob"],
    )

    r = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}/share", cookies=_cookie(ds, "bob")
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_share_get_editor_sees_can_manage_false():
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)

    await ds.get_internal_database().execute_write(
        "INSERT INTO _datasette_paper_share (doc_id, actor_id, role, granted_by) "
        "VALUES (?, ?, 'editor', 'alice')",
        [doc_id, "bob"],
    )

    r = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}/share", cookies=_cookie(ds, "bob")
    )
    assert r.status_code == 200
    body = r.json()
    assert body["canManage"] is False
    assert [s["actorID"] for s in body["shares"]] == ["bob"]


@pytest.mark.asyncio
async def test_share_get_stranger_403():
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    r = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}/share", cookies=_cookie(ds, "carol")
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# POST /share — owner-only mutation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_share_post_owner_replaces_state():
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/share",
        json={
            "visibility": "link-view",
            "shares": [
                {"actorID": "bob", "role": "editor"},
                {"actorID": "carol", "role": "viewer"},
            ],
        },
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["visibility"] == "link-view"
    by_actor = {s["actorID"]: s for s in body["shares"]}
    assert by_actor["bob"]["role"] == "editor"
    assert by_actor["carol"]["role"] == "viewer"

    # Idempotent: re-POST same state, count is the same.
    r2 = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/share",
        json=body,
        cookies=_cookie(ds, "alice"),
    )
    assert r2.status_code == 200
    assert len(r2.json()["shares"]) == 2


@pytest.mark.asyncio
async def test_share_post_editor_403():
    """Editor (granted via share) cannot mutate the share state — owner-only."""
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)

    await ds.get_internal_database().execute_write(
        "INSERT INTO _datasette_paper_share (doc_id, actor_id, role, granted_by) "
        "VALUES (?, ?, 'editor', 'alice')",
        [doc_id, "bob"],
    )

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/share",
        json={"visibility": "private", "shares": []},
        cookies=_cookie(ds, "bob"),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_share_post_invalid_visibility_400():
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/share",
        json={"visibility": "everyone-public", "shares": []},
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_share_post_invalid_role_400():
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/share",
        json={
            "visibility": "private",
            "shares": [{"actorID": "bob", "role": "admin"}],
        },
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_share_post_owner_in_shares_400():
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/share",
        json={
            "visibility": "private",
            "shares": [{"actorID": "alice", "role": "viewer"}],
        },
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_share_post_duplicate_actor_400():
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/share",
        json={
            "visibility": "private",
            "shares": [
                {"actorID": "bob", "role": "viewer"},
                {"actorID": "bob", "role": "editor"},
            ],
        },
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Revocation sweep
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_revocation_closes_open_subscribers():
    """After bob is removed from shares, his subscribed queue receives a closed sentinel."""
    from datasette_paper.db import PaperDB
    from datasette_paper.instance import get_registry

    ds = await _make_ds()
    doc_id = await _alice_doc(ds)

    # Grant bob editor access.
    await ds.get_internal_database().execute_write(
        "INSERT INTO _datasette_paper_share (doc_id, actor_id, role, granted_by) "
        "VALUES (?, ?, 'editor', 'alice')",
        [doc_id, "bob"],
    )

    # Bob subscribes (simulating an open SSE stream).
    paper = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    instance = await registry.get(paper, doc_id)
    bob_q = await instance.subscribe(client_id=42, actor_id="bob")
    alice_q = await instance.subscribe(client_id=43, actor_id="alice")

    assert len(instance.subscribers) == 2

    # Alice removes bob from shares.
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/share",
        json={"visibility": "private", "shares": []},
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 200

    # Bob's queue gets a 'closed' sentinel and is removed; alice's queue stays.
    payload = await asyncio.wait_for(bob_q.get(), timeout=1.0)
    assert payload == {"kind": "closed"}
    assert bob_q not in instance.subscribers
    assert alice_q in instance.subscribers


@pytest.mark.asyncio
async def test_revocation_keeps_owner_subscribed():
    """Owner's subscribers survive a share-state mutation."""
    from datasette_paper.db import PaperDB
    from datasette_paper.instance import get_registry

    ds = await _make_ds()
    doc_id = await _alice_doc(ds)

    paper = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    instance = await registry.get(paper, doc_id)
    alice_q = await instance.subscribe(client_id=1, actor_id="alice")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/share",
        json={
            "visibility": "link-view",
            "shares": [{"actorID": "bob", "role": "viewer"}],
        },
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 200

    # Alice still subscribed; no payload.
    assert alice_q in instance.subscribers
