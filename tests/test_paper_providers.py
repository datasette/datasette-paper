"""Tests for the `paper_resource_provider` dispatch seam.

A fake provider claiming a `/-/fake/...` namespace is registered on
Datasette's plugin manager; we assert resolve/render dispatch to it, that a
provider-returned `denied` is honored, that unclaimed refs fall back to the
built-in core provider, and that frontend assets are collected.
"""

import pytest
from datasette import hookimpl
from datasette.app import Datasette
from datasette.plugins import pm

import datasette_paper  # noqa: F401 — ensures the hookspec is registered
from datasette_paper.resources import (
    provider_frontend_assets,
    render_ref,
    resolve_ref,
)


class _FakeProvider:
    def claims(self, ref):
        return ref.startswith("/-/fake/")

    async def resolve(self, datasette, actor, ref):
        if actor and actor.get("id") == "blocked":
            return {"status": "denied"}
        return {
            "status": "ok",
            "kind": "fake-thing",
            "label": "Fake " + ref,
            "href": ref,
            "icon": "globe",
        }

    async def render(self, datasette, actor, ref, mode, limit):
        if actor and actor.get("id") == "blocked":
            return {"status": "denied"}
        return {
            "status": "ok",
            "kind": "fake-thing",
            "label": "Fake " + ref,
            "href": ref,
            "icon": "globe",
            "mode": mode,
        }

    def frontend_assets(self, datasette):
        return {"js": ["/-/static-plugins/fake/embed.js"], "css": ["/-/x.css"]}


class _FakePlugin:
    @hookimpl
    def paper_resource_provider(self, datasette):
        return _FakeProvider()


@pytest.fixture
def ds_with_provider():
    ds = Datasette(memory=True)
    plugin = _FakePlugin()
    pm.register(plugin, name="paper-fake-provider")
    try:
        yield ds
    finally:
        pm.unregister(plugin)


@pytest.mark.asyncio
async def test_provider_claims_and_resolves(ds_with_provider):
    out = await resolve_ref(ds_with_provider, {"id": "alice"}, "/-/fake/42")
    assert out == {
        "status": "ok",
        "kind": "fake-thing",
        "label": "Fake /-/fake/42",
        "href": "/-/fake/42",
        "icon": "globe",
    }


@pytest.mark.asyncio
async def test_provider_denied_is_honored(ds_with_provider):
    out = await resolve_ref(ds_with_provider, {"id": "blocked"}, "/-/fake/42")
    assert out == {"status": "denied"}


@pytest.mark.asyncio
async def test_render_passes_mode_to_provider(ds_with_provider):
    out = await render_ref(ds_with_provider, {"id": "a"}, "/-/fake/9", "map", 25)
    assert out["kind"] == "fake-thing"
    assert out["mode"] == "map"


@pytest.mark.asyncio
async def test_unclaimed_ref_falls_back_to_core(ds_with_provider):
    # /nope is a normal db path the fake provider doesn't claim; core handles
    # it and finds no such database.
    out = await resolve_ref(ds_with_provider, {"id": "a"}, "/nope/table")
    assert out["status"] == "not_found"


@pytest.mark.asyncio
async def test_frontend_assets_collected(ds_with_provider):
    assets = provider_frontend_assets(ds_with_provider)
    assert assets["js"] == ["/-/static-plugins/fake/embed.js"]
    assert assets["css"] == ["/-/x.css"]


@pytest.mark.asyncio
async def test_no_providers_means_empty_assets():
    # Without the fixture, no fake provider is registered.
    ds = Datasette(memory=True)
    assert provider_frontend_assets(ds) == {"js": [], "css": []}
