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
editor page. That is this hook's sole job::

    frontend_assets(datasette) -> {"js": [...urls], "css": [...urls]}

The returned URLs are injected into the paper doc page (``/-/paper/doc/<id>``)
only — not every Datasette page. Both string keys are optional; return ``{}``
to contribute nothing. A provider that raises here is logged and skipped (a
misbehaving plugin can't break the page).
"""

from pluggy import HookspecMarker

hookspec = HookspecMarker("datasette")


@hookspec
def paper_embed_provider(datasette):
    """Return an embed provider (or a list of them) for the paper editor.

    A provider is any object with a ``frontend_assets(datasette)`` method.
    See the module docstring for the full contract.
    """
