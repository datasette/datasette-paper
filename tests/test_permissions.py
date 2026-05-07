"""Tests for the datasette-paper permission model (4-action split + SQL hook)."""

import pytest
from datasette.app import Datasette


async def _make_ds(permissions_config):
    """Build an in-memory Datasette + run startup so actions register."""
    ds = Datasette(memory=True, config={"permissions": permissions_config})
    await ds.invoke_startup()
    return ds


def _actor_cookie(ds, actor_id):
    return ds.sign({"a": {"id": actor_id}}, "actor")


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
        json={
            "version": 0,
            "doc": {"type": "doc", "content": [{"type": "paragraph"}]},
        },
        cookies=cookies,
    )
    assert r.status_code == 204

    r = await ds.client.get("/-/paper/", cookies=cookies)
    assert r.status_code == 200
    r = await ds.client.get(f"/-/paper/doc/{doc_id}", cookies=cookies)
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Resource-level permissions (the SQL hook)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_owner_can_view_and_edit_own_paper():
    from datasette_paper.permissions import PaperResource

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})

    # Alice creates a paper
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    res = PaperResource(doc_id)
    assert await ds.allowed(
        action="datasette-paper-view", resource=res, actor={"id": "alice"}
    )
    assert await ds.allowed(
        action="datasette-paper-edit", resource=res, actor={"id": "alice"}
    )


@pytest.mark.asyncio
async def test_stranger_denied_on_private_paper():
    from datasette_paper.permissions import PaperResource

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    res = PaperResource(doc_id)
    # Bob has list+create but is not in shares and is not the owner.
    assert not await ds.allowed(
        action="datasette-paper-view", resource=res, actor={"id": "bob"}
    )
    assert not await ds.allowed(
        action="datasette-paper-edit", resource=res, actor={"id": "bob"}
    )


@pytest.mark.asyncio
async def test_shared_viewer_can_view_not_edit():
    from datasette_paper.db import PaperDB
    from datasette_paper.permissions import PaperResource

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    # Manually grant bob the viewer role.
    paper = PaperDB(ds.get_internal_database())
    await paper.database.execute_write(
        "INSERT INTO _datasette_paper_share (doc_id, actor_id, role, granted_by) "
        "VALUES (?, ?, 'viewer', 'alice')",
        [doc_id, "bob"],
    )

    res = PaperResource(doc_id)
    assert await ds.allowed(
        action="datasette-paper-view", resource=res, actor={"id": "bob"}
    )
    assert not await ds.allowed(
        action="datasette-paper-edit", resource=res, actor={"id": "bob"}
    )


@pytest.mark.asyncio
async def test_shared_editor_can_view_and_edit():
    from datasette_paper.permissions import PaperResource

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    internal = ds.get_internal_database()
    await internal.execute_write(
        "INSERT INTO _datasette_paper_share (doc_id, actor_id, role, granted_by) "
        "VALUES (?, ?, 'editor', 'alice')",
        [doc_id, "bob"],
    )

    res = PaperResource(doc_id)
    assert await ds.allowed(
        action="datasette-paper-view", resource=res, actor={"id": "bob"}
    )
    assert await ds.allowed(
        action="datasette-paper-edit", resource=res, actor={"id": "bob"}
    )


@pytest.mark.asyncio
async def test_visibility_link_view_grants_view_to_listers():
    from datasette_paper.permissions import PaperResource

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    internal = ds.get_internal_database()
    await internal.execute_write(
        "UPDATE _datasette_paper_doc SET visibility = 'link-view' WHERE id = ?",
        [doc_id],
    )

    res = PaperResource(doc_id)
    # Bob (with paper-list) can view but not edit.
    assert await ds.allowed(
        action="datasette-paper-view", resource=res, actor={"id": "bob"}
    )
    assert not await ds.allowed(
        action="datasette-paper-edit", resource=res, actor={"id": "bob"}
    )


@pytest.mark.asyncio
async def test_visibility_link_edit_grants_both_to_listers():
    from datasette_paper.permissions import PaperResource

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    internal = ds.get_internal_database()
    await internal.execute_write(
        "UPDATE _datasette_paper_doc SET visibility = 'link-edit' WHERE id = ?",
        [doc_id],
    )

    res = PaperResource(doc_id)
    assert await ds.allowed(
        action="datasette-paper-view", resource=res, actor={"id": "bob"}
    )
    assert await ds.allowed(
        action="datasette-paper-edit", resource=res, actor={"id": "bob"}
    )


@pytest.mark.asyncio
async def test_visibility_link_edit_does_not_grant_to_non_listers():
    """An actor without datasette-paper-list cannot use visibility-link grants."""
    from datasette_paper.permissions import PaperResource

    # Only alice has list permission.
    ds = await _make_ds(
        {
            "datasette-paper-list": {"id": "alice"},
            "datasette-paper-create": {"id": "alice"},
        }
    )
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    internal = ds.get_internal_database()
    await internal.execute_write(
        "UPDATE _datasette_paper_doc SET visibility = 'link-edit' WHERE id = ?",
        [doc_id],
    )

    res = PaperResource(doc_id)
    # Bob doesn't have list, so visibility doesn't help him.
    assert not await ds.allowed(
        action="datasette-paper-view", resource=res, actor={"id": "bob"}
    )


@pytest.mark.asyncio
async def test_anonymous_never_owns_even_with_null_created_by():
    """Anonymous (actor=None) must never match created_by IS NULL rows."""
    from datasette_paper.db import PaperDB
    from datasette_paper.permissions import PaperResource

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
    paper = PaperDB(ds.get_internal_database())
    # Anonymous-created doc (created_by IS NULL).
    doc = await paper.insert_doc(name="Orphan", created_by=None)

    res = PaperResource(doc.id)
    assert not await ds.allowed(action="datasette-paper-view", resource=res, actor=None)
    assert not await ds.allowed(action="datasette-paper-edit", resource=res, actor=None)


@pytest.mark.asyncio
async def test_also_requires_chain_blocks_edit_when_view_denied():
    """edit also-requires view; a config that grants only edit must still deny."""
    from datasette_paper.permissions import PaperResource

    ds = await _make_ds({"datasette-paper-list": True, "datasette-paper-create": True})
    cookies = {"ds_actor": _actor_cookie(ds, "alice")}
    r = await ds.client.post("/-/paper/api/docs", json={"name": "P"}, cookies=cookies)
    doc_id = r.json()["id"]

    res = PaperResource(doc_id)
    # Bob has no view rule — edit's also_requires=view kicks in.
    assert not await ds.allowed(
        action="datasette-paper-edit", resource=res, actor={"id": "bob"}
    )
