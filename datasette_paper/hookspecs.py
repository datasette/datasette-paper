"""Plugin hooks datasette-paper exposes to *other* Datasette plugins.

Registered on Datasette's own plugin manager (pluggy project ``"datasette"``)
so any installed plugin can implement them with the usual
``from datasette import hookimpl``.

``paper_embed_provider`` is the backend half of the third-party embed feature.
Because the editor resolves and renders embeds **client-side** against
Datasette's native browser JSON API (see ``frontend/src/lib/datasetteEmbed.ts``),
the *rendering* contract is a frontend one — a provider ships a JS bundle that
calls ``window.datasettePaperEmbeds.register({...})`` (see
``frontend/src/lib/embedRegistry.ts``) to claim a ref namespace and supply the
inline-pill identity + block-card body. It fetches its own data with the
viewer's ``ds_actor`` cookie, so per-viewer permissions and leak discipline are
the provider's own responsibility — paper's backend is never in that path.

The *only* thing the frontend can't do for itself is get that bundle onto the
editor page. But paper does **not** load every provider's bundle on every doc
page — it lazy-loads a provider only when the doc actually uses it. So the
provider describes itself with a small, serializable manifest entry::

    kind          str        # stable id; MUST equal the JS register({kind}) call
    label         str        # human label for the / menu (optional; defaults to kind)
    ref_prefixes  list[str]  # stored-ref namespaces it owns, e.g. ["/-/places/"]
    frontend_assets(datasette) -> {"js": [...urls], "css": [...urls]}

``ref_prefixes`` is the load trigger: when a doc contains an embed whose stored
ref starts with one of them (e.g. ``/-/places/list/5``), paper injects this
provider's bundle and lets it render. (For paste-to-embed to work *before* the
bundle loads, the stored ref must be the URL's path under one of these
prefixes.) The author picking the provider from the ``/`` menu is the other
trigger. ``frontend_assets`` is fetched once and folded into the doc page's
``page_data`` manifest — never injected globally.

A provider with no ``kind`` is skipped (the kind ties the entry to its bundle).
A provider whose ``frontend_assets`` raises is logged and skipped (a misbehaving
plugin can't break the page).
"""

from pluggy import HookspecMarker

hookspec = HookspecMarker("datasette")


@hookspec
def paper_embed_provider(datasette):
    """Return an embed provider (or a list of them) for the paper editor.

    A provider is any object exposing ``kind`` (str) and
    ``frontend_assets(datasette)``, optionally ``label`` (str) and
    ``ref_prefixes`` (list[str]). See the module docstring for the full
    contract.
    """
