"""Plugin hooks datasette-paper exposes to *other* Datasette plugins.

Registered on Datasette's own plugin manager (pluggy project ``"datasette"``),
so any installed plugin implements them with ``from datasette import hookimpl``.

``paper_embed_provider`` is the backend half of third-party embeds. Rendering is
entirely client-side — a provider ships a JS bundle that registers on
``window.datasettePaperEmbeds``; the backend only *describes* each provider so
paper can lazy-load that bundle on demand. Full contract + examples live in
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

    ``kind`` (stable id matching the JS ``register({kind})``) and
    ``frontend_assets`` are required. ``label`` (str) and ``ref_prefixes``
    (list[str]) are optional and read when present. See ``docs/EMBED_PROVIDERS``.
    """

    kind: str

    def frontend_assets(self, datasette) -> FrontendAssets: ...


@hookspec
def paper_embed_provider(
    datasette,
) -> "Optional[Union[PaperEmbedProvider, list[PaperEmbedProvider]]]":
    """Return an embed provider (or a list of them) for the paper editor."""
