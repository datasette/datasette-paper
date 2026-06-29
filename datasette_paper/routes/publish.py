"""Publishing routes: publish / unpublish / preview / list + the public
read-only published page.

Publishing pins a doc version, renders it to static HTML server-side
(``publish.build_publication`` → ``html_render``), and serves it from a thin
template — cheap for high-fanout audiences. The published page has its own acl
audience (``paper-doc-published``), independent of the live-doc editors. See
``plans/publishing/`` for the full design.
"""

import datetime
from typing import Annotated

from datasette import Response
from datasette_plugin_router import Body

from datasette_acl.grants import Principal

from ..publish import build_publication, make_sql_runner
from ..embed_providers import provider_precompute
from ..instance import get_registry
from ..permissions import (
    can_paper_manage,
    can_published_view,
    ensure_paper_view,
    grant_published_view,
    published_audience_class,
)
from ..router import router
from ..schemas import PublishBody
from ..util import actor_id, paper_db

_VALID_MODES = {"live", "frozen"}


def _now_iso() -> str:
    """Publish-time stamp for the 'data as of …' footer on frozen blocks."""
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _make_embed_precompute(datasette, actor):
    """Frozen-mode payload computer for custom-provider block embeds (T06)."""

    async def precompute(block):
        if block.kind != "embed":
            return None
        cfg = block.config or {}
        return await provider_precompute(datasette, cfg.get("ref"), cfg, actor)

    return precompute


def _principal_from_grant(g) -> Principal:
    """Build an acl Principal from a PublishAudienceGrant body item."""
    p = g.principal
    if p == "actor":
        if not g.actor_id:
            raise ValueError("actor audience grant requires actor_id")
        return Principal.actor(str(g.actor_id))
    if p == "group":
        if g.group_id is None:
            raise ValueError("group audience grant requires group_id")
        return Principal.group(int(g.group_id))
    return Principal.public(p)


async def _broadcast_published(datasette, doc_id, version):
    """Notify any live editors of this doc that it was (un)published.

    Only touches an already-hydrated Instance — publishing must not spin one up
    just to broadcast to nobody.
    """
    registry = get_registry(datasette)
    inst = registry._instances.get(doc_id)
    if inst is not None:
        inst.broadcast_published(version)


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/publish$")
async def publish_doc(
    datasette, request, doc_id: int, body: Annotated[PublishBody, Body()]
):
    if not await can_paper_manage(datasette, request.actor, doc_id):
        return Response.json({"error": "Manager access required"}, status=403)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    version = body.version if body.version is not None else doc.current_version

    data_mode_default = body.data_mode_default or "live"
    if data_mode_default not in _VALID_MODES:
        return Response.json(
            {"error": "data_mode_default must be 'live' or 'frozen'"}, status=400
        )
    for bid, mode in (body.block_overrides or {}).items():
        if mode not in _VALID_MODES:
            return Response.json(
                {"error": f"block override {bid!r} must be 'live' or 'frozen'"},
                status=400,
            )

    me = actor_id(request)
    built = await build_publication(
        datasette,
        db,
        doc_id=doc_id,
        version=version,
        data_mode_default=data_mode_default,
        block_overrides=body.block_overrides or {},
        published_by=me,
        # Frozen blocks run their query once, now, as the publishing actor.
        run_sql=make_sql_runner(datasette, request.actor),
        embed_precompute=_make_embed_precompute(datasette, request.actor),
        computed_at=_now_iso(),
    )

    await db.write_publication(
        doc_id=doc_id,
        version=version,
        html=built["html"],
        doc_json=built["doc_json"],
        data_mode_default=data_mode_default,
        config_json=built["config_json"],
        has_live_blocks=built["has_live_blocks"],
        published_by=me,
        frozen_data=built["frozen_data"],
    )

    # Always make sure the publisher can read their own published page.
    if me:
        await grant_published_view(
            datasette, doc_id, Principal.actor(str(me)), by_actor=me
        )
    # Apply the requested audience grants (if any) atomically with the publish.
    if body.audience:
        for g in body.audience:
            try:
                principal = _principal_from_grant(g)
            except ValueError as exc:
                return Response.json({"error": str(exc)}, status=400)
            await grant_published_view(datasette, doc_id, principal, by_actor=me)

    await _broadcast_published(datasette, doc_id, version)

    return Response.json(
        {
            "ok": True,
            "doc_id": doc_id,
            "version": version,
            "has_live_blocks": built["has_live_blocks"],
            "blocks": built["blocks"],
            "warnings": built["warnings"],
            "url": f"/-/paper/doc/{doc_id}/publish",
        }
    )


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/unpublish$")
async def unpublish_doc(datasette, request, doc_id: int):
    if not await can_paper_manage(datasette, request.actor, doc_id):
        return Response.json({"error": "Manager access required"}, status=403)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    # Clear the pointer; keep the publication row + audience grants so a
    # republish of the same version restores access without re-granting.
    await db.clear_published_version(doc_id=doc_id)
    await _broadcast_published(datasette, doc_id, None)
    return Response.json({"ok": True, "doc_id": doc_id})


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)/publications$")
async def list_publications(datasette, request, doc_id: int):
    await ensure_paper_view(datasette, request, doc_id)
    db = paper_db(datasette)
    current = await db.select_published_version(doc_id=doc_id)
    rows = await db.list_publication_versions(doc_id=doc_id)
    return Response.json(
        {
            "doc_id": doc_id,
            "published_version": current,
            "publications": [
                {
                    "version": r.version,
                    "data_mode_default": r.data_mode_default,
                    "has_live_blocks": bool(r.has_live_blocks),
                    "published_at": r.published_at,
                    "published_by": r.published_by,
                    "is_current": r.version == current,
                }
                for r in rows
            ],
        }
    )


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)/publish/preview$")
async def preview_publication(datasette, request, doc_id: int):
    """Render a candidate publication without persisting it (publish dialog)."""
    if not await can_paper_manage(datasette, request.actor, doc_id):
        return Response.json({"error": "Manager access required"}, status=403)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    try:
        version = int(request.args.get("version") or doc.current_version)
    except (TypeError, ValueError):
        return Response.json({"error": "invalid version"}, status=400)
    data_mode_default = request.args.get("data_mode_default") or "live"
    if data_mode_default not in _VALID_MODES:
        return Response.json(
            {"error": "data_mode_default must be 'live' or 'frozen'"}, status=400
        )
    built = await build_publication(
        datasette,
        db,
        doc_id=doc_id,
        version=version,
        data_mode_default=data_mode_default,
        published_by=actor_id(request),
        run_sql=make_sql_runner(datasette, request.actor),
        embed_precompute=_make_embed_precompute(datasette, request.actor),
        computed_at=_now_iso(),
    )
    return Response.json(
        {
            "doc_id": doc_id,
            "version": version,
            "html": built["html"],
            "has_live_blocks": built["has_live_blocks"],
            "blocks": built["blocks"],
            "warnings": built["warnings"],
        }
    )


# ---------------------------------------------------------------------------
# The public read-only published page
# ---------------------------------------------------------------------------

# Cache-Control by audience (see plans/publishing/05-caching.md). The canonical
# URL points at the *current* version (which can change on republish), so it
# uses a short max-age + revalidation; the ETag changes with the version.
_CACHE_BY_AUDIENCE = {
    "public": "public, max-age=60, stale-while-revalidate=600",
    "auth": "private, max-age=60",
    "private": "private, no-cache",
}


async def _serve_publication(datasette, request, doc_id, version):
    """Shared view-route body: load a publication + serve it with validators.

    Returns 404 (never 403) for an unpublished/trashed doc or an out-of-audience
    actor, so a published page never leaks the existence of a doc.
    """
    # Audience gate first. Out-of-audience → 404 (not 403) so a published page
    # never leaks the existence of a doc.
    if not await can_published_view(datasette, request.actor, doc_id):
        return Response.html("Not found", status=404)

    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None or doc.state != "active":
        return Response.html("Not found", status=404)

    if version is None:
        version = await db.select_published_version(doc_id=doc_id)
        if version is None:
            return Response.html("Not found", status=404)

    pub = await db.select_publication(doc_id=doc_id, version=version)
    if pub is None:
        return Response.html("Not found", status=404)

    etag = f'"{doc_id}-{version}"'
    audience = await published_audience_class(datasette, doc_id)
    cache_control = _CACHE_BY_AUDIENCE.get(audience, "private, no-cache")
    headers = {
        "ETag": etag,
        "Last-Modified": pub.published_at,
        "Cache-Control": cache_control,
    }
    if audience != "public":
        headers["Vary"] = "Cookie"

    if (request.headers.get("if-none-match") or "").strip() == etag:
        return Response("", status=304, headers=headers)

    # The publish entry carries both the published stylesheet and the live-block
    # hydrator. The CSS is always needed (even an all-frozen page must be
    # styled), and the hydrator is a no-op when there are no [data-publish-live]
    # blocks, so we always inject the entry. (The bundle is tiny — ~1KB gzipped
    # JS + the CSS — and pulls in no ProseMirror/editor code.)
    entrypoint = "src/pages/publish/main.ts"
    page_data = {
        "doc_id": doc_id,
        "published_version": version,
        "embed_providers": _provider_manifest(datasette),
    }
    html = await datasette.render_template(
        "paper_published.html",
        {
            "page_title": doc.name or f"Paper {doc_id}",
            "entrypoint": entrypoint,
            "published_html": pub.html,
            "page_data": page_data,
        },
        request=request,
    )
    return Response.html(html, headers=headers)


def _provider_manifest(datasette):
    from ..embed_providers import provider_manifest

    return provider_manifest(datasette)


@router.GET(r"^/-/paper/doc/(?P<doc_id>\d+)/publish$")
async def published_page(datasette, request, doc_id: int):
    return await _serve_publication(datasette, request, doc_id, None)


@router.GET(r"^/-/paper/doc/(?P<doc_id>\d+)/publish/v/(?P<version>\d+)$")
async def published_page_version(datasette, request, doc_id: int, version: int):
    return await _serve_publication(datasette, request, doc_id, version)
