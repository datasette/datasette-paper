"""Build the third-party ``paper_embed_provider`` manifest for the editor page.

The embed feature is otherwise client-side (the browser hits Datasette's native
``.json`` API). The backend's one job is telling the editor *which* providers
exist and *where* their bundles live — **without** loading those bundles. The
doc page (``routes/docs.py``) folds :func:`provider_manifest` into its
``page_data`` blob; the frontend (``frontend/src/lib/embedProviders.ts``) reads
it and lazy-injects a provider's JS/CSS only when the document actually uses
that provider — either because the doc contains one of its embeds (matched by
``ref_prefixes``) or because the author picks it from the ``/`` menu. See
``hookspecs.py`` for the provider contract.
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


def provider_manifest(datasette):
    """Return a list of provider descriptors for the editor's lazy loader.

    Each entry is::

        {
            "kind": "place-list",          # stable id; matches the JS register() kind
            "label": "Place list",         # human label (defaults to kind)
            "js": [...urls], "css": [...urls],
            "ref_prefixes": ["/-/places/"] # stored-ref namespaces this provider owns
        }

    ``ref_prefixes`` is how paper decides, *server-knowably*, that a stored ref
    like ``/-/places/list/5`` belongs to this provider — so it can inject the
    bundle on demand without first running the provider's in-bundle ``matchRef``.

    A provider with no ``kind`` is skipped (the kind ties the manifest entry to
    the bundle's ``register({kind})`` call). A provider whose ``frontend_assets``
    raises is logged and skipped — one bad plugin can't break the editor page.
    De-duplicated by ``kind`` (first wins).
    """
    out = []
    seen: set[str] = set()
    for provider in _providers(datasette):
        kind = getattr(provider, "kind", None)
        if not kind:
            logger.warning("paper_embed_provider missing a `kind`; skipping")
            continue
        if kind in seen:
            continue

        assets = {}
        fn = getattr(provider, "frontend_assets", None)
        if callable(fn):
            try:
                assets = fn(datasette) or {}
            except Exception:
                logger.exception(
                    "paper_embed_provider.frontend_assets raised; skipping"
                )
                continue

        seen.add(kind)
        out.append(
            {
                "kind": kind,
                "label": getattr(provider, "label", None) or kind,
                "js": list(assets.get("js") or []),
                "css": list(assets.get("css") or []),
                "ref_prefixes": list(getattr(provider, "ref_prefixes", None) or []),
            }
        )
    return out
