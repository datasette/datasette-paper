"""Plugin hooks datasette-paper exposes to *other* Datasette plugins.

Registered on Datasette's own plugin manager (pluggy project ``"datasette"``)
so any installed plugin can implement them with the usual
``from datasette import hookimpl``.

``paper_resource_provider`` is the extension point behind the
``datasette_ref`` / ``datasette_embed`` feature. It lets a plugin claim its
own URL namespace and supply a label + (optionally) a rich block render —
e.g. datasette-places returning a map for ``/-/places/list/{id}``.

A provider is any object implementing::

    claims(ref: str) -> bool
        # does this provider own this (base_url-relative) path?

    async resolve(datasette, actor, ref: str) -> dict
        # ref -> {"status","kind","label","href", "icon"?, ...}
        # same shape as the built-in provider's resolve.

    async render(datasette, actor, ref: str, mode: str, limit: int) -> dict
        # block-embed payload; the same shape the /embed endpoint returns.
        # Return {"status": "ok", "kind": <kind>, "label", "href", "icon"?}
        # for a kind rendered by a registered frontend renderer (the data is
        # then fetched client-side), or a full payload for a built-in kind.

    frontend_assets(datasette) -> {"js": [...urls], "css": [...urls]}   # optional
        # JS/CSS the frontend renderer needs; injected into the paper editor
        # page only (not every Datasette page).

**Permission is the provider's own responsibility** — check the actor
against your own model and return ``{"status": "denied"}`` for someone who
can't see the resource. Never leak a label or data on ``denied`` /
``not_found``.
"""

from pluggy import HookspecMarker

hookspec = HookspecMarker("datasette")


@hookspec
def paper_resource_provider(datasette):
    """Return a resource provider (or a list of them) for custom refs.

    See the module docstring for the provider interface.
    """
