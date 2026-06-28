"""Plugin hooks datasette-paper exposes to *other* Datasette plugins.

Registered on Datasette's own plugin manager (pluggy project ``"datasette"``),
so any installed plugin implements them with ``from datasette import hookimpl``.

``paper_embed_provider`` is the backend half of third-party embeds. Rendering is
entirely client-side — a provider ships a JS bundle that ``export default``s a
provider object; the backend only *describes* each provider so paper can
lazy-load (``import()``) that bundle on demand. Full contract + examples live in
``docs/EMBED_PROVIDERS.md``.
"""

from typing import Optional, Protocol, TypedDict, Union

from pluggy import HookspecMarker

hookspec = HookspecMarker("datasette")


class FrontendAssets(TypedDict, total=False):
    """URLs of a provider's lazy-loaded bundle. Both keys optional."""

    js: list[str]
    css: list[str]


class PaperEmbedProvider(Protocol):
    """A third-party embed provider (duck-typed; plugins return their own).

    ``kind`` (stable id matching the bundle's exported ``kind``) and
    ``frontend_assets`` are required. ``label`` (str) and ``ref_prefixes``
    (list[str]) are optional and read when present. See ``docs/EMBED_PROVIDERS``.

    ``resource_url`` is an OPTIONAL method::

        def resource_url(self, datasette, ref: str) -> str | None:
            '''Absolute or root-relative URL a reader can follow to this ref's
            resource (used as the markdown href; the canonical paper:/ ref is
            kept in the link title). Optional — return None to emit the bare
            paper:/ ref.'''

    A provider whose ``resource_url`` raises is logged and treated as no-URL
    (the markdown href falls back to the bare canonical ref).
    """

    kind: str

    def frontend_assets(self, datasette) -> FrontendAssets: ...


@hookspec
def paper_embed_provider(
    datasette,
) -> "Optional[Union[PaperEmbedProvider, list[PaperEmbedProvider]]]":
    """Return an embed provider (or a list of them) for the paper editor."""
