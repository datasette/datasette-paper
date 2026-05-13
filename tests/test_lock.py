"""Tests for the read-only (locked) capability flag.

Covers three layers:

* Permissions hook — locked papers deny edit to shared editors and
  link-edit visibility actors; owner always retains edit.
* Routes — /lock and /unlock are owner-only and surface ``locked`` /
  ``canEdit`` in the bootstrap envelope.
* SSE — flipping the lock broadcasts a ``permissions-changed`` event
  to every open subscriber with their newly-computed ``canEdit``.
"""

from __future__ import annotations

import asyncio

import pytest
from datasette.app import Datasette

from datasette_paper.db import PaperDB
from datasette_paper.instance import get_registry
from datasette_paper.permissions import PaperResource


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
    r = await ds.client.post(
        "/-/paper/api/docs", json={"name": name}, cookies=_cookie(ds, "alice")
    )
    assert r.status_code == 201
    return r.json()["id"]


async def _grant_share(ds, doc_id, actor_id, role):
    await ds.get_internal_database().execute_write(
        "INSERT INTO _datasette_paper_share (doc_id, actor_id, role, granted_by) "
        "VALUES (?, ?, ?, 'alice')",
        [doc_id, actor_id, role],
    )


# ---------------------------------------------------------------------------
# Permissions hook
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lock_denies_edit_to_editor_share():
    """When a doc is locked, a shared editor loses edit but keeps view."""
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    await _grant_share(ds, doc_id, "bob", "editor")

    # Baseline: bob can edit.
    assert await ds.allowed(
        action="datasette-paper-edit",
        resource=PaperResource(doc_id),
        actor={"id": "bob"},
    )

    # Lock it.
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=_cookie(ds, "alice")
    )
    assert r.status_code == 200

    # Bob loses edit but keeps view.
    assert not await ds.allowed(
        action="datasette-paper-edit",
        resource=PaperResource(doc_id),
        actor={"id": "bob"},
    )
    assert await ds.allowed(
        action="datasette-paper-view",
        resource=PaperResource(doc_id),
        actor={"id": "bob"},
    )


@pytest.mark.asyncio
async def test_lock_denies_edit_to_link_edit_visibility():
    """Locked doc with link-edit visibility denies edit to listed actors."""
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/share",
        json={"visibility": "link-edit", "shares": []},
        cookies=_cookie(ds, "alice"),
    )

    # Stranger can edit via link-edit visibility before lock.
    assert await ds.allowed(
        action="datasette-paper-edit",
        resource=PaperResource(doc_id),
        actor={"id": "carol"},
    )

    # Lock.
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=_cookie(ds, "alice")
    )
    assert r.status_code == 200

    # Strangers still view but can't edit.
    assert await ds.allowed(
        action="datasette-paper-view",
        resource=PaperResource(doc_id),
        actor={"id": "carol"},
    )
    assert not await ds.allowed(
        action="datasette-paper-edit",
        resource=PaperResource(doc_id),
        actor={"id": "carol"},
    )


@pytest.mark.asyncio
async def test_lock_keeps_owner_edit():
    """Owner can always edit (and therefore unlock) a locked doc."""
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=_cookie(ds, "alice")
    )

    assert await ds.allowed(
        action="datasette-paper-edit",
        resource=PaperResource(doc_id),
        actor={"id": "alice"},
    )


@pytest.mark.asyncio
async def test_unlock_restores_edit():
    """Unlocking brings shared editors back to editable."""
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    await _grant_share(ds, doc_id, "bob", "editor")

    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=_cookie(ds, "alice")
    )
    assert not await ds.allowed(
        action="datasette-paper-edit",
        resource=PaperResource(doc_id),
        actor={"id": "bob"},
    )

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/unlock", cookies=_cookie(ds, "alice")
    )
    assert r.status_code == 200
    assert await ds.allowed(
        action="datasette-paper-edit",
        resource=PaperResource(doc_id),
        actor={"id": "bob"},
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lock_route_is_owner_only():
    """Editor-share recipients cannot lock the doc — owner-only."""
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    await _grant_share(ds, doc_id, "bob", "editor")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=_cookie(ds, "bob")
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_lock_route_404_for_unknown_doc():
    ds = await _make_ds()
    # Need to create-then-delete to slip past the also_requires chain.
    doc_id = await _alice_doc(ds)
    paper = PaperDB(ds.get_internal_database())
    await paper.hard_delete_doc(doc_id=doc_id)

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=_cookie(ds, "alice")
    )
    # The doc was viewable+editable (owner-by-id) before delete; the
    # post-delete refetch returns 404.
    assert r.status_code in (403, 404)


@pytest.mark.asyncio
async def test_bootstrap_envelope_reflects_locked():
    """GET /-/paper/api/docs/{id} surfaces locked + canEdit consistently."""
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    await _grant_share(ds, doc_id, "bob", "editor")

    # Unlocked: bob sees canEdit=True, permissions.locked=False.
    r = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}", cookies=_cookie(ds, "bob")
    )
    assert r.status_code == 200
    body = r.json()
    assert body["permissions"]["locked"] is False
    assert body["permissions"]["canEdit"] is True

    # Lock.
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=_cookie(ds, "alice")
    )

    # Now bob sees permissions.locked=True and loses canEdit; canView stays.
    r2 = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}", cookies=_cookie(ds, "bob")
    )
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["permissions"]["locked"] is True
    assert body2["permissions"]["canEdit"] is False
    assert body2["permissions"]["canView"] is True


@pytest.mark.asyncio
async def test_list_endpoint_surfaces_locked():
    """List rows include the locked flag for client-side badges."""
    ds = await _make_ds()
    doc_id = await _alice_doc(ds, name="L")
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=_cookie(ds, "alice")
    )

    r = await ds.client.get("/-/paper/api/docs", cookies=_cookie(ds, "alice"))
    assert r.status_code == 200
    rows = r.json()
    by_id = {row["id"]: row for row in rows}
    assert by_id[doc_id]["locked"] is True
    assert by_id[doc_id]["kind"] == "doc"


# ---------------------------------------------------------------------------
# SSE broadcast
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lock_broadcasts_permissions_changed_to_subscribers():
    """Locking a doc pushes a permissions-changed event per subscriber.

    Owner subscriber sees canEdit=True; editor-share subscriber sees
    canEdit=False. Both stay subscribed.
    """
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    await _grant_share(ds, doc_id, "bob", "editor")

    paper = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    instance = await registry.get(paper, doc_id)

    alice_q = await instance.subscribe(client_id=1, actor_id="alice")
    bob_q = await instance.subscribe(client_id=2, actor_id="bob")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=_cookie(ds, "alice")
    )
    assert r.status_code == 200

    alice_payload = await asyncio.wait_for(alice_q.get(), timeout=1.0)
    bob_payload = await asyncio.wait_for(bob_q.get(), timeout=1.0)

    assert alice_payload == {
        "kind": "permissions-changed",
        "canEdit": True,
        "locked": True,
    }
    assert bob_payload == {
        "kind": "permissions-changed",
        "canEdit": False,
        "locked": True,
    }

    # Both subscribers remain — locking doesn't disconnect anyone.
    assert alice_q in instance.subscribers
    assert bob_q in instance.subscribers


@pytest.mark.asyncio
async def test_unlock_broadcasts_permissions_changed():
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)
    await _grant_share(ds, doc_id, "bob", "editor")

    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=_cookie(ds, "alice")
    )

    paper = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    instance = await registry.get(paper, doc_id)
    bob_q = await instance.subscribe(client_id=2, actor_id="bob")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/unlock", cookies=_cookie(ds, "alice")
    )
    assert r.status_code == 200

    payload = await asyncio.wait_for(bob_q.get(), timeout=1.0)
    assert payload == {
        "kind": "permissions-changed",
        "canEdit": True,
        "locked": False,
    }
