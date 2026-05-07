"""Route handlers for datasette-paper document API and HTML pages."""

import json

from datasette import Response

from ..router import router
from ..instance import get_registry
from ..markdown import doc_to_markdown, extract_tasks, group_tasks_by_section
from ..permissions import (
    PaperResource,
    ensure_paper_create,
    ensure_paper_edit,
    ensure_paper_list,
    ensure_paper_view,
)
from ..util import read_json_body, actor_id, paper_db


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------


@router.GET(r"^/-/paper/api/docs$")
async def list_docs(datasette, request):
    await ensure_paper_list(datasette, request)
    # Pull every paper the actor can view in one shot (cap at 1000; if
    # somebody has 1000+ papers visible we'll add proper pagination).
    page = await datasette.allowed_resources(
        action="datasette-paper-view", actor=request.actor, limit=1000
    )
    # PaperResource is single-level — id lives in `parent`, child is None.
    doc_ids = [int(r.parent) for r in page.resources]
    db = paper_db(datasette)
    rows = await db.list_docs_by_ids(doc_ids=doc_ids)
    actor = request.actor
    me = actor.get("id") if actor else None
    return Response.json(
        [
            {
                "id": r.id,
                "name": r.name,
                "current_version": r.current_version,
                "updated_at": r.updated_at,
                "created_by": r.created_by,
                "visibility": r.visibility,
                "is_owner": r.created_by is not None and r.created_by == me,
            }
            for r in rows
        ]
    )


@router.POST(r"^/-/paper/api/docs$")
async def create_doc(datasette, request):
    await ensure_paper_create(datasette, request)
    db = paper_db(datasette)
    body = await read_json_body(request)
    name = body.get("name", "Untitled")
    doc = await db.insert_doc(name=name, created_by=actor_id(request))
    return Response.json(
        {
            "id": doc.id,
            "name": doc.name,
            "current_version": doc.current_version,
            "updated_at": doc.updated_at,
            "created_by": doc.created_by,
        },
        status=201,
    )


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)$")
async def get_doc_bootstrap(datasette, request, doc_id: int):
    await ensure_paper_view(datasette, request, doc_id)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id)

    steps_after_snapshot = [
        s for s in instance.steps_tail if s["version"] > instance.snapshot_version
    ]

    me = actor_id(request)
    is_owner = doc.created_by is not None and doc.created_by == me
    can_edit = await datasette.allowed(
        action="datasette-paper-edit",
        resource=PaperResource(doc_id),
        actor=request.actor,
    )

    return Response.json(
        {
            "doc": json.loads(instance.snapshot_doc_json),
            "snapshotVersion": instance.snapshot_version,
            "version": instance.version,
            "steps": [json.loads(s["step_json"]) for s in steps_after_snapshot],
            "clientIDs": [s["client_id"] for s in steps_after_snapshot],
            "users": len(instance.subscribers),
            "selfActor": me,
            "permissions": {
                "canView": True,
                "canEdit": can_edit,
                "canManage": is_owner,
                "isOwner": is_owner,
                "visibility": doc.visibility,
            },
        }
    )


def _wants_markdown(accept: str) -> bool:
    """Return True if the Accept header prefers markdown over JSON.

    Recognises `text/markdown` and the unofficial-but-common
    `application/markdown`. Lightweight match: split on `,` and look at
    the bare media-type before any q-params; first explicit md hit wins.
    """
    if not accept:
        return False
    for entry in accept.split(","):
        media = entry.split(";", 1)[0].strip().lower()
        if media in ("text/markdown", "application/markdown"):
            return True
    return False


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)/document$")
async def get_document(datasette, request, doc_id: int):
    """Return the doc as JSON (with metadata + markdown) or raw markdown.

    The body reflects the live doc — snapshot + applied steps_tail —
    materialized via `Instance.materialize_live_doc()`. `pending_steps`
    is kept in the envelope for backward compatibility but is now
    informational only.
    """
    await ensure_paper_view(datasette, request, doc_id)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id)

    live_doc = instance.materialize_live_doc()
    md = doc_to_markdown(live_doc)

    accept = request.headers.get("accept", "") or request.headers.get("Accept", "")
    if _wants_markdown(accept):
        return Response(md, content_type="text/markdown; charset=utf-8")

    return Response.json(
        {
            "id": doc.id,
            "name": doc.name,
            "version": instance.version,
            "snapshot_version": instance.snapshot_version,
            "pending_steps": instance.version - instance.snapshot_version,
            "created_by": doc.created_by,
            "updated_at": doc.updated_at,
            "content_markdown": md,
        }
    )


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)/tasks$")
async def get_tasks(datasette, request, doc_id: int):
    """Return the doc's task_items as JSON, optionally filtered by status."""
    await ensure_paper_view(datasette, request, doc_id)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id)

    live_doc = instance.materialize_live_doc()
    tasks = extract_tasks(live_doc)

    status = (request.args.get("status") or "all").lower()
    if status == "open":
        tasks = [t for t in tasks if not t["checked"]]
    elif status == "done":
        tasks = [t for t in tasks if t["checked"]]
    elif status != "all":
        return Response.json(
            {"error": "status must be one of: open, done, all"},
            status=400,
        )

    return Response.json(
        {
            "doc_id": doc.id,
            "version": instance.version,
            "snapshot_version": instance.snapshot_version,
            "pending_steps": instance.version - instance.snapshot_version,
            "tasks": tasks,
            "sections": group_tasks_by_section(tasks),
        }
    )


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/rename$")
async def rename_doc(datasette, request, doc_id: int):
    await ensure_paper_edit(datasette, request, doc_id)
    db = paper_db(datasette)
    body = await read_json_body(request)
    new_name = (body.get("name") or "").strip()
    if not new_name:
        return Response.json({"error": "name is required"}, status=400)
    doc = await db.update_doc_name(doc_id=doc_id, name=new_name)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    return Response.json(
        {
            "id": doc.id,
            "name": doc.name,
            "current_version": doc.current_version,
            "updated_at": doc.updated_at,
            "created_by": doc.created_by,
        }
    )


VALID_VISIBILITIES = ("private", "link-view", "link-edit")
VALID_ROLES = ("viewer", "editor")


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)/share$")
async def get_share(datasette, request, doc_id: int):
    """Return the share state — anyone who can view the doc can see who else has access."""
    await ensure_paper_view(datasette, request, doc_id)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    shares = await db.select_shares(doc_id=doc_id)
    me = actor_id(request)
    can_manage = doc.created_by is not None and doc.created_by == me
    return Response.json(
        {
            "visibility": doc.visibility,
            "owner": doc.created_by,
            "shares": [
                {
                    "actorID": s.actor_id,
                    "role": s.role,
                    "grantedAt": s.granted_at,
                }
                for s in shares
            ],
            "canManage": can_manage,
        }
    )


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/share$")
async def post_share(datasette, request, doc_id: int):
    """Replace the share state atomically. Owner-only."""
    await ensure_paper_edit(datasette, request, doc_id)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    me = actor_id(request)
    if doc.created_by is None or doc.created_by != me:
        # Manage is owner-only — even editors can't reshare.
        from datasette import Forbidden

        raise Forbidden("datasette-paper-manage")

    body = await read_json_body(request)
    visibility = body.get("visibility")
    if visibility not in VALID_VISIBILITIES:
        return Response.json(
            {"error": f"visibility must be one of: {', '.join(VALID_VISIBILITIES)}"},
            status=400,
        )

    raw_shares = body.get("shares", [])
    if not isinstance(raw_shares, list):
        return Response.json({"error": "shares must be a list"}, status=400)

    seen: set[str] = set()
    parsed: list[tuple[str, str]] = []
    for entry in raw_shares:
        if not isinstance(entry, dict):
            return Response.json({"error": "each share must be an object"}, status=400)
        actor_value = entry.get("actorID")
        role = entry.get("role")
        if not isinstance(actor_value, str) or not actor_value.strip():
            return Response.json(
                {"error": "actorID must be a non-empty string"}, status=400
            )
        if role not in VALID_ROLES:
            return Response.json(
                {"error": f"role must be one of: {', '.join(VALID_ROLES)}"},
                status=400,
            )
        actor_value = actor_value.strip()
        if actor_value == doc.created_by:
            return Response.json({"error": "owner cannot appear in shares"}, status=400)
        if actor_value in seen:
            return Response.json(
                {"error": f"duplicate actor in shares: {actor_value}"},
                status=400,
            )
        seen.add(actor_value)
        parsed.append((actor_value, role))

    await db.replace_shares(
        doc_id=doc_id,
        visibility=visibility,
        shares=parsed,
        granted_by=me,
    )

    # Sweep any open SSE subscribers whose access has been revoked.
    registry = get_registry(datasette)
    if doc_id in registry._instances:
        instance = registry._instances[doc_id]
        await instance.revoke_unauthorized(datasette)

    # Return the new state in the same shape as GET.
    refreshed = await db.select_doc_by_id(doc_id)
    shares_after = await db.select_shares(doc_id=doc_id)
    return Response.json(
        {
            "visibility": refreshed.visibility,
            "owner": refreshed.created_by,
            "shares": [
                {
                    "actorID": s.actor_id,
                    "role": s.role,
                    "grantedAt": s.granted_at,
                }
                for s in shares_after
            ],
            "canManage": True,
        }
    )


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/snapshot$")
async def post_snapshot(datasette, request, doc_id: int):
    await ensure_paper_edit(datasette, request, doc_id)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    body = await read_json_body(request)
    version = int(body["version"])
    doc_json_str = json.dumps(body["doc"])

    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id)
    await instance.record_client_doc(version, doc_json_str, actor_id=actor_id(request))

    return Response("", status=204)


# ---------------------------------------------------------------------------
# HTML routes
# ---------------------------------------------------------------------------


@router.GET(r"^/-/paper/$")
async def paper_index_page(datasette, request):
    await ensure_paper_list(datasette, request)
    return Response.html(
        await datasette.render_template(
            "paper_base.html",
            {
                "page_title": "Papers",
                "entrypoint": "src/pages/index/main.ts",
                "page_data": {},
            },
            request=request,
        )
    )


@router.GET(r"^/-/paper/doc/(?P<doc_id>\d+)$")
async def paper_doc_page(datasette, request, doc_id: int):
    await ensure_paper_view(datasette, request, doc_id)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.html("Document not found", status=404)
    return Response.html(
        await datasette.render_template(
            "paper_base.html",
            {
                "page_title": doc.name or f"Paper {doc_id}",
                "body_class": "paper-fullscreen",
                "entrypoint": "src/pages/doc/main.ts",
                "page_data": {"doc_id": doc_id},
            },
            request=request,
        )
    )
