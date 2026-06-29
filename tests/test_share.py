"""Tests for the SSE subscriber-revocation sweep (phase-05/04).

Sharing itself now lives in datasette-acl: the ``<datasette-acl-share-dialog>``
component grants / updates / revokes acl grants directly against the acl JSON
API, and paper no longer ships its own ``GET/POST /share`` routes or a share
table. What paper keeps is the *SSE subscriber sweep*: when a grant is revoked
the dialog fires ``share-revoked`` and the frontend POSTs
``/-/paper/api/docs/{id}/sweep-subscribers``, which runs
``Instance.revoke_unauthorized`` so a demoted/removed editor's live SSE queue is
closed. These tests cover that endpoint and the underlying sweep.
"""

from __future__ import annotations

import asyncio

import pytest

from conftest import actor_cookie, build_ds, create_doc, grant_role, revoke_role


# ---------------------------------------------------------------------------
# POST /sweep-subscribers — manager-only permission surface
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sweep_owner_allowed():
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/sweep-subscribers",
        cookies=actor_cookie(ds, "alice"),
    )
    assert r.status_code == 200
    # No live subscribers, so nothing to revoke.
    assert r.json() == {"revoked": 0}


@pytest.mark.asyncio
async def test_sweep_viewer_403():
    """A viewer (can view, not manage) cannot trigger the sweep."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    await grant_role(ds, doc_id, "bob", "Viewer")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/sweep-subscribers",
        cookies=actor_cookie(ds, "bob"),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_sweep_editor_403():
    """An acl Editor can view + edit but not manage — sweep is manager-only."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    await grant_role(ds, doc_id, "bob", "Editor")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/sweep-subscribers",
        cookies=actor_cookie(ds, "bob"),
    )
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_sweep_stranger_403():
    """A stranger can't even see the doc — view pre-check returns 403."""
    ds = await build_ds()
    doc_id = await create_doc(ds, "P")

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/sweep-subscribers",
        cookies=actor_cookie(ds, "carol"),
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Revocation sweep behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sweep_endpoint_closes_revoked_subscriber():
    """End-to-end: revoke bob via acl, hit the sweep endpoint, his queue closes."""
    from datasette_paper.db import PaperDB
    from datasette_paper.instance import get_registry

    ds = await build_ds()
    doc_id = await create_doc(ds, "P")
    await grant_role(ds, doc_id, "bob", "Editor")

    paper = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    instance = await registry.get(paper, doc_id)
    bob_q = await instance.subscribe(client_id=42, actor_id="bob")
    alice_q = await instance.subscribe(client_id=43, actor_id="alice")
    assert len(instance.subscribers) == 2

    # Bob's grant is revoked (as the dialog would do against acl), then the
    # frontend's share-revoked handler calls the sweep endpoint.
    await revoke_role(ds, doc_id, "bob")
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/sweep-subscribers",
        cookies=actor_cookie(ds, "alice"),
    )
    assert r.status_code == 200
    assert r.json() == {"revoked": 1}

    # Bob's queue gets a 'closed' sentinel and is removed; alice's queue stays.
    payload = await asyncio.wait_for(bob_q.get(), timeout=1.0)
    assert payload == {"kind": "closed"}
    assert bob_q not in instance.subscribers
    assert alice_q in instance.subscribers


@pytest.mark.asyncio
async def test_revocation_closes_open_subscribers():
    """After bob loses acl access, the revocation sweep closes his queue."""
    from datasette_paper.db import PaperDB
    from datasette_paper.instance import get_registry

    ds = await build_ds()
    doc_id = await create_doc(ds, "P")

    # Grant bob view access via acl.
    await grant_role(ds, doc_id, "bob", "Editor")

    # Bob subscribes (simulating an open SSE stream).
    paper = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    instance = await registry.get(paper, doc_id)
    bob_q = await instance.subscribe(client_id=42, actor_id="bob")
    alice_q = await instance.subscribe(client_id=43, actor_id="alice")

    assert len(instance.subscribers) == 2

    # Bob's acl grant is revoked; the sweep then closes his queue.
    await revoke_role(ds, doc_id, "bob")
    revoked = await instance.revoke_unauthorized(ds)
    assert revoked == 1

    # Bob's queue gets a 'closed' sentinel and is removed; alice's queue stays.
    payload = await asyncio.wait_for(bob_q.get(), timeout=1.0)
    assert payload == {"kind": "closed"}
    assert bob_q not in instance.subscribers
    assert alice_q in instance.subscribers


@pytest.mark.asyncio
async def test_revocation_keeps_owner_subscribed():
    """Owner's subscribers survive a sweep (they always pass paper-view)."""
    from datasette_paper.db import PaperDB
    from datasette_paper.instance import get_registry

    ds = await build_ds()
    doc_id = await create_doc(ds, "P")

    paper = PaperDB(ds.get_internal_database())
    registry = get_registry(ds)
    instance = await registry.get(paper, doc_id)
    alice_q = await instance.subscribe(client_id=1, actor_id="alice")

    # Grant + immediately revoke an unrelated actor, then sweep.
    await grant_role(ds, doc_id, "bob", "Viewer")
    await revoke_role(ds, doc_id, "bob")
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/sweep-subscribers",
        cookies=actor_cookie(ds, "alice"),
    )
    assert r.status_code == 200

    # Alice still subscribed; no payload.
    assert alice_q in instance.subscribers
