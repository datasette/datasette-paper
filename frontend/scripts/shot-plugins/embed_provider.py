"""Throwaway third-party embed provider for the screenshot harness.

Populates the `/` slash menu's "Embeds" section (and the toolbar embed
dropdown) with example provider sources so the `slash-menu-embeds` shot has
content to capture. Loaded via `datasette --plugins-dir` alongside the actor
display-name plugin. NOT shipped — screenshot/dev use only.

Only the manifest's `sources` matter here: the `/` menu lists them straight
from `page_data` before any bundle loads (embedProviders.ts). The shots only
*display* the menu — they never open this provider's picker — so
`frontend_assets` returns nothing (no bundle to serve).
"""

from datasette import hookimpl


class _ShotEmbedProvider:
    kind = "place-list"
    label = "Places"
    ref_prefixes = ["/-/places/"]
    # Icons must be TOOLBAR_ICONS keys (icons.ts) or the `/` menu falls back to
    # the database icon; "table" / "eye" both exist and render distinctly.
    sources = [
        {"id": "place-list", "label": "Places map", "icon": "table"},
        {"id": "place-search", "label": "Place search", "icon": "eye"},
    ]

    def frontend_assets(self, datasette):
        return {}


@hookimpl
def paper_embed_provider(datasette):
    return _ShotEmbedProvider()
