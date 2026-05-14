"""Route handlers for datasette-paper document API and HTML pages."""

import datetime
import json

from datasette import Forbidden, Response

from ..router import router
from ..instance import get_registry
from ..markdown import doc_to_markdown, extract_tasks, group_tasks_by_section
from ..tables import count_tables_with_name, extract_tables, find_table_by_name
from ..permissions import (
    PaperResource,
    ensure_paper_create,
    ensure_paper_edit,
    ensure_paper_list,
    ensure_paper_view,
)
from ..template_params import build_context, substitute_placeholders
from ..util import read_json_body, actor_id, paper_db


VALID_STATES = ("active", "archived", "trashed")
VALID_KINDS = ("doc", "template")
TRASH_RETENTION_DAYS = 7


def _iso(dt: datetime.datetime) -> str:
    """Format ``dt`` as ISO-8601 UTC with millisecond precision.

    Matches the shape of ``strftime('%Y-%m-%dT%H:%M:%fZ','now')`` that
    the schema's DEFAULTs emit, so timestamps written from Python sort
    lexicographically against timestamps written from SQL.
    """
    return (
        dt.strftime("%Y-%m-%dT%H:%M:")
        + f"{dt.second:02d}.{dt.microsecond // 1000:03d}Z"
    )


def _doc_state_payload(doc) -> dict:
    """State-related fields shared by the list endpoint, the bootstrap
    envelope, and the SSE state-changed payload."""
    return {
        "state": doc.state,
        "archived_at": doc.archived_at,
        "trashed_at": doc.trashed_at,
        "delete_at": doc.delete_at,
    }


def _doc_flags_payload(doc) -> dict:
    """Capability/category flags surfaced alongside state.

    ``kind`` and ``locked`` are orthogonal to the lifecycle state but
    every list/bootstrap response wants both. Kept in a separate helper
    so SSE state-changed payloads (which intentionally don't include
    these) stay narrow.
    """
    return {
        "kind": doc.kind,
        "locked": bool(doc.locked),
    }


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------


@router.GET(r"^/-/paper/api/docs$")
async def list_docs(datasette, request):
    await ensure_paper_list(datasette, request)
    # ``state`` filters the listing only — it isn't a permission concern.
    # ``allowed_resources`` still pulls every paper the actor can view;
    # the SQL helper then narrows to the requested state set. Default is
    # 'active' to match the main listing UI; the renovated /-/paper page
    # passes ?state=archived and ?state=trashed for the other two tabs.
    state = (request.args.get("state") or "active").lower()
    if state not in VALID_STATES:
        return Response.json(
            {"error": f"state must be one of: {', '.join(VALID_STATES)}"},
            status=400,
        )
    # ``kind=doc`` is the default — templates live in their own tab so
    # they don't clutter the index. Pass ``kind=template`` explicitly
    # to list templates, or ``kind=all`` for both.
    kind = (request.args.get("kind") or "doc").lower()
    if kind == "all":
        kinds = list(VALID_KINDS)
    elif kind in VALID_KINDS:
        kinds = [kind]
    else:
        return Response.json(
            {"error": f"kind must be one of: {', '.join(VALID_KINDS)}, all"},
            status=400,
        )

    # Pull every paper the actor can view in one shot (cap at 1000; if
    # somebody has 1000+ papers visible we'll add proper pagination).
    page = await datasette.allowed_resources(
        action="datasette-paper-view", actor=request.actor, limit=1000
    )
    # PaperResource is single-level — id lives in `parent`, child is None.
    doc_ids = [int(r.parent) for r in page.resources]
    db = paper_db(datasette)
    rows = await db.list_docs_by_ids_states_and_kinds(
        doc_ids=doc_ids, states=[state], kinds=kinds
    )
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
                **_doc_state_payload(r),
                **_doc_flags_payload(r),
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
    template_id_raw = body.get("template_id")
    # Templates always materialize into a new ``kind='doc'`` row — you
    # use a template, you don't become one. To create a brand-new
    # template, the client sends ``{"kind": "template"}`` with no
    # template_id (and writes content via the editor afterwards).
    kind = body.get("kind", "doc")
    if kind not in VALID_KINDS:
        return Response.json(
            {"error": f"kind must be one of: {', '.join(VALID_KINDS)}"},
            status=400,
        )
    if template_id_raw is not None and kind != "doc":
        return Response.json(
            {"error": "template_id is only valid for kind='doc'"},
            status=400,
        )

    if template_id_raw is not None:
        try:
            template_id = int(template_id_raw)
        except (TypeError, ValueError):
            return Response.json(
                {"error": "template_id must be an integer"}, status=400
            )
        # Source-template view permission is sufficient to instantiate
        # — the resulting doc is owned by the actor, decoupled from the
        # template's share/visibility state.
        await ensure_paper_view(datasette, request, template_id)
        template = await db.select_doc_by_id(template_id)
        if template is None:
            return Response.json({"error": "Template not found"}, status=404)
        if template.kind != "template":
            return Response.json(
                {"error": "Source paper is not a template"}, status=400
            )
        registry = get_registry(datasette)
        instance = await registry.get(db, template_id)
        live_doc = instance.materialize_live_doc()
        # Substitute every placeholder node with text resolved against
        # the creating actor's context (built-ins like {today} / {actor}
        # land here). Result is a regular doc — kind='doc' — with no
        # placeholder nodes left.
        ctx = build_context(actor_id=actor_id(request))
        materialized = substitute_placeholders(live_doc, ctx)
        doc = await db.insert_doc_with_snapshot(
            name=name,
            created_by=actor_id(request),
            kind="doc",
            snapshot_doc_json=json.dumps(materialized),
            snapshot_actor_id=actor_id(request),
        )
    else:
        doc = await db.insert_doc(
            name=name,
            created_by=actor_id(request),
            kind=kind,
        )
    return Response.json(
        {
            "id": doc.id,
            "name": doc.name,
            "current_version": doc.current_version,
            "updated_at": doc.updated_at,
            "created_by": doc.created_by,
            "kind": doc.kind,
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
                # ``locked`` lives inside permissions because it is a
                # capability gate — flipping it changes canEdit for
                # every non-owner. The same field appears flat on list
                # rows (no permissions sub-object there).
                "locked": bool(doc.locked),
            },
            # State seed for the open-doc UI. The same fields arrive over
            # SSE as ``state-changed`` whenever the owner flips state mid-
            # session, so the editor doesn't need to refetch.
            **_doc_state_payload(doc),
            # ``kind`` is metadata (doc vs template), distinct from the
            # state lifecycle and from the permission block.
            "kind": doc.kind,
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


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)/tables$")
async def get_tables(datasette, request, doc_id: int):
    """Return every table in the doc with its name + shape (no row data).

    Anonymous tables (no `name` attr) appear with `name: null` so callers
    can still discover them. The single-table endpoint below is name-only.
    """
    await ensure_paper_view(datasette, request, doc_id)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id)
    live_doc = instance.materialize_live_doc()
    tables = extract_tables(live_doc)

    return Response.json(
        {
            "doc_id": doc.id,
            "version": instance.version,
            "snapshot_version": instance.snapshot_version,
            "pending_steps": instance.version - instance.snapshot_version,
            "tables": [
                {
                    "name": t["name"],
                    "columns": t["header"] if t["header"] is not None else None,
                    "row_count": len(t["rows"]),
                    "position": t["position"],
                }
                for t in tables
            ],
        }
    )


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)/tables/(?P<name>[^/]+)$")
async def get_table_by_name(datasette, request, doc_id: int, name: str):
    """Return the data for the first table whose `name` attr matches.

    `duplicates` reports how many tables share this name in the doc;
    callers can detect collisions when they expect uniqueness. 404 if
    no table has the name.
    """
    await ensure_paper_view(datasette, request, doc_id)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    name = name.strip()
    if not name:
        return Response.json({"error": "name is required"}, status=400)

    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id)
    live_doc = instance.materialize_live_doc()
    found = find_table_by_name(live_doc, name)
    if found is None:
        return Response.json(
            {"error": f"No table named {name!r} in this document"}, status=404
        )

    return Response.json(
        {
            "doc_id": doc.id,
            "version": instance.version,
            "snapshot_version": instance.snapshot_version,
            "pending_steps": instance.version - instance.snapshot_version,
            "name": found["name"],
            "header": found["header"],
            "rows": found["rows"],
            "position": found["position"],
            "duplicates": count_tables_with_name(live_doc, name),
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
    """Return the share state — owners and editors only."""
    await ensure_paper_edit(datasette, request, doc_id)
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


async def _ensure_owner(datasette, request, doc_id: int):
    """Edit-permission check, then escalate to owner-only.

    Returns the post-fetch ``Doc`` row (so the caller doesn't have to
    refetch). Raises ``Forbidden('datasette-paper-manage')`` for editors
    who aren't the owner — same surface as the share endpoint uses.
    Returns ``None`` (caller should 404) if the doc has been hard-deleted
    between the check and the read.
    """
    await ensure_paper_edit(datasette, request, doc_id)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return None
    me = actor_id(request)
    if doc.created_by is None or doc.created_by != me:
        raise Forbidden("datasette-paper-manage")
    return doc


async def _state_response(datasette, doc_id: int):
    """Refetch the doc and broadcast ``state-changed`` to live subscribers.

    Returns a JSON Response with the post-update state payload. Callers
    invoke this after the DB write commits so the broadcast carries the
    new state. If no Instance is hot for this doc, the broadcast is a
    no-op — subscribers connecting later will pick the state up from the
    bootstrap envelope.
    """
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    payload = _doc_state_payload(doc)
    registry = get_registry(datasette)
    instance = registry._instances.get(doc_id)
    if instance is not None:
        instance.broadcast_state_changed(payload)

    return Response.json({"id": doc.id, **payload})


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/archive$")
async def archive_doc_route(datasette, request, doc_id: int):
    """Hide a paper from the main listing. Owner-only."""
    doc = await _ensure_owner(datasette, request, doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    db = paper_db(datasette)
    await db.archive_doc(doc_id=doc_id)
    return await _state_response(datasette, doc_id)


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/unarchive$")
async def unarchive_doc_route(datasette, request, doc_id: int):
    """Move an archived paper back to active. Owner-only."""
    doc = await _ensure_owner(datasette, request, doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    db = paper_db(datasette)
    await db.unarchive_doc(doc_id=doc_id)
    return await _state_response(datasette, doc_id)


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/trash$")
async def trash_doc_route(datasette, request, doc_id: int):
    """Move a paper to the trash. Owner-only.

    Sets ``delete_at = now + TRASH_RETENTION_DAYS``. The cron sweep
    (``datasette_paper.cron.sweep_trashed``) hard-deletes rows whose
    delete_at has passed; until then the paper is recoverable via
    /restore.
    """
    doc = await _ensure_owner(datasette, request, doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    delete_at = _iso(
        datetime.datetime.now(datetime.timezone.utc)
        + datetime.timedelta(days=TRASH_RETENTION_DAYS)
    )
    db = paper_db(datasette)
    await db.trash_doc(doc_id=doc_id, delete_at=delete_at)
    return await _state_response(datasette, doc_id)


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/restore$")
async def restore_doc_route(datasette, request, doc_id: int):
    """Restore a trashed (or archived) paper to active. Owner-only.

    Single ``restore`` collapses both reverse transitions because
    archive→active and trash→active share the same SQL — there is no
    state-specific cleanup beyond clearing the three timestamps.
    """
    doc = await _ensure_owner(datasette, request, doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    db = paper_db(datasette)
    await db.restore_doc(doc_id=doc_id)
    return await _state_response(datasette, doc_id)


@router.GET(r"^/-/paper/api/template_params$")
async def list_template_params(datasette, request):
    """List built-in placeholder keys + resolved-now sample values.

    Gated by ``datasette-paper-list`` because the response is data-
    free (no per-doc info) and the toolbar fetches it once on
    template load. Sample values let the toolbar render a preview
    next to each key without re-fetching after each placeholder
    insert.
    """
    await ensure_paper_list(datasette, request)
    from ..template_params import builtin_keys, resolve_key

    ctx = build_context(actor_id=actor_id(request))
    return Response.json(
        {
            "builtins": [
                {"key": k, "sample": resolve_key(k, ctx)} for k in builtin_keys()
            ],
        }
    )


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/make_template$")
async def make_template_route(datasette, request, doc_id: int):
    """Promote a doc to a template. Owner-only."""
    doc = await _ensure_owner(datasette, request, doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    db = paper_db(datasette)
    await db.set_doc_kind(doc_id=doc_id, kind="template")
    refreshed = await db.select_doc_by_id(doc_id)
    if refreshed is None:
        return Response.json({"error": "Document not found"}, status=404)
    return Response.json({"id": refreshed.id, "kind": refreshed.kind})


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/unmake_template$")
async def unmake_template_route(datasette, request, doc_id: int):
    """Demote a template back to a regular doc. Owner-only.

    Any existing content (including placeholder nodes if slice 4 has
    landed) stays in place; the doc just loses the template badge and
    can no longer be selected from the "use as template" picker.
    """
    doc = await _ensure_owner(datasette, request, doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    db = paper_db(datasette)
    await db.set_doc_kind(doc_id=doc_id, kind="doc")
    refreshed = await db.select_doc_by_id(doc_id)
    if refreshed is None:
        return Response.json({"error": "Document not found"}, status=404)
    return Response.json({"id": refreshed.id, "kind": refreshed.kind})


async def _lock_response(datasette, doc_id: int):
    """Refetch + broadcast a permissions-changed event after a lock flip.

    Mirrors ``_state_response`` but uses the lock-aware broadcast that
    recomputes ``canEdit`` per subscriber. Returns the post-update
    ``{id, locked, kind}`` JSON for the caller.
    """
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    registry = get_registry(datasette)
    instance = registry._instances.get(doc_id)
    if instance is not None:
        await instance.broadcast_permissions_changed(datasette, bool(doc.locked))

    return Response.json({"id": doc.id, **_doc_flags_payload(doc)})


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/lock$")
async def lock_doc_route(datasette, request, doc_id: int):
    """Mark a paper as read-only. Owner-only.

    Affects only the edit grant — viewers/editors keep their SSE
    connection and receive a ``permissions-changed`` event so the UI
    flips into read-only mode without a reconnect.
    """
    doc = await _ensure_owner(datasette, request, doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    db = paper_db(datasette)
    await db.set_doc_locked(doc_id=doc_id, locked=True)
    return await _lock_response(datasette, doc_id)


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/unlock$")
async def unlock_doc_route(datasette, request, doc_id: int):
    """Clear the read-only flag. Owner-only."""
    doc = await _ensure_owner(datasette, request, doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    db = paper_db(datasette)
    await db.set_doc_locked(doc_id=doc_id, locked=False)
    return await _lock_response(datasette, doc_id)


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/snapshot$")
async def post_snapshot(datasette, request, doc_id: int):
    """Trigger a server-side snapshot at the current version.

    Request body is ignored. Earlier versions of this endpoint accepted
    ``{version, doc}`` from the client, but ``prosemirror-collab``'s
    ``getVersion(state)`` returns the *confirmed* version while
    ``state.doc`` includes locally-dispatched unconfirmed steps — they
    were inconsistent during any in-flight POST /events, which let
    corrupt snapshots land and wedge future hydrates. The server
    materializes its own doc instead.
    """
    await ensure_paper_edit(datasette, request, doc_id)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id)
    materialized = instance.materialize_live_doc()
    if instance._materialization_error is not None:
        bad_version, bad_msg = instance._materialization_error
        return Response.json(
            {"error": f"history poisoned at version {bad_version}: {bad_msg}"},
            status=409,
        )
    await instance.record_client_doc(
        instance.version, json.dumps(materialized), actor_id=actor_id(request)
    )
    return Response.json({"version": instance.snapshot_version})


# ---------------------------------------------------------------------------
# HTML routes
# ---------------------------------------------------------------------------


@router.GET(r"^/-/paper/?$")
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
