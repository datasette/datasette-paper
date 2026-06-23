"""Tests for the embed cross-access endpoint (06 §#8, embed analogue of
link-access-check).

GET /-/paper/api/docs/{id}/resource-access-check?ref=… — edit-gated authoring
aid. For the given embedded resource ref it reports which *named* collaborators
of the doc can't resolve it (``missing``/``gap``), plus ``open_audience`` when
the doc's paper-view audience can't be fully enumerated. Best-effort, NOT a
security control.

A fake ``paper_resource_provider`` supplies the resource so the test is
independent of any core database setup: the provider denies actor ``bob`` and
resolves everyone else.
"""

import pytest
from datasette import hookimpl
from datasette.plugins import pm
from datasette_acl.grants import grant, Principal

import datasette_paper  # noqa: F401 — ensures the hookspec is registered
from conftest import setup_paper_datasette
from datasette_paper.permissions import PAPER_DOC_RESOURCE_TYPE, PAPER_DOCS_PARENT


class _GatedProvider:
    """Claims ``/-/gated/...``; denies ``bob``, resolves everyone else ok."""

    def claims(self, ref):
        return ref.startswith("/-/gated/")

    async def resolve(self, datasette, actor, ref):
        if actor and actor.get("id") == "bob":
            return {"status": "denied"}
        return {"status": "ok", "kind": "gated", "label": "Gated", "href": ref}

    async def render(self, datasette, actor, ref, mode, limit):
        return await self.resolve(datasette, actor, ref)


class _GatedPlugin:
    @hookimpl
    def paper_resource_provider(self, datasette):
        return _GatedProvider()


@pytest.fixture
def gated_provider():
    plugin = _GatedPlugin()
    pm.register(plugin, name="paper-gated-provider")
    try:
        yield
    finally:
        pm.unregister(plugin)


async def _create_doc(ds, name, actor_id):
    cookie = ds.sign({"a": {"id": actor_id}}, "actor")
    resp = await ds.client.post(
        "/-/paper/api/docs", json={"name": name}, cookies={"ds_actor": cookie}
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
async def test_gap_when_named_viewer_cannot_see_resource(gated_provider):
    ds, _ = await setup_paper_datasette()
    d = await _create_doc(ds, "Doc D", "alice")
    # bob is a named collaborator but the provider denies him the resource.
    await _grant_viewer(ds, d, "bob")

    resp = await ds.client.get(
        f"/-/paper/api/docs/{d}/resource-access-check?ref=/-/gated/1"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["gap"] is True
    assert "bob" in body["missing"]
    assert body["open_audience"] is False


@pytest.mark.asyncio
async def test_no_gap_when_all_named_viewers_can_see(gated_provider):
    ds, _ = await setup_paper_datasette()
    d = await _create_doc(ds, "Doc D", "alice")
    # carol is allowed by the provider; alice (owner) too → no gap.
    await _grant_viewer(ds, d, "carol")

    resp = await ds.client.get(
        f"/-/paper/api/docs/{d}/resource-access-check?ref=/-/gated/1"
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["gap"] is False
    assert body["missing"] == []


@pytest.mark.asyncio
async def test_open_audience_flag(gated_provider):
    ds, _ = await setup_paper_datasette()
    d = await _create_doc(ds, "Doc D", "alice")
    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(d),
        principal=Principal.authenticated(),
        role="Viewer",
        by_actor="alice",
    )

    resp = await ds.client.get(
        f"/-/paper/api/docs/{d}/resource-access-check?ref=/-/gated/1"
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["open_audience"] is True


@pytest.mark.asyncio
async def test_blank_ref_is_no_gap(gated_provider):
    ds, _ = await setup_paper_datasette()
    d = await _create_doc(ds, "Doc D", "alice")
    await _grant_viewer(ds, d, "bob")

    resp = await ds.client.get(f"/-/paper/api/docs/{d}/resource-access-check?ref=")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"gap": False, "missing": [], "open_audience": False}


@pytest.mark.asyncio
async def test_403_for_non_editor(gated_provider):
    ds, _ = await setup_paper_datasette()
    d = await _create_doc(ds, "Doc D", "alice")
    bob_cookie = ds.sign({"a": {"id": "bob"}}, "actor")
    resp = await ds.client.get(
        f"/-/paper/api/docs/{d}/resource-access-check?ref=/-/gated/1",
        cookies={"ds_actor": bob_cookie},
    )
    assert resp.status_code == 403
