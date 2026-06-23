"""Collect frontend assets declared by third-party ``paper_embed_provider``s.

The embed feature is otherwise client-side (the browser hits Datasette's native
``.json`` API). The one backend responsibility is loading each provider's JS/CSS
bundle onto the editor page; ``__init__.py``'s ``extra_js_urls`` /
``extra_css_urls`` hooks fold the result of :func:`provider_frontend_assets`
into the doc-page asset list. See ``hookspecs.py`` for the provider contract.
"""

import logging

from datasette.plugins import pm

logger = logging.getLogger(__name__)


def _providers(datasette):
    """Flatten the hook results into a list of provider objects.

    The hook may return a single provider or a list; a provider raising during
    its own construction is the plugin's bug, but we never let it 500 the page.
    """
    providers = []
    for result in pm.hook.paper_embed_provider(datasette=datasette) or []:
        if result is None:
            continue
        if isinstance(result, (list, tuple)):
            providers.extend(p for p in result if p is not None)
        else:
            providers.append(result)
    return providers


def provider_frontend_assets(datasette):
    """Return ``{"js": [...], "css": [...]}`` aggregated across all providers.

    URLs are de-duplicated preserving first-seen order. A provider whose
    ``frontend_assets`` is missing or raises contributes nothing (logged) —
    one bad plugin can't break the editor page for everyone.
    """
    js: list[str] = []
    css: list[str] = []
    seen_js: set[str] = set()
    seen_css: set[str] = set()

    for provider in _providers(datasette):
        fn = getattr(provider, "frontend_assets", None)
        if not callable(fn):
            continue
        try:
            assets = fn(datasette) or {}
        except Exception:
            logger.exception("paper_embed_provider.frontend_assets raised; skipping")
            continue
        for url in assets.get("js", []) or []:
            if url not in seen_js:
                seen_js.add(url)
                js.append(url)
        for url in assets.get("css", []) or []:
            if url not in seen_css:
                seen_css.add(url)
                css.append(url)

    return {"js": js, "css": css}
