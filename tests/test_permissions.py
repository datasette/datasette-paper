"""Tests for the datasette-paper permission model.

Global ``datasette-paper-list`` / ``datasette-paper-create`` come from the
config-permissions plugin; per-doc ``paper-view`` / ``paper-edit`` /
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
# Anonymous denied — list / create / SSE
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_anonymous_denied_html_index():
    ds = await _make_ds({})
    resp = await ds.client.get("/-/paper/")
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_anonymous_denied_api_list():
    ds = await _make_ds({})
    resp = await ds.client.get("/-/paper/api/docs")
    assert resp.status_code == 403


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
async def test_actor_with_list_access_can_list():
    """Permission granted to a specific actor id; that actor passes the gate."""
    ds = await _make_ds({"datasette-paper-list": {"id": "alice"}})

    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    resp = await ds.client.get("/-/paper/api/docs", cookies=cookies)
    assert resp.status_code == 200

    cookies_bob = {"ds_actor": _actor_cookie(ds, "bob")}
    resp2 = await ds.client.get("/-/paper/api/docs", cookies=cookies_bob)
    assert resp2.status_code == 403


@pytest.mark.asyncio
async def test_create_requires_create_permission():
    """list-only is not enough to create — also-requires chain works."""
    ds = await _make_ds({"datasette-paper-list": True})  # no create

    resp = await ds.client.post("/-/paper/api/docs", json={"name": "X"})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_full_grant_unblocks_full_owner_path():
    """End-to-end: with list+create granted, alice can create + access her doc."""
    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
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

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})

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

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
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

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
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

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
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

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
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

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    res = PaperDocResource(doc_id)
    # Bob has no view grant — edit's also_requires=view kicks in.
    assert not await ds.allowed(action="paper-edit", resource=res, actor={"id": "bob"})
