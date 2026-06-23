"""Tests for the ``paper_embed_provider`` hook: frontend-asset collection,
de-duplication, exception isolation, and doc-page-gated injection.

The hook's *only* backend job is contributing a provider's JS/CSS bundle to
the editor page (resolve/render are client-side — see
``frontend/src/lib/embedRegistry.ts``). These tests register fake providers on
Datasette's plugin manager and assert the aggregation + injection behaviour.
"""

from datasette import hookimpl
from datasette.plugins import pm

import datasette_paper  # noqa: F401 — ensures the hookspec is registered
from datasette_paper.embed_providers import provider_frontend_assets

from conftest import make_datasette


class _Provider:
    def __init__(self, js=None, css=None, raises=False):
        self._js = js or []
        self._css = css or []
        self._raises = raises

    def frontend_assets(self, datasette):
        if self._raises:
            raise RuntimeError("misbehaving provider")
        return {"js": self._js, "css": self._css}


class _PluginShim:
    """A throwaway plugin exposing one provider via the hook."""

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


def test_no_providers_yields_empty_assets():
    ds = make_datasette()
    assert provider_frontend_assets(ds) == {"js": [], "css": []}


def test_collects_js_and_css_across_providers():
    ds = make_datasette()
    shim = _register(
        _Provider(js=["/a.js"], css=["/a.css"]),
        _Provider(js=["/b.js"]),
    )
    try:
        assets = provider_frontend_assets(ds)
        assert assets["js"] == ["/a.js", "/b.js"]
        assert assets["css"] == ["/a.css"]
    finally:
        _unregister(shim)


def test_dedupes_preserving_first_seen_order():
    ds = make_datasette()
    shim = _register(
        _Provider(js=["/dup.js", "/a.js"]),
        _Provider(js=["/dup.js", "/b.js"]),
    )
    try:
        assert provider_frontend_assets(ds)["js"] == ["/dup.js", "/a.js", "/b.js"]
    finally:
        _unregister(shim)


def test_a_raising_provider_is_skipped_not_fatal():
    ds = make_datasette()
    shim = _register(
        _Provider(raises=True),
        _Provider(js=["/good.js"]),
    )
    try:
        # The bad provider contributes nothing; the good one still lands.
        assert provider_frontend_assets(ds)["js"] == ["/good.js"]
    finally:
        _unregister(shim)


class _FakeRequest:
    def __init__(self, path):
        self.path = path


def test_provider_js_injected_on_doc_page_only():
    ds = make_datasette()
    shim = _register(_Provider(js=["/places.js"], css=["/places.css"]))
    try:
        doc_js = datasette_paper.extra_js_urls(ds, _FakeRequest("/-/paper/doc/1"))
        doc_css = datasette_paper.extra_css_urls(ds, _FakeRequest("/-/paper/doc/1"))
        assert "/places.js" in doc_js
        assert "/places.css" in doc_css

        # Not the index, not an API route.
        assert datasette_paper.extra_js_urls(ds, _FakeRequest("/-/paper")) == []
        assert (
            datasette_paper.extra_js_urls(
                ds, _FakeRequest("/-/paper/api/docs/1/document")
            )
            == []
        )
    finally:
        _unregister(shim)


def test_hookspec_registered_on_datasette_pm():
    # __init__ adds the spec on import; a sibling plugin can implement it.
    assert hasattr(pm.hook, "paper_embed_provider")
