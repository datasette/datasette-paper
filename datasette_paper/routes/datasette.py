"""Route handlers for the datasette_ref / datasette_embed feature.

Three ungated routes (no Paper-doc gate) whose results are filtered against
the *requesting actor's* Datasette permissions in ``resources.py`` — never
the doc owner's. ``denied`` / ``not_found`` responses carry no label or row
data, so a viewer can't learn the existence or contents of a resource they
can't see. Mirrors the ungated-but-acl-filtered pattern of
``resolve_links`` / ``resolve_actors`` in ``docs.py``.

No ``from __future__ import annotations`` here — the router introspects
parameter annotations to inject URL vars (CLAUDE.md rule 3).
"""

from datasette import Response

from ..router import router
from ..util import read_json_body
from ..resources import (
    DEFAULT_EMBED_LIMIT,
    MAX_EMBED_LIMIT,
    MAX_RESOLVE_REFS,
    render_ref,
    resolve_refs,
    search_resources,
)


@router.POST(r"^/-/paper/api/datasette/resolve$")
async def datasette_resolve(datasette, request):
    """Batch-resolve refs to display labels for the inline pill NodeView."""
    body = await read_json_body(request)
    raw = body.get("refs") or []
    refs = [str(r) for r in raw[:MAX_RESOLVE_REFS] if r]
    out = await resolve_refs(datasette, request.actor, refs)
    return Response.json({"refs": out})


@router.GET(r"^/-/paper/api/datasette/search$")
async def datasette_search(datasette, request):
    """Name-search visible databases / tables / views for the picker."""
    q = (request.args.get("q") or "").strip()
    try:
        limit = min(int(request.args.get("limit") or 20), 50)
    except ValueError:
        limit = 20
    results = await search_resources(datasette, request.actor, q, limit)
    return Response.json({"results": results})


@router.GET(r"^/-/paper/api/datasette/embed$")
async def datasette_embed(datasette, request):
    """Render a ref to a read-only embed payload (capped rows / row fields)."""
    ref = request.args.get("ref") or ""
    try:
        limit = int(request.args.get("limit") or DEFAULT_EMBED_LIMIT)
    except ValueError:
        limit = DEFAULT_EMBED_LIMIT
    limit = max(1, min(limit, MAX_EMBED_LIMIT))
    payload = await render_ref(datasette, request.actor, ref, limit)
    return Response.json(payload)
