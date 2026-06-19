"""Tests for the datasette-paper permission model.

The global ``datasette-paper-create`` action comes from the config-permissions
plugin (listing is ungated); per-doc ``paper-view`` / ``paper-edit`` /
``paper-manage`` resolve against datasette-acl grants on ``PaperDocResource``.
The creator gets a Manager grant seeded on create; further access is granted
through acl. The only bespoke rule paper still owns is the ``locked`` deny.
"""

import pytest
from datasette.app import Datasette


async def _make_ds(permissions_config):
    """Build an in-memory Datasette + run startup so actions register."""
    ds = Datasette(memory=True, config={"permissions": permissions_config})
    await ds.invoke_startup()
    return ds


def _actor_cookie(ds, actor_id):
    return ds.sign({"a": {"id": actor_id}}, "actor")


async def _grant_acl(ds, doc_id, actor_id, role):
    """Grant ``actor_id`` an acl role (Viewer/Editor/Manager) on the doc."""
    from datasette_acl.grants import grant, Principal
    from datasette_paper.permissions import (
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
    )

    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.actor(actor_id),
        role=role,
        by_actor="alice",
    )


async def _revoke_acl(ds, doc_id, actor_id):
    from datasette_acl.grants import revoke, Principal
    from datasette_paper.permissions import (
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
    )

    await revoke(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.actor(actor_id),
        by_actor="alice",
    )


# ---------------------------------------------------------------------------
# Listing is ungated — index / api/docs reachable by anyone, acl-filtered
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_anonymous_can_load_html_index():
    """The index shell is ungated; the client fetches acl-filtered data."""
    ds = await _make_ds({})
    resp = await ds.client.get("/-/paper/")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_anonymous_api_list_ok_but_empty():
    """Anonymous gets 200 from the list endpoint, but sees no docs (no grants)."""
    ds = await _make_ds({})
    resp = await ds.client.get("/-/paper/api/docs")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_ungated_returns_only_viewable():
    """Any actor can hit the list endpoint; results are acl-filtered per actor."""
    ds = await _make_ds({"datasette-paper-create": True})

    # Alice creates a doc (owner → Manager grant).
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "A"}, cookies=cookies)
    doc_id = r.json()["id"]

    # Alice sees it; bob (no grant) gets 200 with an empty list.
    r = await ds.client.get("/-/paper/api/docs", cookies=cookies)
    assert r.status_code == 200
    assert [d["id"] for d in r.json()] == [doc_id]

    cookies_bob = {"ds_actor": _actor_cookie(ds, "bob")}
    r2 = await ds.client.get("/-/paper/api/docs", cookies=cookies_bob)
    assert r2.status_code == 200
    assert r2.json() == []


# ---------------------------------------------------------------------------
# Anonymous denied — create / SSE (still gated)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_anonymous_denied_api_post():
    ds = await _make_ds({})
    resp = await ds.client.post("/-/paper/api/docs", json={"name": "Hello"})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_sse_403_for_anonymous():
    ds = await _make_ds({})
    resp = await ds.client.get("/-/paper/api/docs/1/events?version=0")
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Granted-actor positive paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_requires_create_permission():
    """Listing is ungated, but creating still needs datasette-paper-create."""
    ds = await _make_ds({})  # nothing granted

    resp = await ds.client.post("/-/paper/api/docs", json={"name": "X"})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_full_grant_unblocks_full_owner_path():
    """End-to-end: with create granted, alice can create + access her doc."""
    ds = await _make_ds({"datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}

    r = await ds.client.get("/-/paper/api/docs", cookies=cookies)
    assert r.status_code == 200

    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    assert r.status_code == 201
    doc_id = r.json()["id"]
    assert r.json()["created_by"] == "alice"

    # Owner can view + manage their paper
    r = await ds.client.get(f"/-/paper/api/docs/{doc_id}", cookies=cookies)
    assert r.status_code == 200

    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/snapshot",
        json={},
        cookies=cookies,
    )
    assert r.status_code == 200

    r = await ds.client.get("/-/paper/", cookies=cookies)
    assert r.status_code == 200
    r = await ds.client.get(f"/-/paper/doc/{doc_id}", cookies=cookies)
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Resource-level permissions (acl-resolved paper-doc actions)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_can_view_edit_manage_own_paper():
    """Creator gets a Manager grant on create — full access, no lockout."""
    from datasette_paper.permissions import PaperDocResource

    ds = await _make_ds({"datasette-paper-create": True})

    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    res = PaperDocResource(doc_id)
    for action in ("paper-view", "paper-edit", "paper-manage"):
        assert await ds.allowed(action=action, resource=res, actor={"id": "alice"}), (
            action
        )


@pytest.mark.asyncio
async def test_stranger_denied_on_private_paper():
    from datasette_paper.permissions import PaperDocResource

    ds = await _make_ds({"datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    res = PaperDocResource(doc_id)
    # Bob has list+create but no acl grant on the doc — deny by default.
    assert not await ds.allowed(action="paper-view", resource=res, actor={"id": "bob"})
    assert not await ds.allowed(action="paper-edit", resource=res, actor={"id": "bob"})


@pytest.mark.asyncio
async def test_viewer_grant_can_view_not_edit():
    from datasette_paper.permissions import PaperDocResource

    ds = await _make_ds({"datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    await _grant_acl(ds, doc_id, "bob", "Viewer")

    res = PaperDocResource(doc_id)
    assert await ds.allowed(action="paper-view", resource=res, actor={"id": "bob"})
    assert not await ds.allowed(action="paper-edit", resource=res, actor={"id": "bob"})


@pytest.mark.asyncio
async def test_editor_grant_can_view_and_edit_revoke_denies():
    """With an Editor grant, edit is allowed; revoking it denies again."""
    from datasette_paper.permissions import PaperDocResource

    ds = await _make_ds({"datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    await _grant_acl(ds, doc_id, "bob", "Editor")

    res = PaperDocResource(doc_id)
    assert await ds.allowed(action="paper-view", resource=res, actor={"id": "bob"})
    assert await ds.allowed(action="paper-edit", resource=res, actor={"id": "bob"})

    # Revoke → deny by default.
    await _revoke_acl(ds, doc_id, "bob")
    assert not await ds.allowed(action="paper-view", resource=res, actor={"id": "bob"})
    assert not await ds.allowed(action="paper-edit", resource=res, actor={"id": "bob"})


@pytest.mark.asyncio
async def test_anonymous_never_owns_even_with_null_created_by():
    """Anonymous (actor=None) gets no per-doc access without a grant."""
    from datasette_paper.db import PaperDB
    from datasette_paper.permissions import PaperDocResource

    ds = await _make_ds({"datasette-paper-create": True})
    paper = PaperDB(ds.get_internal_database())
    # Anonymous-created doc (created_by IS NULL).
    doc = await paper.insert_doc(name="Orphan", created_by=None)

    res = PaperDocResource(doc.id)
    assert not await ds.allowed(action="paper-view", resource=res, actor=None)
    assert not await ds.allowed(action="paper-edit", resource=res, actor=None)


@pytest.mark.asyncio
async def test_also_requires_chain_blocks_edit_when_view_denied():
    """edit also-requires view; an actor with no grant is denied edit."""
    from datasette_paper.permissions import PaperDocResource

    ds = await _make_ds({"datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    res = PaperDocResource(doc_id)
    # Bob has no view grant — edit's also_requires=view kicks in.
    assert not await ds.allowed(action="paper-edit", resource=res, actor={"id": "bob"})


# ---------------------------------------------------------------------------
# viewable_doc_ids — enumerate every doc the actor can view (drains pagination)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_viewable_doc_ids_owner_sees_own():
    from datasette_paper.permissions import viewable_doc_ids

    ds = await _make_ds({"datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    assert doc_id in await viewable_doc_ids(ds, {"id": "alice"})


@pytest.mark.asyncio
async def test_viewable_doc_ids_stranger_excluded():
    from datasette_paper.permissions import viewable_doc_ids

    ds = await _make_ds({"datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    # Bob has no acl grant on alice's doc — it must not appear.
    assert doc_id not in await viewable_doc_ids(ds, {"id": "bob"})


@pytest.mark.asyncio
async def test_viewable_doc_ids_viewer_grant_included():
    from datasette_paper.permissions import viewable_doc_ids

    ds = await _make_ds({"datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    await _grant_acl(ds, doc_id, "bob", "Viewer")

    assert doc_id in await viewable_doc_ids(ds, {"id": "bob"})


@pytest.mark.asyncio
async def test_viewable_doc_ids_anonymous_empty():
    from datasette_paper.permissions import viewable_doc_ids

    ds = await _make_ds({"datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    assert r.status_code == 201

    # Anonymous (actor=None) has no grant on alice's private doc.
    assert await viewable_doc_ids(ds, None) == []


# TODO: drain test — assert >100 viewable docs all returned (proves
# pagination drain)
