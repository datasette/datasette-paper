"""Tests for the ``paper_embed_provider`` hook: manifest building, dedupe by
kind, exception isolation, and the fact that provider bundles are **not**
injected globally (the editor lazy-loads them from the doc-page manifest).

The hook's backend job is describing each provider (kind / label / asset URLs /
ref-prefixes) so the editor can lazy-inject a bundle only when the doc uses it —
resolve/render are client-side (see ``frontend/src/lib/embedProviders.ts`` and
``embedRegistry.ts``). These tests register fake providers on Datasette's plugin
manager and assert the manifest + non-injection behaviour.
"""

import json

import pytest
from datasette import hookimpl
from datasette.plugins import pm

import datasette_paper  # noqa: F401 — ensures the hookspec is registered
from datasette_paper.embed_providers import provider_manifest

from conftest import make_datasette


class _Provider:
    def __init__(
        self,
        kind=None,
        label=None,
        js=None,
        css=None,
        ref_prefixes=None,
        sources=None,
        raises=False,
    ):
        if kind is not None:
            self.kind = kind
        if label is not None:
            self.label = label
        if ref_prefixes is not None:
            self.ref_prefixes = ref_prefixes
        if sources is not None:
            self.sources = sources
        self._js = js or []
        self._css = css or []
        self._raises = raises

    def frontend_assets(self, datasette):
        if self._raises:
            raise RuntimeError("misbehaving provider")
        return {"js": self._js, "css": self._css}


class _PluginShim:
    """A throwaway plugin exposing one or more providers via the hook."""

    def __init__(self, *providers):
        self._providers = list(providers)

    @hookimpl
    def paper_embed_provider(self, datasette):
        return self._providers


def _register(*providers):
    shim = _PluginShim(*providers)
    pm.register(shim, name="test-embed-provider-shim")
    return shim


def _unregister(shim):
    pm.unregister(shim)


def test_no_providers_yields_empty_manifest():
    ds = make_datasette()
    assert provider_manifest(ds) == []


def test_manifest_describes_each_provider():
    ds = make_datasette()
    shim = _register(
        _Provider(
            kind="place-list",
            label="Places",
            js=["/places.js"],
            css=["/places.css"],
            ref_prefixes=["/-/places/"],
            sources=[{"id": "place-list", "label": "Places", "icon": "geo-alt"}],
        ),
        _Provider(kind="sheet", js=["/sheet.js"]),
    )
    try:
        assert provider_manifest(ds) == [
            {
                "kind": "place-list",
                "label": "Places",
                "js": ["/places.js"],
                "css": ["/places.css"],
                "ref_prefixes": ["/-/places/"],
                "sources": [{"id": "place-list", "label": "Places", "icon": "geo-alt"}],
            },
            {
                "kind": "sheet",
                "label": "sheet",  # defaults to kind
                "js": ["/sheet.js"],
                "css": [],
                "ref_prefixes": [],
                "sources": [],
            },
        ]
    finally:
        _unregister(shim)


def test_provider_without_kind_is_skipped():
    ds = make_datasette()
    shim = _register(_Provider(js=["/anon.js"]), _Provider(kind="ok", js=["/ok.js"]))
    try:
        manifest = provider_manifest(ds)
        assert [e["kind"] for e in manifest] == ["ok"]
    finally:
        _unregister(shim)


def test_dedupes_by_kind_first_wins():
    ds = make_datasette()
    shim = _register(
        _Provider(kind="dup", js=["/first.js"]),
        _Provider(kind="dup", js=["/second.js"]),
    )
    try:
        manifest = provider_manifest(ds)
        assert [e["js"] for e in manifest] == [["/first.js"]]
    finally:
        _unregister(shim)


def test_sources_are_normalized_and_malformed_dropped():
    ds = make_datasette()
    shim = _register(
        _Provider(
            kind="p",
            js=["/p.js"],
            sources=[
                {"id": "s1", "label": "S1", "icon": "geo-alt", "mode": "map"},
                {"id": "s2"},  # label defaults to id; no icon/mode emitted
                {"label": "no id"},  # dropped — no id
                "not-a-dict",  # dropped
            ],
        )
    )
    try:
        [entry] = provider_manifest(ds)
        assert entry["sources"] == [
            {"id": "s1", "label": "S1", "icon": "geo-alt", "mode": "map"},
            {"id": "s2", "label": "s2"},
        ]
    finally:
        _unregister(shim)


def test_a_raising_provider_is_skipped_not_fatal():
    ds = make_datasette()
    shim = _register(
        _Provider(kind="bad", raises=True),
        _Provider(kind="good", js=["/good.js"]),
    )
    try:
        manifest = provider_manifest(ds)
        assert [e["kind"] for e in manifest] == ["good"]
    finally:
        _unregister(shim)


class _FakeRequest:
    def __init__(self, path):
        self.path = path


def test_provider_assets_not_injected_globally():
    """Provider JS/CSS is delivered via the doc-page manifest, NOT folded into
    extra_js_urls/extra_css_urls (which would load every provider everywhere)."""
    ds = make_datasette()
    shim = _register(_Provider(kind="places", js=["/places.js"], css=["/places.css"]))
    try:
        doc_js = datasette_paper.extra_js_urls(ds, _FakeRequest("/-/paper/doc/1"))
        doc_css = datasette_paper.extra_css_urls(ds, _FakeRequest("/-/paper/doc/1"))
        assert "/places.js" not in doc_js
        assert "/places.css" not in doc_css
    finally:
        _unregister(shim)


@pytest.mark.asyncio
async def test_manifest_lands_in_doc_page_data(ds):
    """The doc page embeds the provider manifest in its page_data blob so the
    frontend loader can lazy-inject bundles on demand."""
    created = await ds.client.post("/-/paper/api/docs", json={"name": "Embed test"})
    assert created.status_code == 201
    doc_id = created.json()["id"]
    shim = _register(
        _Provider(
            kind="place-list",
            label="Places",
            js=["/places.js"],
            ref_prefixes=["/-/places/"],
        )
    )
    try:
        resp = await ds.client.get(f"/-/paper/doc/{doc_id}")
        assert resp.status_code == 200
        # The page_data <script> blob carries the manifest entry.
        start = resp.text.index('id="pageData">') + len('id="pageData">')
        end = resp.text.index("</script>", start)
        page_data = json.loads(resp.text[start:end])
        kinds = [e["kind"] for e in page_data["embed_providers"]]
        assert "place-list" in kinds
    finally:
        _unregister(shim)


def test_hookspec_registered_on_datasette_pm():
    # __init__ adds the spec on import; a sibling plugin can implement it.
    assert hasattr(pm.hook, "paper_embed_provider")
