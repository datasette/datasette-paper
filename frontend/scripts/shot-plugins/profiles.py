"""Throwaway actor display names for the screenshot script.

Loaded via `datasette --plugins-dir` from frontend/scripts/screenshots.mjs so
the seeded papers show friendly names ("Alice Ada") instead of raw ids in the
"Created by" column and doc header. NOT shipped — dev/screenshot use only.

`actors_from_ids` is `firstresult=True`; this plugin is registered after
Datasette's core default, so it's called first and wins.
"""

from datasette import hookimpl

DISPLAY_NAMES = {
    "alice": "Alice Ada",
    "bob": "Bob Babbage",
    "carol": "Carol Shaw",
}


@hookimpl
def actors_from_ids(actor_ids):
    out = {}
    for aid in actor_ids:
        sid = str(aid)
        actor = {"id": sid}
        if sid in DISPLAY_NAMES:
            actor["name"] = DISPLAY_NAMES[sid]
        out[sid] = actor
    return out
