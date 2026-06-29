"""Sample third-party embed providers for datasette-paper.

A runnable demo **and** integration test of the two halves of the custom-embed
feature:

  * the backend ``paper_embed_provider`` hook (manifest: kind / label /
    ``ref_prefixes`` / ``sources`` / ``frontend_assets``), and
  * the ``export default`` provider JS API (``resolve`` / ``mount`` /
    ``matchRef`` / ``matchUrl`` / ``picker`` / ``search``) — see the sibling
    ``playlists.js`` / ``widgets.js`` ES-module bundles this plugin serves.

Two providers, both with rich vanilla-JS rendering and *interesting* per-viewer
permissions:

  * **playlists** — a shared music playlist. Inline embed → a pill (title +
    track count); block embed → a track list with play-count bars. Visible to
    the owner, anyone in the playlist's newsroom group, or (public ones) any
    signed-in actor; otherwise **403 denied** (existence is fine to reveal).
  * **widgets** — a small dashboard widget (a press-pass *badge* or a bat-signal
    *gauge*). Demonstrates leak discipline: the **secret** ``bat-signal`` 404s
    for everyone but its owner (never reveal it exists), while ``press-pass``
    403s when known-but-forbidden.

**Permissions live here, not in paper.** Each provider's own JSON routes gate on
the viewer's ``request.actor`` (``id`` + ``newsroom`` group) — exactly the embed
contract: paper's backend is never in the resolve/render path, so each provider
applies its own leak discipline with the *viewer's* cookie. Actors come from
``datasette-debug-gotham`` under ``just dev`` (use the debug-bar "act as"
switch); the tests sign a ``ds_actor`` cookie directly.

Kept deliberately lightweight (plain dicts, no datasette-acl resource
registration) so it stays a focused demo of the *embed* API — cf.
``../datasette-acl-share/tests/sample_plugins`` for the heavier custom-resource
pattern.

Loaded via ``--plugins-dir tests/sample-plugin`` (see ``just dev``) or by
importing + ``pm.register`` (see ``tests/test_sample_embeds.py``).
"""

from html import escape
from pathlib import Path

from datasette import hookimpl, Response

_HERE = Path(__file__).parent

# ---------------------------------------------------------------------------
# Sample data (static — no DB). Newsroom groups mirror datasette-debug-gotham:
# daily-planet = {clark, lois, jimmy}; gotham-gazette = {bruce, alfred, selina}.
# The actor dict already carries its `newsroom`, so we never need a member map.
# ---------------------------------------------------------------------------
PLAYLISTS = {
    "summer-mix": {
        "title": "Summer Road-Trip Mix",
        "owner": "clark",
        "newsroom": "daily-planet",
        "public": False,
        "tracks": [
            {"title": "Metropolis Sunrise", "artist": "The Planets", "plays": 1840},
            {
                "title": "Faster Than a Bullet",
                "artist": "Kara & the Kryptones",
                "plays": 1210,
            },
            {"title": "Cape in the Wind", "artist": "Smallville", "plays": 980},
            {"title": "Daily Deadline", "artist": "Press Corps", "plays": 640},
        ],
    },
    "gotham-nights": {
        "title": "Gotham Nights",
        "owner": "bruce",
        "newsroom": "gotham-gazette",
        "public": False,
        "tracks": [
            {"title": "Signal in the Sky", "artist": "Wayne", "plays": 2200},
            {"title": "Alley Cat", "artist": "Selina K.", "plays": 1500},
            {"title": "Butler's Lament", "artist": "Pennyworth", "plays": 410},
        ],
    },
    "front-page-hits": {
        "title": "Front Page Hits",
        "owner": "lois",
        "newsroom": "daily-planet",
        "public": True,  # any signed-in actor
        "tracks": [
            {"title": "Stop the Presses", "artist": "Deadline", "plays": 3300},
            {"title": "Above the Fold", "artist": "Broadsheet", "plays": 2750},
        ],
    },
}

WIDGETS = {
    "press-pass": {
        "title": "Press Pass",
        "type": "badge",
        "color": "#1d4ed8",
        "holder": "Daily Planet",
        "newsroom": "daily-planet",  # known-but-forbidden → 403 for others
        "secret": False,
    },
    "bat-signal": {
        "title": "Bat-Signal Status",
        "type": "gauge",
        "value": 73,
        "owner": "bruce",
        "secret": True,  # leak discipline → 404 for anyone but bruce
    },
    "newsstand": {
        "title": "Newsstand Sales",
        "type": "gauge",
        "value": 42,
        "public": True,
        "secret": False,
    },
}


# ---------------------------------------------------------------------------
# Permission helpers — the heart of the per-viewer demo.
# ---------------------------------------------------------------------------
def _actor_bits(request):
    actor = request.actor or {}
    return actor.get("id"), actor.get("newsroom")


def _can_view_playlist(request, pl):
    aid, newsroom = _actor_bits(request)
    if not aid:
        return False  # anonymous sees nothing
    if pl.get("public"):
        return True
    if aid == pl.get("owner"):
        return True
    return bool(newsroom) and newsroom == pl.get("newsroom")


def _can_view_widget(request, w):
    aid, newsroom = _actor_bits(request)
    if not aid:
        return False
    if w.get("public"):
        return True
    if aid == w.get("owner"):
        return True
    return bool(newsroom) and newsroom == w.get("newsroom")


# ---------------------------------------------------------------------------
# The providers. A provider is any object with `kind` + `frontend_assets`,
# optionally `label` / `ref_prefixes` / `sources` (see paper's hookspecs.py).
# ---------------------------------------------------------------------------
class _SampleProvider:
    def __init__(self, *, kind, label, prefix, js_url, source_icon):
        self.kind = kind
        self.label = label
        self.ref_prefixes = [prefix]
        self.sources = [{"id": kind, "label": label, "icon": source_icon}]
        self._js_url = js_url

    def frontend_assets(self, datasette):
        # A single vanilla-JS bundle, served by this plugin's own route below.
        return {"js": [self._js_url]}

    def resource_url(self, datasette, ref):
        # The stored ref already IS the human-facing page URL for this sample
        # provider (e.g. /-/sample-embeds/playlists/summer-mix), so paper can
        # use it directly as the markdown href; the canonical paper:/ ref stays
        # in the link title. Returning the ref proves the title-attr path end
        # to end in the round-trip tests.
        return ref

    def precompute(self, datasette, ref, config, actor):
        # Reference implementation of the OPTIONAL frozen-publishing hook (see
        # paper's hookspecs.py): compute a JSON-serializable payload for this
        # ref at publish time, with the publisher's permissions. A real provider
        # would fetch its own data; here we synthesize a tiny tabular payload so
        # a frozen embed renders through paper's results-table path. Returning a
        # {columns, rows} dict keeps it identical to a live table embed.
        slug = ref.rstrip("/").rsplit("/", 1)[-1]
        return {
            "columns": ["field", "value"],
            "rows": [["kind", self.kind], ["ref", slug]],
        }


@hookimpl
def paper_embed_provider(datasette):
    return [
        _SampleProvider(
            kind="playlist",
            label="Playlists",
            prefix="/-/sample-embeds/playlists/",
            js_url="/-/sample-embeds/playlists.js",
            source_icon="database",
        ),
        _SampleProvider(
            kind="widget",
            label="Widgets",
            prefix="/-/sample-embeds/widgets/",
            js_url="/-/sample-embeds/widgets.js",
            source_icon="table",
        ),
    ]


# ---------------------------------------------------------------------------
# Routes: the JS bundles + the per-viewer JSON the bundles fetch. Standard
# Datasette `register_routes` (this is an ordinary plugin, not paper-internal).
# ---------------------------------------------------------------------------
def _serve_js(filename):
    async def view(datasette, request):
        body = (_HERE / filename).read_text()
        return Response(body, content_type="text/javascript; charset=utf-8")

    return view


async def _playlist_json(datasette, request):
    pid = request.url_vars["pid"]
    pl = PLAYLISTS.get(pid)
    if pl is None:
        return Response.json({"error": "not_found"}, status=404)
    if not _can_view_playlist(request, pl):
        return Response.json({"error": "denied"}, status=403)  # existence is fine
    return Response.json(
        {"id": pid, "title": pl["title"], "owner": pl["owner"], "tracks": pl["tracks"]}
    )


async def _playlists_search(datasette, request):
    q = (request.args.get("q") or "").lower()
    hits = []
    for pid, pl in PLAYLISTS.items():
        if not _can_view_playlist(request, pl):
            continue
        if q and q not in pl["title"].lower():
            continue
        hits.append(
            {
                "ref": f"/-/sample-embeds/playlists/{pid}",
                "label": pl["title"],
                "kind": "playlist",
                "detail": f"{len(pl['tracks'])} tracks",
            }
        )
    return Response.json({"results": hits})


async def _widget_json(datasette, request):
    wid = request.url_vars["wid"]
    w = WIDGETS.get(wid)
    if w is None:
        return Response.json({"error": "not_found"}, status=404)
    if not _can_view_widget(request, w):
        # Leak discipline: a *secret* widget must not even reveal it exists.
        status = 404 if w.get("secret") else 403
        return Response.json({"error": "denied"}, status=status)
    payload = {"id": wid, "title": w["title"], "type": w["type"]}
    if w["type"] == "badge":
        payload.update(color=w["color"], holder=w["holder"])
    else:
        payload.update(value=w["value"])
    return Response.json(payload)


async def _widgets_search(datasette, request):
    q = (request.args.get("q") or "").lower()
    hits = []
    for wid, w in WIDGETS.items():
        if not _can_view_widget(request, w):
            continue  # secret/forbidden widgets never appear in the picker
        if q and q not in w["title"].lower():
            continue
        hits.append(
            {
                "ref": f"/-/sample-embeds/widgets/{wid}",
                "label": w["title"],
                "kind": w["type"],
                "detail": w["type"],
            }
        )
    return Response.json({"results": hits})


def _html_page(title, body):
    return (
        "<!doctype html><meta charset=utf-8><title>"
        + escape(title)
        + "</title><body style='font-family:system-ui;max-width:640px;"
        + "margin:40px auto;padding:0 16px'>"
        + body
    )


async def _playlist_page(datasette, request):
    """Human-facing page at a playlist's ref — what the embed's title links to."""
    pl = PLAYLISTS.get(request.url_vars["pid"])
    if pl is None:
        return Response.html(
            _html_page("Not found", "<p>No such playlist.</p>"), status=404
        )
    if not _can_view_playlist(request, pl):
        return Response.html(
            _html_page("No access", "<p>You don't have access to this playlist.</p>"),
            status=403,
        )
    rows = "".join(
        f"<li>{escape(t['title'])} — {escape(t['artist'])} "
        f"<span style='color:#888'>({t['plays']:,} plays)</span></li>"
        for t in pl["tracks"]
    )
    return Response.html(
        _html_page(pl["title"], f"<h1>{escape(pl['title'])}</h1><ul>{rows}</ul>")
    )


async def _widget_page(datasette, request):
    """Human-facing page at a widget's ref — what the embed's title links to."""
    w = WIDGETS.get(request.url_vars["wid"])
    if w is None:
        return Response.html(
            _html_page("Not found", "<p>No such widget.</p>"), status=404
        )
    if not _can_view_widget(request, w):
        status = 404 if w.get("secret") else 403
        msg = (
            "No such widget."
            if w.get("secret")
            else "This widget isn't available to you."
        )
        return Response.html(_html_page("Unavailable", f"<p>{msg}</p>"), status=status)
    if w["type"] == "badge":
        detail = f"<p>Badge — holder: <strong>{escape(w['holder'])}</strong></p>"
    else:
        detail = f"<p>Gauge — value: <strong>{w['value']}%</strong></p>"
    return Response.html(
        _html_page(w["title"], f"<h1>{escape(w['title'])}</h1>{detail}")
    )


@hookimpl
def register_routes():
    # `.json` (embed data) and `.js` (bundle) routes come before the bare-ref
    # HTML pages so the more specific patterns win (Datasette matches in order).
    return [
        (r"^/-/sample-embeds/playlists\.js$", _serve_js("playlists.js")),
        (r"^/-/sample-embeds/widgets\.js$", _serve_js("widgets.js")),
        (r"^/-/sample-embeds/playlists\.json$", _playlists_search),
        (r"^/-/sample-embeds/playlists/(?P<pid>[^/]+)\.json$", _playlist_json),
        (r"^/-/sample-embeds/widgets\.json$", _widgets_search),
        (r"^/-/sample-embeds/widgets/(?P<wid>[^/]+)\.json$", _widget_json),
        (r"^/-/sample-embeds/playlists/(?P<pid>[^/]+)$", _playlist_page),
        (r"^/-/sample-embeds/widgets/(?P<wid>[^/]+)$", _widget_page),
    ]
