"""Tests for the read-only (locked) capability flag.

Covers three layers:

* Permissions hook — locked papers deny edit to *everyone* including
  the owner (via an explicit deny rule that overrides any broader
  allow grant). The owner restores edit via the dedicated /unlock
  route, which gates on view + an inline owner check so the lock
  can't trap them.
* Routes — /lock and /unlock are owner-only and surface ``locked`` /
  ``canEdit`` in the bootstrap envelope. Other manage routes
  (archive, trash, etc.) stay reachable on a locked doc.
* SSE — flipping the lock broadcasts a ``permissions-changed`` event
  to every open subscriber with their newly-computed ``canEdit``.
"""

from __future__ import annotations

import asyncio

import pytest

from conftest import actor_cookie, build_ds, create_doc, grant_role
from datasette_paper.db import PaperDB
from datasette_paper.instance import get_registry
from datasette_paper.permissions import PaperDocResource


# ---------------------------------------------------------------------------
# Permissions hook
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lock_denies_edit_to_editor_share():
    """When a doc is locked, a shared editor loses edit but keeps view."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    await grant_role(ds, doc_id, "bob", "Editor")

    # Baseline: bob can edit.
    assert await ds.allowed(
        action="paper-edit",
        resource=PaperDocResource(doc_id),
        actor={"id": "bob"},
    )

    # Lock it.
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )
    assert r.status_code == 200

    # Bob loses edit but keeps view.
    assert not await ds.allowed(
        action="paper-edit",
        resource=PaperDocResource(doc_id),
        actor={"id": "bob"},
    )
    assert await ds.allowed(
        action="paper-view",
        resource=PaperDocResource(doc_id),
        actor={"id": "bob"},
    )


@pytest.mark.asyncio
async def test_lock_deny_composes_over_grant():
    """The locked deny wins over any acl edit grant; view is unaffected."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    await grant_role(ds, doc_id, "carol", "Editor")

    # Editor grant gives carol edit before the lock.
    assert await ds.allowed(
        action="paper-edit",
        resource=PaperDocResource(doc_id),
        actor={"id": "carol"},
    )

    # Lock.
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )
    assert r.status_code == 200

    # The deny composes over the grant: carol still views but can't edit.
    assert await ds.allowed(
        action="paper-view",
        resource=PaperDocResource(doc_id),
        actor={"id": "carol"},
    )
    assert not await ds.allowed(
        action="paper-edit",
        resource=PaperDocResource(doc_id),
        actor={"id": "carol"},
    )


@pytest.mark.asyncio
async def test_lock_denies_edit_to_owner_too():
    """Lock means lock — even the owner loses edit. They use /unlock
    (which goes through the view-based _ensure_owner gate) to restore
    it. Without this, the lock is a no-op from the owner's perspective:
    they can keep typing into a "locked" doc, which is the surprise
    behavior the user reported.
    """
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")

    # Baseline: alice can edit her own doc.
    assert await ds.allowed(
        action="paper-edit",
        resource=PaperDocResource(doc_id),
        actor={"id": "alice"},
    )

    # Lock.
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )

    # Owner loses edit. View stays.
    assert not await ds.allowed(
        action="paper-edit",
        resource=PaperDocResource(doc_id),
        actor={"id": "alice"},
    )
    assert await ds.allowed(
        action="paper-view",
        resource=PaperDocResource(doc_id),
        actor={"id": "alice"},
    )


@pytest.mark.asyncio
async def test_owner_can_unlock_their_own_locked_doc():
    """The lock can't trap the owner — /unlock gates on view+owner,
    not edit, so it stays reachable when canEdit is False."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )
    # Sanity: alice cannot edit while locked.
    assert not await ds.allowed(
        action="paper-edit",
        resource=PaperDocResource(doc_id),
        actor={"id": "alice"},
    )

    # Unlock works even though alice has no edit.
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/unlock", cookies=actor_cookie(ds, "alice")
    )
    assert r.status_code == 200

    # Edit restored.
    assert await ds.allowed(
        action="paper-edit",
        resource=PaperDocResource(doc_id),
        actor={"id": "alice"},
    )


@pytest.mark.asyncio
async def test_owner_bootstrap_envelope_after_lock_has_canEdit_false():
    """Same flow the live HTTP probe takes: owner creates doc, locks
    it, GETs the bootstrap envelope. Pinned because a regression here
    would surface as "I locked but I can still edit" in the editor
    even if the lower-level ``ds.allowed`` returns False.
    """
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    lock_resp = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )
    assert lock_resp.status_code == 200

    r = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}", cookies=actor_cookie(ds, "alice")
    )
    assert r.status_code == 200
    perms = r.json()["permissions"]
    assert perms["locked"] is True
    assert perms["isOwner"] is True
    assert perms["canEdit"] is False


@pytest.mark.asyncio
async def test_owner_can_archive_locked_doc():
    """Manage operations stay reachable for the owner of a locked doc."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/archive", cookies=actor_cookie(ds, "alice")
    )
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_post_events_403_for_owner_of_locked_doc():
    """The actual edit pipeline (POST /events) refuses the owner's
    steps when the doc is locked. This is the route the in-browser
    editor uses for every keystroke batch — covered explicitly because
    it's the user-visible "I locked it but I can still edit" symptom."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")

    # Sanity: alice can post events on her own unlocked doc.
    r_unlocked = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/events",
        json={
            "version": 0,
            "clientID": 1,
            "steps": [
                {
                    "stepType": "replace",
                    "from": 1,
                    "to": 1,
                    "slice": {"content": [{"type": "text", "text": "hi"}]},
                }
            ],
        },
        cookies=actor_cookie(ds, "alice"),
    )
    assert r_unlocked.status_code == 200

    # Lock.
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )

    # Now alice's step POST is rejected with 403 — locked doc is
    # genuinely read-only for everyone including the owner.
    r_locked = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/events",
        json={
            "version": 1,
            "clientID": 1,
            "steps": [
                {
                    "stepType": "replace",
                    "from": 3,
                    "to": 3,
                    "slice": {"content": [{"type": "text", "text": "x"}]},
                }
            ],
        },
        cookies=actor_cookie(ds, "alice"),
    )
    assert r_locked.status_code == 403


@pytest.mark.asyncio
async def test_unlock_restores_edit():
    """Unlocking brings shared editors back to editable."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    await grant_role(ds, doc_id, "bob", "Editor")

    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )
    assert not await ds.allowed(
        action="paper-edit",
        resource=PaperDocResource(doc_id),
        actor={"id": "bob"},
    )

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/unlock", cookies=actor_cookie(ds, "alice")
    )
    assert r.status_code == 200
    assert await ds.allowed(
        action="paper-edit",
        resource=PaperDocResource(doc_id),
        actor={"id": "bob"},
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lock_route_is_owner_only():
    """Editor-share recipients cannot lock the doc — owner-only."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    await grant_role(ds, doc_id, "bob", "Editor")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "bob")
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_lock_route_404_for_unknown_doc():
    ds = await build_ds()
    # Need to create-then-delete to slip past the also_requires chain.
    doc_id = await create_doc(ds, "P")
    paper = PaperDB(ds.get_internal_database())
    await paper.hard_delete_doc(doc_id=doc_id)

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )
    # The doc was viewable+editable (owner-by-id) before delete; the
    # post-delete refetch returns 404.
    assert r.status_code in (403, 404)


@pytest.mark.asyncio
async def test_bootstrap_envelope_reflects_locked():
    """GET /-/paper/api/docs/{id} surfaces locked + canEdit consistently."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    await grant_role(ds, doc_id, "bob", "Editor")

    # Unlocked: bob sees canEdit=True, permissions.locked=False.
    r = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}", cookies=actor_cookie(ds, "bob")
    )
    assert r.status_code == 200
    body = r.json()
    assert body["permissions"]["locked"] is False
    assert body["permissions"]["canEdit"] is True

    # Lock.
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )

    # Now bob sees permissions.locked=True and loses canEdit; canView stays.
    r2 = await ds.client.get(
        f"/-/paper/api/docs/{doc_id}", cookies=actor_cookie(ds, "bob")
    )
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["permissions"]["locked"] is True
    assert body2["permissions"]["canEdit"] is False
    assert body2["permissions"]["canView"] is True


@pytest.mark.asyncio
async def test_list_endpoint_surfaces_locked():
    """List rows include the locked flag for client-side badges."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "L")
    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )

    r = await ds.client.get("/-/paper/api/docs", cookies=actor_cookie(ds, "alice"))
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

    Lock is universal — even the owner sees canEdit=False so the
    editor flips into read-only mode. The owner restores edit via
    the dedicated /unlock route (which doesn't go through the edit
    gate). Both subscribers stay connected; lock never disconnects.
    """
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    await grant_role(ds, doc_id, "bob", "Editor")

    paper = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    instance = await registry.get(paper, doc_id)

    alice_q = await instance.subscribe(client_id=1, actor_id="alice")
    bob_q = await instance.subscribe(client_id=2, actor_id="bob")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )
    assert r.status_code == 200

    alice_payload = await asyncio.wait_for(alice_q.get(), timeout=1.0)
    bob_payload = await asyncio.wait_for(bob_q.get(), timeout=1.0)

    assert alice_payload == {
        "kind": "permissions-changed",
        "canEdit": False,
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
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    await grant_role(ds, doc_id, "bob", "Editor")

    await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/lock", cookies=actor_cookie(ds, "alice")
    )

    paper = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    instance = await registry.get(paper, doc_id)
    bob_q = await instance.subscribe(client_id=2, actor_id="bob")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/unlock", cookies=actor_cookie(ds, "alice")
    )
    assert r.status_code == 200

    payload = await asyncio.wait_for(bob_q.get(), timeout=1.0)
    assert payload == {
        "kind": "permissions-changed",
        "canEdit": True,
        "locked": False,
    }
