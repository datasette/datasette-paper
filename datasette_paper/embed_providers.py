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
from urllib.parse import quote

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


def _provider_for_ref(datasette, ref):
    """Return the first provider whose ``ref_prefixes`` claims ``ref``, else None.

    Mirrors the server-knowable mapping ``provider_manifest`` exposes
    (``ref_prefixes``) — the same channel the frontend lazy-loader uses — so the
    markdown serializer can find a ref's owning provider without running any
    in-bundle JS ``matchRef``.
    """
    if not ref:
        return None
    for provider in _providers(datasette):
        for prefix in getattr(provider, "ref_prefixes", None) or []:
            if ref.startswith(prefix):
                return provider
    return None


def ref_to_kind_and_url(datasette, ref):
    """Map an inline-embed ``ref`` to ``(kind, resource_url | None)``.

    Used by the markdown serializer (ticket 04) to build the canonical
    ``paper:/embed/<kind>/<ref>`` and, when a provider supplies one, a real
    resource href. A ref claimed by a provider (by ``ref_prefixes``) takes that
    provider's ``kind`` and its optional ``resource_url(datasette, ref)``; an
    unclaimed (core Datasette) ref is kind ``"datasette"`` with no URL (the
    serializer can still emit the bare canonical). A provider whose
    ``resource_url`` raises is logged and treated as no-URL, mirroring the
    ``frontend_assets`` try/except discipline.
    """
    provider = _provider_for_ref(datasette, ref)
    if provider is None:
        return "datasette", None
    kind = getattr(provider, "kind", None) or "datasette"
    fn = getattr(provider, "resource_url", None)
    url = None
    if callable(fn):
        try:
            url = fn(datasette, ref)
        except Exception:
            logger.exception(
                "paper_embed_provider.resource_url raised for %r; treating as None",
                ref,
            )
            url = None
    return kind, url


def make_resource_resolver(datasette, request=None):
    """Build the ``resource_url`` resolver passed to ``doc_to_markdown``.

    Returns a callable ``(ref_type, value) -> (kind, url | None)`` matching
    :data:`datasette_paper.markdown.ResourceResolver`:

    * ``actor`` → ``/-/profile/<id>``
    * ``tag``   → ``/-/paper/tag/<slug>``
    * ``embed`` → ``(<provider-kind>, provider.resource_url(ref))`` via
      ``ref_to_kind_and_url`` (core Datasette refs get kind ``"datasette"`` and
      no href).

    URLs are made absolute via ``datasette.absolute_url(request, path)`` when a
    ``request`` is in scope (so external renderers like GitHub get a followable
    link); otherwise the root-relative path is emitted (still better than a dead
    ``paper:/`` link).
    """

    def absolutize(path):
        if path is None:
            return None
        if request is not None:
            try:
                return datasette.absolute_url(request, path)
            except Exception:
                return path
        return path

    def resolve(ref_type, value):
        if ref_type == "actor":
            return None, absolutize(f"/-/profile/{quote(value, safe='')}")
        if ref_type == "tag":
            return None, absolutize(f"/-/paper/tag/{quote(value, safe='')}")
        if ref_type == "embed":
            kind, url = ref_to_kind_and_url(datasette, value)
            return kind, absolutize(url)
        return None, None

    return resolve


def provider_manifest(datasette):
    """Return a list of provider descriptors for the editor's lazy loader.

    Each entry is::

        {
            "kind": "place-list",          # stable id; matches the bundle's exported kind
            "label": "Place list",         # human label (defaults to kind)
            "js": [...urls], "css": [...urls],
            "ref_prefixes": ["/-/places/"],# stored-ref namespaces this provider owns
            "sources": [                   # browsable `/`-menu insert sources
                {"id": "place-list", "label": "Places", "icon": "geo-alt"},
            ],
        }

    ``ref_prefixes`` is how paper decides, *server-knowably*, that a stored ref
    like ``/-/places/list/5`` belongs to this provider — so it can inject the
    bundle on demand without first running the provider's in-bundle ``matchRef``.
    ``sources`` mirrors the provider's JS ``picker()`` sources so the ``/`` menu
    can list them *before* the bundle loads; picking one injects the bundle.

    A provider with no ``kind`` is skipped (the kind ties the manifest entry to
    the bundle's default-exported provider ``kind``). A provider whose ``frontend_assets``
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
                "sources": _normalize_sources(getattr(provider, "sources", None)),
            }
        )
    return out


def _normalize_sources(sources):
    """Coerce a provider's declared `/`-menu sources to manifest dicts.

    Each must have an ``id``; ``label`` defaults to it; ``icon`` / ``mode`` are
    carried through when present. Malformed entries are dropped (not fatal).
    """
    out = []
    for s in sources or []:
        if not isinstance(s, dict):
            continue
        sid = s.get("id")
        if not sid:
            continue
        entry = {"id": sid, "label": s.get("label") or sid}
        if s.get("icon"):
            entry["icon"] = s["icon"]
        if s.get("mode"):
            entry["mode"] = s["mode"]
        out.append(entry)
    return out
