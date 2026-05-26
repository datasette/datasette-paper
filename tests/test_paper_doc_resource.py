"""Tests for the acl-backed paper-doc resource model (phase-05/01).

These cover the *new* resource/actions/roles added alongside the legacy
``datasette-paper-{view,edit}`` string actions. They exercise the path that
task 02 will switch call sites onto: ``datasette.allowed(action="paper-edit",
resource=PaperDocResource(doc_id), ...)`` resolving against datasette-acl
grants written via acl's :func:`datasette_acl.grants.grant` helper.
"""

import pytest
from datasette.app import Datasette

from datasette_paper.db import PaperDB
from datasette_paper.permissions import (
    PAPER_DOC_ACTIONS,
    PAPER_DOC_RESOURCE_TYPE,
    PAPER_DOCS_PARENT,
    PaperDocResource,
)


async def _make_ds():
    """Datasette with paper-list/create granted + acl auto-loaded via entrypoint."""
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


def _actor_cookie(ds, actor_id):
    return ds.sign({"a": {"id": actor_id}}, "actor")


async def _create_doc(ds, actor_id="alice"):
    cookies = {"ds_actor": _actor_cookie(ds, actor_id)}
    r = await ds.client.post(
        "/-/paper/api/docs", json={"name": "P"}, cookies=cookies
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_new_actions_registered():
    ds = await _make_ds()
    for action in PAPER_DOC_ACTIONS:
        assert action in ds.actions, f"{action} not registered"
        assert ds.actions[action].resource_class is PaperDocResource

    # Legacy actions still registered (removed in task 02).
    for legacy in ("datasette-paper-view", "datasette-paper-edit"):
        assert legacy in ds.actions


@pytest.mark.asyncio
async def test_roles_registered():
    ds = await _make_ds()
    registry = getattr(ds, "_acl_roles_registry", {})
    roles = registry.get(PAPER_DOC_RESOURCE_TYPE)
    assert roles, "paper-doc roles not in acl registry"
    by_name = {r.name: r for r in roles}
    assert set(by_name) == {"Viewer", "Editor", "Manager"}
    assert by_name["Viewer"].actions == ["paper-view"]
    assert by_name["Editor"].actions == ["paper-view", "paper-edit"]
    assert by_name["Manager"].actions == [
        "paper-view",
        "paper-edit",
        "paper-manage",
    ]
    assert (by_name["Viewer"].rank, by_name["Editor"].rank, by_name["Manager"].rank) == (
        1,
        2,
        3,
    )
    assert by_name["Manager"].manage is True
    assert by_name["Viewer"].manage is False
    assert by_name["Editor"].manage is False


# ---------------------------------------------------------------------------
# resources_sql lists existing docs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resources_sql_lists_docs():
    ds = await _make_ds()
    paper = PaperDB(ds.get_internal_database())
    doc_a = await paper.insert_doc(name="A", created_by="alice")
    doc_b = await paper.insert_doc(name="B", created_by="bob")

    sql = await PaperDocResource.resources_sql(ds)
    rows = (await ds.get_internal_database().execute(sql)).rows
    pairs = {(row["parent"], row["child"]) for row in rows}
    assert (PAPER_DOCS_PARENT, str(doc_a.id)) in pairs
    assert (PAPER_DOCS_PARENT, str(doc_b.id)) in pairs


@pytest.mark.asyncio
async def test_resource_construction_parent_child():
    # Single-arg: doc id only → parent is the sentinel.
    res = PaperDocResource(42)
    assert res.parent == PAPER_DOCS_PARENT
    assert res.child == "42"
    # Two-arg matches acl.build_resource(parent, child).
    res2 = PaperDocResource(PAPER_DOCS_PARENT, 42)
    assert res2.parent == PAPER_DOCS_PARENT
    assert res2.child == "42"


@pytest.mark.asyncio
async def test_build_resource_roundtrips_via_acl():
    from datasette_acl.utils import build_resource

    ds = await _make_ds()
    res = build_resource(ds, PAPER_DOC_RESOURCE_TYPE, PAPER_DOCS_PARENT, "7")
    assert isinstance(res, PaperDocResource)
    assert res.parent == PAPER_DOCS_PARENT
    assert res.child == "7"


# ---------------------------------------------------------------------------
# Grants resolve via datasette.allowed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_editor_grant_allows_view_and_edit():
    from datasette_acl.grants import grant

    ds = await _make_ds()
    doc_id = await _create_doc(ds)
    res = PaperDocResource(doc_id)

    # Before any grant, bob has nothing.
    assert not await ds.allowed(
        action="paper-view", resource=res, actor={"id": "bob"}
    )
    assert not await ds.allowed(
        action="paper-edit", resource=res, actor={"id": "bob"}
    )

    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        actor_id="bob",
        role="Editor",
        by_actor="alice",
    )

    assert await ds.allowed(
        action="paper-view", resource=res, actor={"id": "bob"}
    )
    assert await ds.allowed(
        action="paper-edit", resource=res, actor={"id": "bob"}
    )
    # Editor does not grant manage.
    assert not await ds.allowed(
        action="paper-manage", resource=res, actor={"id": "bob"}
    )


@pytest.mark.asyncio
async def test_viewer_grant_allows_view_not_edit():
    from datasette_acl.grants import grant

    ds = await _make_ds()
    doc_id = await _create_doc(ds)
    res = PaperDocResource(doc_id)

    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        actor_id="carol",
        role="Viewer",
        by_actor="alice",
    )

    assert await ds.allowed(
        action="paper-view", resource=res, actor={"id": "carol"}
    )
    assert not await ds.allowed(
        action="paper-edit", resource=res, actor={"id": "carol"}
    )


@pytest.mark.asyncio
async def test_manager_grant_allows_all_three():
    from datasette_acl.grants import grant

    ds = await _make_ds()
    doc_id = await _create_doc(ds)
    res = PaperDocResource(doc_id)

    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        actor_id="dave",
        role="Manager",
        by_actor="alice",
    )

    for action in ("paper-view", "paper-edit", "paper-manage"):
        assert await ds.allowed(
            action=action, resource=res, actor={"id": "dave"}
        ), action


@pytest.mark.asyncio
async def test_grant_scoped_to_specific_doc():
    """A grant on one doc must not leak to another doc."""
    from datasette_acl.grants import grant

    ds = await _make_ds()
    doc_a = await _create_doc(ds)
    doc_b = await _create_doc(ds)

    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_a),
        actor_id="bob",
        role="Editor",
        by_actor="alice",
    )

    assert await ds.allowed(
        action="paper-edit", resource=PaperDocResource(doc_a), actor={"id": "bob"}
    )
    assert not await ds.allowed(
        action="paper-edit", resource=PaperDocResource(doc_b), actor={"id": "bob"}
    )
