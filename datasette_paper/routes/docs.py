"""Route handlers for datasette-paper document API and HTML pages."""

import datetime
import json
from typing import Annotated

from datasette import Forbidden, Response
from datasette_plugin_router import Body

from ..router import router
from ..embed_providers import make_resource_resolver, provider_manifest
from ..errors import InvalidStepError
from ..instance import get_registry
from ..markdown import doc_to_markdown, extract_tasks, group_tasks_by_section
from ..markdown_parser import markdown_to_doc, markdown_to_fragment
from ..tables import count_tables_with_name, extract_tables, find_table_by_name
from ..permissions import (
    PAPER_DOCS_PARENT,
    PAPER_VIEW,
    PAPER_EDIT,
    PAPER_MANAGE,
    PaperDocResource,
    can_paper_manage,
    ensure_paper_create,
    ensure_paper_edit,
    ensure_paper_view,
    named_viewers,
    seed_owner_manager_grant,
    viewable_doc_ids,
)
from ..schemas import (
    AppendDocBody,
    CreateDocBody,
    IdsBody,
    RenameDocBody,
    ReplaceDocTagsBody,
    TagBody,
)
from ..template_params import build_context, substitute_placeholders
from ..util import (
    actor_id,
    normalize_tag,
    paper_db,
    resolve_actor_profiles,
)


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
    # No global gate — the results are acl-filtered below, so an actor with no
    # grants simply gets an empty list. ``state`` filters the listing only — it
    # isn't a permission concern.
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

    # Optional ?tag=foo&tag=bar filter — AND/intersection over normalized
    # tags. Invalid/blank tags are dropped (a filter, not a mutation); an
    # all-dropped set behaves like no filter. Deduped so the SQL count match
    # is exact.
    tags = []
    for raw in request.args.getlist("tag"):
        t = normalize_tag(raw)
        if t and t not in tags:
            tags.append(t)

    # Pull every paper the actor can view in one shot (cap at 1000; if
    # somebody has 1000+ papers visible we'll add proper pagination).
    page = await datasette.allowed_resources(
        action=PAPER_VIEW, actor=request.actor, limit=1000
    )
    # PaperDocResource is two-level — the doc id lives in `child`
    # (parent is the fixed PAPER_DOCS_PARENT sentinel).
    doc_ids = [int(r.child) for r in page.resources]
    db = paper_db(datasette)
    if tags:
        rows = await db.list_docs_by_ids_states_kinds_and_tags(
            doc_ids=doc_ids, states=[state], kinds=kinds, tags=tags
        )
    else:
        rows = await db.list_docs_by_ids_states_and_kinds(
            doc_ids=doc_ids, states=[state], kinds=kinds
        )
    actor = request.actor
    me = actor.get("id") if actor else None
    # Resolve creator ids to display name + avatar in one batched call (via
    # datasette-user-profiles, then the core actors_from_ids hook). Falls back
    # to the id as the name when no profile source is installed; both fields are
    # None for anonymous-created docs (created_by is None).
    #
    # Name + avatar are profile data, so the lookup is gated on user-profiles'
    # `profile_access` action — mirrors the resolve_actors gate from #11. The
    # rows are already acl-filtered to docs this actor can view, so a denied
    # actor still learns nothing new: created_by_name just degrades to the raw
    # id (already in the payload) and created_by_avatar to None.
    may_resolve = await datasette.allowed(action="profile_access", actor=request.actor)
    profiles = (
        await resolve_actor_profiles(datasette, (r.created_by for r in rows))
        if may_resolve
        else {}
    )
    # Tags for every returned doc in one query (chips on the list page).
    tags_by_doc = await db.list_tags_for_docs(doc_ids=[r.id for r in rows])
    return Response.json(
        [
            {
                "id": r.id,
                "name": r.name,
                "current_version": r.current_version,
                "updated_at": r.updated_at,
                "created_by": r.created_by,
                "created_by_name": (
                    (profiles.get(r.created_by) or {}).get("name") or r.created_by
                    if r.created_by
                    else None
                ),
                "created_by_avatar": (
                    (profiles.get(r.created_by) or {}).get("avatar_url")
                    if r.created_by
                    else None
                ),
                "is_owner": r.created_by is not None and r.created_by == me,
                "tags": tags_by_doc.get(r.id, []),
                **_doc_state_payload(r),
                **_doc_flags_payload(r),
            }
            for r in rows
        ]
    )


@router.GET(r"^/-/paper/api/link-search$")
async def link_search(datasette, request):
    # Ungated — results are restricted to viewable_doc_ids (acl-filtered) below.
    q = (request.args.get("q") or "").strip()
    try:
        limit = min(int(request.args.get("limit") or 20), 50)
    except ValueError:
        limit = 20
    doc_ids = await viewable_doc_ids(datasette, request.actor)
    if not doc_ids:
        return Response.json({"results": []})
    db = paper_db(datasette)
    rows = await db.search_docs_by_title(doc_ids=doc_ids, q=q, limit=limit)
    return Response.json(
        {
            "results": [
                {"id": r.id, "name": r.name, "state": r.state, "kind": r.kind}
                for r in rows
            ]
        }
    )


async def _resolve_map(datasette, actor, ids):
    """Resolve a list of doc ids to per-id {status, ...} (the link-resolve
    contract, 08 Q4). denied/not_found carry no title — they must not leak the
    existence/name of papers the actor can't see. Shared by POST /links/resolve
    and the forward/backlink endpoints."""
    viewable = set(await viewable_doc_ids(datasette, actor))
    db = paper_db(datasette)
    rows = {r.id: r for r in await db.list_docs_by_ids(doc_ids=ids)}
    out = {}
    for i in ids:
        row = rows.get(i)
        if row is None:
            out[i] = {"status": "not_found"}
        elif i not in viewable:
            out[i] = {"status": "denied"}
        else:
            out[i] = {
                "status": "ok",
                "title": row.name,
                "state": row.state,
                "kind": row.kind,
                "href": f"/-/paper/doc/{i}",
            }
    return out


@router.POST(r"^/-/paper/api/links/resolve$")
async def resolve_links(datasette, request, body: Annotated[IdsBody, Body()]):
    # Ungated — non-viewable ids resolve to {"status": "denied"} (acl-filtered).
    ids = []
    for i in body.ids[:200]:
        try:
            ids.append(int(i))
        except (TypeError, ValueError):
            continue
    out = await _resolve_map(datasette, request.actor, ids)
    return Response.json({"links": out})


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)/mention-search$")
async def mention_search(datasette, request, doc_id: int):
    # View-gated: only people who can see the doc may list its viewers.
    await ensure_paper_view(datasette, request, doc_id)
    q = (request.args.get("q") or "").strip().lower()
    try:
        limit = min(int(request.args.get("limit") or 20), 50)
    except ValueError:
        limit = 20
    named, open_audience = await named_viewers(datasette, doc_id)
    # Name + avatar are profile data, gated on `profile_access` like the
    # resolve_actors / list_docs siblings. Without it, degrade to id-as-name
    # rather than 403 — the loop's `prof.get("name") or aid` fallback handles it.
    may_resolve = await datasette.allowed(action="profile_access", actor=request.actor)
    profiles = await resolve_actor_profiles(datasette, named) if may_resolve else {}
    results = []
    for aid in named:
        prof = profiles.get(aid) or {}
        name = prof.get("name") or aid
        if q and q not in name.lower() and q not in aid.lower():
            continue
        results.append({"id": aid, "name": name, "avatar_url": prof.get("avatar_url")})
    # Stable, useful ordering: prefix matches first, then by name.
    results.sort(key=lambda r: (not r["name"].lower().startswith(q), r["name"].lower()))
    return Response.json({"results": results[:limit], "open_audience": open_audience})


@router.POST(r"^/-/paper/api/actors/resolve$")
async def resolve_actors(datasette, request, body: Annotated[IdsBody, Body()]):
    # Name + avatar are profile data, so the lookup is gated on
    # user-profiles' `profile_access` action. Rather than 403 (which wedges
    # mention chips on "loading"), we degrade like resolve_links: without it,
    # each id echoes back as its own name — the caller already supplied it.
    ids = [str(i) for i in body.ids[:200] if i]
    may_resolve = await datasette.allowed(action="profile_access", actor=request.actor)
    profiles = await resolve_actor_profiles(datasette, ids) if may_resolve else {}
    out = {}
    for aid in ids:
        prof = profiles.get(aid) or {}
        out[aid] = {
            "name": prof.get("name") or aid,
            "avatar_url": prof.get("avatar_url"),
        }
    return Response.json({"actors": out})


# ---------------------------------------------------------------------------
# Document tags
#
# Manual document-level metadata, distinct from inline #tag nodes in the body
# (separate namespace, no auto-rollup). Mutations are manage-gated like
# archive/lock/template (via _ensure_owner); reading a doc's tags is
# view-gated; the vocabulary endpoint is ungated but ACL-filtered.
# ---------------------------------------------------------------------------


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)/tags$")
async def list_doc_tags(datasette, request, doc_id: int):
    """List a document's tags. Requires ``paper-view`` on the doc.

    → 200 ``{"tags": [...]}`` (sorted); 403 if the actor can't view it.
    """
    await ensure_paper_view(datasette, request, doc_id)
    db = paper_db(datasette)
    return Response.json({"tags": await db.list_tags_for_doc(doc_id=doc_id)})


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/tags/add$")
async def add_doc_tag(
    datasette, request, doc_id: int, body: Annotated[TagBody, Body()]
):
    """Add one tag to a document. Manager-only (``paper-manage``).

    Body ``{"tag": "..."}``; the tag is normalized and a duplicate is a
    no-op. → 200 ``{"tags": [...]}`` (the doc's full list); 400 invalid/
    empty tag; 403 for non-managers; 404 if the doc was deleted.
    """
    doc = await _ensure_owner(datasette, request, doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    tag = normalize_tag(body.tag)
    if tag is None:
        return Response.json({"error": "invalid tag"}, status=400)
    db = paper_db(datasette)
    await db.add_doc_tag(doc_id=doc_id, tag=tag)
    return Response.json({"tags": await db.list_tags_for_doc(doc_id=doc_id)})


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/tags/remove$")
async def remove_doc_tag(
    datasette, request, doc_id: int, body: Annotated[TagBody, Body()]
):
    """Remove one tag from a document. Manager-only (``paper-manage``).

    Body ``{"tag": "..."}``. → 200 ``{"tags": [...]}``; 400 invalid tag;
    403 for non-managers; 404 if the doc was deleted. Removing an absent
    tag is a no-op 200.
    """
    doc = await _ensure_owner(datasette, request, doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    # Normalize so a client sending the display form removes the stored row.
    tag = normalize_tag(body.tag)
    if tag is None:
        return Response.json({"error": "invalid tag"}, status=400)
    db = paper_db(datasette)
    await db.remove_doc_tag(doc_id=doc_id, tag=tag)
    return Response.json({"tags": await db.list_tags_for_doc(doc_id=doc_id)})


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/tags/replace$")
async def replace_doc_tags(
    datasette, request, doc_id: int, body: Annotated[ReplaceDocTagsBody, Body()]
):
    """Replace a document's entire tag set. Manager-only (``paper-manage``).

    Body ``{"tags": [...]}`` — normalized, deduped (order preserved),
    invalid entries dropped; an empty list clears all tags. → 200
    ``{"tags": [...]}``; 403 for non-managers; 404 if the doc was deleted.
    """
    doc = await _ensure_owner(datasette, request, doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)
    # Normalize + dedupe (preserve order); silently drop invalid entries.
    tags = []
    for r in body.tags:
        t = normalize_tag(r)
        if t and t not in tags:
            tags.append(t)
    db = paper_db(datasette)
    await db.set_doc_tags(doc_id=doc_id, tags=tags)
    return Response.json({"tags": await db.list_tags_for_doc(doc_id=doc_id)})


@router.GET(r"^/-/paper/api/tags$")
async def list_tags(datasette, request):
    """Tag vocabulary (distinct tags + doc counts) for autocomplete/filter.

    Ungated but ACL-filtered: scoped to the docs the actor can view, so a
    tag only on docs they can't see never appears. → 200 ``{"tags":
    [{"tag", "count"}, ...]}`` ordered by count desc then tag.
    """
    doc_ids = await viewable_doc_ids(datasette, request.actor)
    if not doc_ids:
        return Response.json({"tags": []})
    db = paper_db(datasette)
    rows = await db.list_all_tags(doc_ids=doc_ids)
    return Response.json({"tags": [{"tag": t, "count": n} for t, n in rows]})


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)/links$")
async def forward_links(datasette, request, doc_id: int):
    await ensure_paper_view(datasette, request, doc_id)
    db = paper_db(datasette)
    edges = await db.links_by_src(src_doc_id=doc_id)
    resolved = await _resolve_map(
        datasette, request.actor, [e.dst_doc_id for e in edges]
    )
    return Response.json(
        {
            "links": [
                {
                    "id": e.dst_doc_id,
                    "occurrences": e.occurrences,
                    **resolved[e.dst_doc_id],
                }
                for e in edges
            ]
        }
    )


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)/backlinks$")
async def backlinks(datasette, request, doc_id: int):
    await ensure_paper_view(datasette, request, doc_id)
    viewable = await viewable_doc_ids(datasette, request.actor)
    db = paper_db(datasette)
    edges = await db.backlinks_by_dst(dst_doc_id=doc_id, viewable_ids=viewable)
    resolved = await _resolve_map(
        datasette, request.actor, [e.src_doc_id for e in edges]
    )
    return Response.json(
        {
            "backlinks": [
                {
                    "id": e.src_doc_id,
                    "occurrences": e.occurrences,
                    **resolved[e.src_doc_id],
                }
                for e in edges
            ]
        }
    )


@router.GET(r"^/-/paper/api/docs/(?P<doc_id>\d+)/link-access-check$")
async def link_access_check(datasette, request, doc_id: int):
    """Per outgoing link, which named collaborators of this doc can't view the
    target (best-effort authoring aid, 06 §#8 — never a security control).

    Edit-gated: only editors of the source doc care. Response ``links`` keys
    are STRING dst doc ids. ``open_audience`` is True when the source doc's
    paper-view audience can't be fully enumerated (wildcard grant or dynamic
    group).
    """
    await ensure_paper_edit(datasette, request, doc_id)
    named, open_audience = await named_viewers(datasette, doc_id)
    # One viewable-set enumeration per named collaborator (C), then membership
    # tests — not L×C permission checks.
    per_actor = {a: set(await viewable_doc_ids(datasette, {"id": a})) for a in named}
    db = paper_db(datasette)
    edges = await db.links_by_src(src_doc_id=doc_id)
    out = {}
    for e in edges:
        missing = sorted(a for a, v in per_actor.items() if e.dst_doc_id not in v)
        out[str(e.dst_doc_id)] = {
            "gap": bool(missing),
            "missing": missing,
            "open_audience": open_audience,
        }
    return Response.json({"links": out})


@router.GET(r"^/-/paper/api/links/graph$")
async def links_graph(datasette, request):
    # Ungated — the graph is built only from viewable_doc_ids (acl-filtered).
    viewable = await viewable_doc_ids(datasette, request.actor)
    db = paper_db(datasette)
    edges = await db.edges_within(viewable_ids=viewable)
    node_ids = sorted({e.src_doc_id for e in edges} | {e.dst_doc_id for e in edges})
    rows = {r.id: r for r in await db.list_docs_by_ids(doc_ids=node_ids)}
    return Response.json(
        {
            "nodes": [
                {"id": i, "title": rows[i].name, "state": rows[i].state}
                for i in node_ids
                if i in rows
            ],
            "edges": [
                {
                    "source": e.src_doc_id,
                    "target": e.dst_doc_id,
                    "occurrences": e.occurrences,
                }
                for e in edges
            ],
        }
    )


@router.GET(r"^/-/paper/api/tags/(?P<tag>[^/]+)/refs$")
async def tag_refs(datasette, request, tag: str):
    """Docs whose body contains the inline ``#tag`` ``tag``, ACL-filtered.

    Ungated but scoped to ``allowed_resources("paper-view")`` like the list /
    backlinks endpoints, so a non-viewer's doc is never disclosed. Inline tags
    are a SEPARATE namespace from the doc-level ``?tag=`` filter and the
    ``_datasette_paper_doc_tag`` table — this reflects the document body.

    Backed by the derived ``_datasette_paper_inline_tag`` index (migration
    m007), maintained by the write-tail reindex: an exact, indexed JOIN, no
    ``step_json`` scan and no per-candidate re-materialization.

    → 200 ``{"tag": slug, "docs": [{id, name, state, kind, occurrences,
    updated_at}]}`` ordered by ``updated_at`` DESC; 400 if the slug normalizes
    to None.
    """
    slug = normalize_tag(tag)
    if slug is None:
        return Response.json({"error": "invalid tag"}, status=400)

    viewable = await viewable_doc_ids(datasette, request.actor)
    db = paper_db(datasette)
    refs = await db.tag_refs(tag=slug, viewable_ids=viewable)
    docs = [
        {
            "id": ref.id,
            "name": ref.name,
            "state": ref.state,
            "kind": ref.kind,
            "occurrences": ref.occurrences,
            "updated_at": ref.updated_at,
        }
        for ref in refs
    ]
    return Response.json({"tag": slug, "docs": docs})


@router.POST(r"^/-/paper/api/docs$")
async def create_doc(datasette, request, body: Annotated[CreateDocBody, Body()]):
    await ensure_paper_create(datasette, request)
    db = paper_db(datasette)
    name = body.name
    template_id_raw = body.template_id
    # Templates always materialize into a new ``kind='doc'`` row — you
    # use a template, you don't become one. To create a brand-new
    # template, the client sends ``{"kind": "template"}`` with no
    # template_id (and writes content via the editor afterwards).
    kind = body.kind
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

    # ``content`` seeds the new doc from markdown (parsed to the initial
    # version-0 snapshot). It's an alternative seed source to ``template_id``
    # — supplying both is ambiguous. Unlike template_id, content works for
    # either kind, so you can seed a brand-new template from markdown too.
    content = body.content
    if content is not None:
        if template_id_raw is not None:
            return Response.json(
                {"error": "provide either template_id or content, not both"},
                status=400,
            )
        if not isinstance(content, str):
            return Response.json({"error": "content must be a string"}, status=400)
        content_type = (body.content_type or "markdown").lower()
        if content_type != "markdown":
            return Response.json(
                {"error": "content_type must be 'markdown'"}, status=400
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
    elif content is not None:
        # markdown_to_doc always returns a schema-valid doc (an empty/
        # whitespace body becomes a single blank paragraph), so we store it
        # as the version-0 snapshot the same way template instantiation does.
        doc_json = markdown_to_doc(content)
        doc = await db.insert_doc_with_snapshot(
            name=name,
            created_by=actor_id(request),
            kind=kind,
            snapshot_doc_json=json.dumps(doc_json),
            snapshot_actor_id=actor_id(request),
        )
    else:
        doc = await db.insert_doc(
            name=name,
            created_by=actor_id(request),
            kind=kind,
        )
    # Seed the owner's acl Manager grant so the creator can view/edit/manage
    # their new doc. No-op for anonymous creates (created_by is None).
    await seed_owner_manager_grant(datasette, doc.id, doc.created_by)
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
        action=PAPER_EDIT,
        resource=PaperDocResource(doc_id),
        actor=request.actor,
    )
    can_manage = await can_paper_manage(datasette, request.actor, doc_id)

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
                "canManage": can_manage,
                "isOwner": is_owner,
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
    # Resolve real resource URLs (and embed provider kinds) for inline refs;
    # the canonical paper:/ ref is kept in each link's title for lossless
    # round-trips. Request in scope → absolute URLs for external renderers.
    md = doc_to_markdown(
        live_doc, resource_url=make_resource_resolver(datasette, request)
    )

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
async def rename_doc(
    datasette, request, doc_id: int, body: Annotated[RenameDocBody, Body()]
):
    await ensure_paper_edit(datasette, request, doc_id)
    db = paper_db(datasette)
    new_name = (body.name or "").strip()
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


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/append$")
async def append_doc(
    datasette, request, doc_id: int, body: Annotated[AppendDocBody, Body()]
):
    """Append markdown content to the end of a doc as a single collab step.

    Body: ``{"content": "<markdown>", "content_type": "markdown"}``
    (``content_type`` is optional and currently only ``markdown``).

    The content is parsed to a ProseMirror fragment and inserted at
    end-of-doc via ``Instance.append_fragment`` — the same persist +
    broadcast pipeline as a collab edit, so any live editors see the new
    blocks appear over SSE without a reconnect. ``edit`` permission is
    required, so the lock + share model apply automatically.
    """
    await ensure_paper_edit(datasette, request, doc_id)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    content = body.content
    if not isinstance(content, str):
        return Response.json({"error": "content (string) is required"}, status=400)
    content_type = (body.content_type or "markdown").lower()
    if content_type != "markdown":
        return Response.json({"error": "content_type must be 'markdown'"}, status=400)

    registry = get_registry(datasette)
    instance = await registry.get(db, doc_id)

    fragment = markdown_to_fragment(content)
    if not fragment:
        # Empty / whitespace-only markdown — nothing to append. Report the
        # current version so callers don't treat it as an error.
        return Response.json({"version": instance.version, "appended_blocks": 0})

    try:
        new_version = await instance.append_fragment(
            fragment, actor_id=actor_id(request)
        )
    except InvalidStepError as exc:
        return Response.json(
            {"error": "invalid_content", "message": exc.message}, status=422
        )
    return Response.json({"version": new_version, "appended_blocks": len(fragment)})


@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/sweep-subscribers$")
async def sweep_subscribers(datasette, request, doc_id: int):
    """Disconnect any open SSE subscribers whose access was just revoked.

    Sharing itself is now owned by datasette-acl: the ``<datasette-acl-share-dialog>``
    component grants / updates / revokes acl grants directly against the acl
    JSON API. paper no longer stores share state. But a revoke can't reach into
    paper's in-memory ``Instance`` to drop a live editor's SSE queue, so the
    dialog fires a ``share-changed`` event (after any grant/update/revoke) and
    the frontend calls this endpoint to run the revocation sweep
    (``Instance.revoke_unauthorized``), which re-checks ``paper-view`` per
    subscriber and closes the queues that now fail.

    Manager-only — gated on ``paper-manage`` (the actor must be able to manage
    sharing to trigger a sweep). View-gated first so probing a doc id the actor
    can't see returns the standard 403 surface.
    """
    await ensure_paper_view(datasette, request, doc_id)
    if not await can_paper_manage(datasette, request.actor, doc_id):
        raise Forbidden(PAPER_MANAGE)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return Response.json({"error": "Document not found"}, status=404)

    revoked = 0
    registry = get_registry(datasette)
    instance = registry._instances.get(doc_id)
    if instance is not None:
        revoked = await instance.revoke_unauthorized(datasette)
    return Response.json({"revoked": revoked})


async def _ensure_owner(datasette, request, doc_id: int):
    """View-permission check, then escalate to manage-only.

    Used by every owner-only manage route (archive / trash / restore /
    lock / unlock / make_template / unmake_template). The gate is
    deliberately ``view``, not ``edit``: a locked doc denies edit to
    everyone including the owner, and gating manage on edit would
    trap an owner with no way to unlock their own paper. The
    ``paper-manage`` check (the owner's seeded Manager grant) is what
    actually enforces ownership — the view pre-check just standardises
    the 403 surface and keeps random doc-id probing from disclosing
    existence.

    Returns the post-fetch ``Doc`` row (so the caller doesn't have to
    refetch). Raises ``Forbidden('paper-manage')`` for non-managers.
    Returns ``None`` (caller should 404) if the doc has been
    hard-deleted between the check and the read.
    """
    await ensure_paper_view(datasette, request, doc_id)
    if not await can_paper_manage(datasette, request.actor, doc_id):
        raise Forbidden(PAPER_MANAGE)
    db = paper_db(datasette)
    doc = await db.select_doc_by_id(doc_id)
    if doc is None:
        return None
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

    Ungated: the response is data-free (no per-doc info) — just the built-in
    placeholder keys and resolved-now sample values the toolbar renders as a
    preview. The toolbar fetches it once on template load.
    """
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
    # Ungated shell; the client fetches /api/docs, which is acl-filtered.
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


@router.GET(r"^/-/paper/tag/(?P<tag>[^/]+)$")
async def paper_tag_page(datasette, request, tag: str):
    """Inline-tag search results page for ``#tag``.

    Ungated shell; the client fetches ``/api/tags/{slug}/refs``, which is
    acl-filtered. ``tag`` is normalized for the title/page_data so the slug the
    page queries matches what the chip click navigated to. A slug that
    normalizes to None still renders the page (the refs API returns 400, which
    the client surfaces as an empty/error state)."""
    slug = normalize_tag(tag) or tag
    return Response.html(
        await datasette.render_template(
            "paper_base.html",
            {
                "page_title": f"#{slug}",
                "entrypoint": "src/pages/tag/main.ts",
                "page_data": {"tag": slug},
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
    # Seed the page with the bits <datasette-acl-share-dialog> needs: the acl
    # resource identity (parent/child) and the current actor (so the dialog
    # can mark "(you)"). The dialog talks to the acl JSON API directly; under
    # datasette 1.0a30 same-origin writes need no CSRF token, so we don't
    # thread one through.
    me = actor_id(request)
    return Response.html(
        await datasette.render_template(
            "paper_base.html",
            {
                "page_title": doc.name or f"Paper {doc_id}",
                "body_class": "paper-fullscreen",
                "entrypoint": "src/pages/doc/main.ts",
                "page_data": {
                    "doc_id": doc_id,
                    "share_parent": PAPER_DOCS_PARENT,
                    "actor": {"id": me} if me else None,
                    # Lazy-load manifest for third-party embed providers — the
                    # editor injects a provider's bundle only when the doc uses
                    # it (see embed_providers.py / embedProviders.ts).
                    "embed_providers": provider_manifest(datasette),
                },
            },
            request=request,
        )
    )
