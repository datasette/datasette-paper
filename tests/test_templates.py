"""Tests for the template feature.

Templates are real papers with ``kind='template'`` — collab and sharing
still work the same; what changes is:

* The default list endpoint filters them out (and a ?kind=template /
  /templates endpoint lists them).
* POST /-/paper/api/docs accepts ``template_id`` and seeds the new
  doc with the template's materialized content.
* Owner-only routes flip ``kind`` between 'doc' and 'template'.
"""

from __future__ import annotations

import json

import pytest
from datasette.app import Datasette

from datasette_paper.db import PaperDB
from datasette_paper.instance import empty_doc_json, get_registry


def _cookie(ds, actor_id):
    return {"ds_actor": ds.sign({"a": {"id": actor_id}}, "actor")}


async def _make_ds():
    ds = Datasette(
        memory=True,
        config={
            "permissions": {
                "datasette-paper-create": True,
            }
        },
    )
    await ds.invoke_startup()
    return ds


async def _alice_doc(ds, name="P", *, kind="doc"):
    body = {"name": name}
    if kind != "doc":
        body["kind"] = kind
    r = await ds.client.post(
        "/-/paper/api/docs", json=body, cookies=_cookie(ds, "alice")
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_default_excludes_templates():
    """GET /-/paper/api/docs returns only kind='doc' by default."""
    ds = await _make_ds()
    doc_id = await _alice_doc(ds, name="Doc")
    template_id = await _alice_doc(ds, name="Tmpl", kind="template")

    r = await ds.client.get("/-/paper/api/docs", cookies=_cookie(ds, "alice"))
    assert r.status_code == 200
    ids = [row["id"] for row in r.json()]
    assert doc_id in ids
    assert template_id not in ids


@pytest.mark.asyncio
async def test_list_kind_template_returns_only_templates():
    ds = await _make_ds()
    doc_id = await _alice_doc(ds, name="Doc")
    template_id = await _alice_doc(ds, name="Tmpl", kind="template")

    r = await ds.client.get(
        "/-/paper/api/docs?kind=template", cookies=_cookie(ds, "alice")
    )
    assert r.status_code == 200
    ids = [row["id"] for row in r.json()]
    assert ids == [template_id]
    assert doc_id not in ids


@pytest.mark.asyncio
async def test_list_kind_all_returns_both():
    ds = await _make_ds()
    doc_id = await _alice_doc(ds, name="Doc")
    template_id = await _alice_doc(ds, name="Tmpl", kind="template")

    r = await ds.client.get("/-/paper/api/docs?kind=all", cookies=_cookie(ds, "alice"))
    ids = sorted(row["id"] for row in r.json())
    assert ids == sorted([doc_id, template_id])


@pytest.mark.asyncio
async def test_list_kind_invalid_400():
    ds = await _make_ds()
    r = await ds.client.get("/-/paper/api/docs?kind=junk", cookies=_cookie(ds, "alice"))
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# make_template / unmake_template
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_make_template_owner_only():
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)

    # An acl Editor grant can't make it a template (manage is owner-only).
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
        principal=Principal.actor("bob"),
        role="Editor",
        by_actor="alice",
    )
    r = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/make_template", cookies=_cookie(ds, "bob")
    )
    assert r.status_code == 403

    # Owner can.
    r2 = await ds.client.post(
        f"/-/paper/api/docs/{doc_id}/make_template", cookies=_cookie(ds, "alice")
    )
    assert r2.status_code == 200
    assert r2.json()["kind"] == "template"


@pytest.mark.asyncio
async def test_unmake_template_roundtrip():
    ds = await _make_ds()
    template_id = await _alice_doc(ds, kind="template")

    r = await ds.client.post(
        f"/-/paper/api/docs/{template_id}/unmake_template",
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 200
    assert r.json()["kind"] == "doc"


# ---------------------------------------------------------------------------
# Create from template
# ---------------------------------------------------------------------------


async def _plant_template_doc(ds, template_id, doc_json):
    """Replace the template's seed snapshot with the given JSON."""
    paper = PaperDB(ds.get_internal_database())
    # m003 templates start empty; planting a snapshot at version 0
    # short-circuits the empty default in Instance.hydrate.
    await ds.get_internal_database().execute_write(
        "DELETE FROM _datasette_paper_snapshot WHERE doc_id = ?", [template_id]
    )
    await paper.insert_snapshot(
        doc_id=template_id,
        version=0,
        doc_json=doc_json,
        actor_id="alice",
    )
    # Force registry rehydrate so materialize_live_doc reads the planted
    # snapshot, not a cached empty doc.
    get_registry(ds)._instances.pop(template_id, None)


@pytest.mark.asyncio
async def test_create_from_template_clones_content():
    """Creating from a template seeds the new doc with the template content."""
    ds = await _make_ds()
    template_id = await _alice_doc(ds, name="Standup", kind="template")

    standup_doc = {
        "type": "doc",
        "content": [
            {
                "type": "heading",
                "attrs": {"level": 1},
                "content": [{"type": "text", "text": "Daily standup"}],
            },
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": "Wins, blockers, plans."}],
            },
        ],
    }
    await _plant_template_doc(ds, template_id, json.dumps(standup_doc))

    # Create a new doc from the template.
    r = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Today", "template_id": template_id},
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 201, r.text
    new_id = r.json()["id"]
    assert r.json()["kind"] == "doc"

    # The bootstrap envelope's `doc` is the seed snapshot — should equal
    # the planted template content.
    boot = await ds.client.get(
        f"/-/paper/api/docs/{new_id}", cookies=_cookie(ds, "alice")
    )
    assert boot.status_code == 200
    body = boot.json()
    assert body["doc"] == standup_doc
    assert body["snapshotVersion"] == 0
    assert body["version"] == 0


@pytest.mark.asyncio
async def test_create_blank_keeps_empty_doc():
    """No template_id ⇒ existing empty-doc path (no preseeded snapshot)."""
    ds = await _make_ds()
    r = await ds.client.post(
        "/-/paper/api/docs", json={"name": "Blank"}, cookies=_cookie(ds, "alice")
    )
    assert r.status_code == 201
    new_id = r.json()["id"]
    boot = await ds.client.get(
        f"/-/paper/api/docs/{new_id}", cookies=_cookie(ds, "alice")
    )
    assert boot.json()["doc"] == json.loads(empty_doc_json())


@pytest.mark.asyncio
async def test_create_from_template_decouples_from_source():
    """Editing the template after instantiation doesn't touch the clone."""
    ds = await _make_ds()
    template_id = await _alice_doc(ds, name="Tmpl", kind="template")
    v1_doc = {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "v1"}]}],
    }
    await _plant_template_doc(ds, template_id, json.dumps(v1_doc))

    # Instantiate.
    r = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Snapshot1", "template_id": template_id},
        cookies=_cookie(ds, "alice"),
    )
    new_id = r.json()["id"]

    # Mutate the template's seed snapshot.
    v2_doc = {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "v2"}]}],
    }
    await _plant_template_doc(ds, template_id, json.dumps(v2_doc))

    # The original clone still has v1 content.
    boot = await ds.client.get(
        f"/-/paper/api/docs/{new_id}", cookies=_cookie(ds, "alice")
    )
    assert boot.json()["doc"] == v1_doc


@pytest.mark.asyncio
async def test_create_from_template_404_for_unknown():
    ds = await _make_ds()
    r = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "x", "template_id": 99999},
        cookies=_cookie(ds, "alice"),
    )
    # Unknown id has no view grants for alice (and resources_sql doesn't
    # return it), so the permission check fails first.
    assert r.status_code in (403, 404)


@pytest.mark.asyncio
async def test_create_from_non_template_rejects_400():
    """template_id must point at a paper with kind='template'."""
    ds = await _make_ds()
    doc_id = await _alice_doc(ds)  # plain doc

    r = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "x", "template_id": doc_id},
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_create_kind_template_with_template_id_rejected():
    """Cannot create a template that itself instantiates from another."""
    ds = await _make_ds()
    template_id = await _alice_doc(ds, kind="template")

    r = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "x", "kind": "template", "template_id": template_id},
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_create_template_kind_persists():
    """POST with kind='template' produces a template, not a doc."""
    ds = await _make_ds()
    r = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Tmpl", "kind": "template"},
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 201
    assert r.json()["kind"] == "template"


@pytest.mark.asyncio
async def test_create_from_locked_template_still_works():
    """Locking a template doesn't prevent instantiation — only edits to
    the template itself. This matches the documented behavior from the
    plan: lock is about editing the source, not consuming it."""
    ds = await _make_ds()
    template_id = await _alice_doc(ds, kind="template")
    await ds.client.post(
        f"/-/paper/api/docs/{template_id}/lock", cookies=_cookie(ds, "alice")
    )

    r = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "From locked", "template_id": template_id},
        cookies=_cookie(ds, "alice"),
    )
    assert r.status_code == 201
