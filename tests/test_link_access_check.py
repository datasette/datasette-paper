"""Tests for the cross-access warning endpoint (req #8).

GET /-/paper/api/docs/{id}/link-access-check — edit-gated authoring aid. For
each outgoing link edge it reports which *named* collaborators of the source
doc can't view the target, plus an ``open_audience`` flag when the source's
paper-view audience can't be fully enumerated (wildcard grant or dynamic
group). Best-effort, NOT a security control.

Conventions mirror test_links_endpoints.py: create docs as actors via signed
cookies, seed edges directly with PaperDB.replace_links, grant acl roles via
datasette_acl.grants.grant. The doc owner (creator) auto-gets a Manager grant.
The fixture binds alice; alice acts as owner/editor of the source doc D.

The JSON ``links`` object is keyed by STRING dst doc ids — assert with str(P).
"""

import pytest

from conftest import setup_paper_datasette
from datasette_acl.grants import grant, Principal
from datasette_paper.db import PaperDB
from datasette_paper.permissions import PAPER_DOC_RESOURCE_TYPE, PAPER_DOCS_PARENT


async def _create_doc(ds, name, actor_id):
    """Create a doc as ``actor_id`` and return its new id."""
    cookie = ds.sign({"a": {"id": actor_id}}, "actor")
    resp = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": name},
        cookies={"ds_actor": cookie},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _grant_viewer(ds, doc_id, actor_id):
    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.actor(actor_id),
        role="Viewer",
        by_actor="alice",
    )


@pytest.mark.asyncio
async def test_gap_when_named_viewer_cannot_view_target():
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    d = await _create_doc(ds, "Doc D", "alice")
    p = await _create_doc(ds, "Paper P", "alice")
    # bob is a named collaborator of D, but has NO grant on P.
    await _grant_viewer(ds, d, "bob")
    await db.replace_links(src_doc_id=d, src_version=1, edges={p: 1})

    resp = await ds.client.get(f"/-/paper/api/docs/{d}/link-access-check")
    assert resp.status_code == 200, resp.text
    links = resp.json()["links"]
    assert links[str(p)]["gap"] is True
    assert "bob" in links[str(p)]["missing"]
    assert links[str(p)]["open_audience"] is False


@pytest.mark.asyncio
async def test_no_gap_when_named_viewer_can_view_target():
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    d = await _create_doc(ds, "Doc D", "alice")
    p = await _create_doc(ds, "Paper P", "alice")
    # bob can view D but not P (a genuine gap); carol can view BOTH.
    await _grant_viewer(ds, d, "bob")
    await _grant_viewer(ds, d, "carol")
    await _grant_viewer(ds, p, "carol")
    await db.replace_links(src_doc_id=d, src_version=1, edges={p: 1})

    resp = await ds.client.get(f"/-/paper/api/docs/{d}/link-access-check")
    assert resp.status_code == 200, resp.text
    entry = resp.json()["links"][str(p)]
    assert "carol" not in entry["missing"]
    # bob still cannot view P → it's a gap overall.
    assert "bob" in entry["missing"]
    assert entry["gap"] is True


@pytest.mark.asyncio
async def test_open_audience_flag_on_wildcard_grant():
    ds, _ = await setup_paper_datasette()
    db = PaperDB(ds.get_internal_database())

    d = await _create_doc(ds, "Doc D", "alice")
    p = await _create_doc(ds, "Paper P", "alice")
    # Public-audience viewer on D: audience can't be enumerated → open_audience.
    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(d),
        principal=Principal.authenticated(),
        role="Viewer",
        by_actor="alice",
    )
    await db.replace_links(src_doc_id=d, src_version=1, edges={p: 1})

    resp = await ds.client.get(f"/-/paper/api/docs/{d}/link-access-check")
    assert resp.status_code == 200, resp.text
    assert resp.json()["links"][str(p)]["open_audience"] is True


@pytest.mark.asyncio
async def test_link_access_check_403_for_non_editor():
    ds, _ = await setup_paper_datasette()
    # alice owns D; bob has the global list+create grants (fixture) but no
    # edit grant on D → not an editor → 403.
    d = await _create_doc(ds, "Doc D", "alice")

    bob_cookie = ds.sign({"a": {"id": "bob"}}, "actor")
    resp = await ds.client.get(
        f"/-/paper/api/docs/{d}/link-access-check",
        cookies={"ds_actor": bob_cookie},
    )
    assert resp.status_code == 403
