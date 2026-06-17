"""Permission model for datasette-paper. See ``docs/PERMISSIONS.md``.

Per-doc access is owned by **datasette-acl**: ``paper-view`` / ``paper-edit``
/ ``paper-manage`` resolve against acl grants on :class:`PaperDocResource`
(type ``paper-doc``). Owner = a Manager grant seeded for ``created_by`` on
create (:func:`seed_owner_manager_grant`); shares/general access are acl
grants written via the share UI / data migration.

The only bespoke permission SQL paper keeps is the read-only ``locked`` flag
(:func:`permission_resources_sql`), which has no acl equivalent.

``datasette-paper-create`` (POST /-/paper/api/docs) stays config-driven via
the standard config-permissions plugin. Listing/reading isn't globally gated:
those endpoints return only the docs ``allowed_resources("paper-view")`` says
the actor can see.
"""

from __future__ import annotations

from datasette import hookimpl
from datasette.permissions import PermissionSQL, Resource

from datasette_acl.grants import grant as _acl_grant, Principal


# Resource type name for the acl-backed model.
PAPER_DOC_RESOURCE_TYPE = "paper-doc"

# Resource-scoped actions (resolved by acl against PaperDocResource grants).
# Canonical constants — import these rather than re-typing the literals.
PAPER_VIEW = "paper-view"
PAPER_EDIT = "paper-edit"
PAPER_MANAGE = "paper-manage"
PAPER_DOC_ACTIONS = (PAPER_VIEW, PAPER_EDIT, PAPER_MANAGE)

# All docs live in one internal database, so the resource ``parent`` is a fixed
# sentinel (not a real db name) and the doc id is the ``child``. Keeping a real
# parent level lets acl model "all paper docs" and target the parent later.
PAPER_DOCS_PARENT = "_paper"


class PaperDocsParent(Resource):
    """Parent level for :class:`PaperDocResource`.

    Exactly one parent, the sentinel :data:`PAPER_DOCS_PARENT`. Exists only to
    give ``PaperDocResource`` the ``parent_class`` Datasette's two-level
    hierarchy requires; not granted on directly today.
    """

    name = "paper-docs-parent"
    parent_class = None

    @classmethod
    async def resources_sql(cls, datasette, actor=None) -> str:
        return f"SELECT '{PAPER_DOCS_PARENT}' AS parent, NULL AS child"


class PaperDocResource(Resource):
    """A single paper doc, acl-backed (resource type ``paper-doc``).

    Two-level: ``parent`` is the sentinel :data:`PAPER_DOCS_PARENT`, ``child``
    is the doc id. The ``paper-*`` actions resolve against this via acl.

    Accepts ``(parent, child)`` positionally for acl's ``build_resource``, but
    callers normally pass just the doc id::

        PaperDocResource(doc_id)              # parent defaults to the sentinel
        PaperDocResource(PAPER_DOCS_PARENT, doc_id)  # explicit (build_resource)
    """

    name = PAPER_DOC_RESOURCE_TYPE
    parent_class = PaperDocsParent

    def __init__(self, parent=None, child=None):
        # 1-arg ``PaperDocResource(doc_id)``: lone positional is the doc id,
        # parent falls back to the sentinel. 2-arg is acl.build_resource's
        # (parent, child) — honoured as-is.
        if child is None and parent is not None:
            parent, child = PAPER_DOCS_PARENT, parent
        elif parent is None:
            parent = PAPER_DOCS_PARENT
        super().__init__(
            parent=str(parent), child=str(child) if child is not None else None
        )

    @classmethod
    async def resources_sql(cls, datasette, actor=None) -> str:
        return (
            f"SELECT '{PAPER_DOCS_PARENT}' AS parent, "
            "CAST(id AS TEXT) AS child FROM _datasette_paper_doc"
        )


@hookimpl
async def permission_resources_sql(datasette, actor, action):
    """Emit the ``locked`` deny for ``paper-edit``; delegate everything else.

    For each locked doc, emit a child-level deny ``(sentinel, doc_id, allow=0)``.
    acl grants land at the same (child) depth and deny beats allow there, so the
    lock wins over any grant. Everything else returns ``None`` (answered by acl
    / the config-permissions plugin). The owner restores edit via /unlock, which
    gates on view (not edit) so the lock can't trap them.
    """
    if action != PAPER_EDIT:
        return None

    return [
        PermissionSQL(
            sql=(
                f"SELECT '{PAPER_DOCS_PARENT}' AS parent, "
                "CAST(id AS TEXT) AS child, "
                "0 AS allow, 'locked' AS reason "
                "FROM _datasette_paper_doc WHERE locked = 1"
            ),
        )
    ]


async def seed_owner_manager_grant(datasette, doc_id, created_by) -> None:
    """Grant the doc creator the Manager role on the new doc (= ownership).

    No-op for anonymous creates (``created_by`` falsy — anon never owns).
    """
    if not created_by:
        return
    await _acl_grant(
        datasette,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        principal=Principal.actor(str(created_by)),
        role="Manager",
        by_actor=str(created_by),
    )


# ---------------------------------------------------------------------------
# Per-action helpers used by route handlers
# ---------------------------------------------------------------------------


async def ensure_paper_create(datasette, request) -> None:
    await datasette.ensure_permission(
        action="datasette-paper-create", actor=request.actor
    )


async def ensure_paper_view(datasette, request, doc_id) -> None:
    await datasette.ensure_permission(
        action=PAPER_VIEW,
        resource=PaperDocResource(doc_id),
        actor=request.actor,
    )


async def ensure_paper_edit(datasette, request, doc_id) -> None:
    await datasette.ensure_permission(
        action=PAPER_EDIT,
        resource=PaperDocResource(doc_id),
        actor=request.actor,
    )


async def can_paper_view(datasette, actor, doc_id) -> bool:
    """Like ensure_paper_view but returns True/False without raising.

    Used by the SSE handler (raw ASGI, no Forbidden middleware) and the
    share/list endpoints, which inspect rather than gate.
    """
    return await datasette.allowed(
        action=PAPER_VIEW,
        resource=PaperDocResource(doc_id),
        actor=actor,
    )


async def can_paper_edit(datasette, actor, doc_id) -> bool:
    """Like ensure_paper_edit but returns True/False without raising.

    Used by the agent tools, which take an ``actor`` (not a request) and
    surface denial as a tool-result error rather than an HTTP Forbidden.
    """
    return await datasette.allowed(
        action=PAPER_EDIT,
        resource=PaperDocResource(doc_id),
        actor=actor,
    )


async def viewable_doc_ids(datasette, actor) -> list[int]:
    """Every doc id ``actor`` can view (drains pagination).

    ``allowed_resources`` is keyset-paginated (default ``limit=100``);
    ``PaginatedResources.all()`` is an async generator that walks every
    page, so we iterate it rather than ``await`` it — a bare ``limit=`` or
    ``.resources`` would silently cap large grant sets. PaperDocResource is
    two-level: the doc id is the resource ``child`` (parent is the fixed
    sentinel).
    """
    page = await datasette.allowed_resources(action="paper-view", actor=actor)
    return [int(r.child) async for r in page.all()]


async def named_viewers(datasette, doc_id) -> tuple[set, bool]:
    """Return (named_actor_ids, has_open_audience) for a doc's paper-view audience.

    Named = explicit actor grants + materialized members of groups that hold
    paper-view. Open audience = a public-audience grant (acl's first-class
    ``everyone`` / ``authenticated`` / ``anonymous`` principals) or a dynamic
    group whose membership is config-driven and not fully enumerable.
    Best-effort authoring aid (06 §#8) — never a security control.
    """
    from datasette_acl.grants import list_grants

    grants = await list_grants(
        datasette, PAPER_DOC_RESOURCE_TYPE, PAPER_DOCS_PARENT, str(doc_id)
    )
    acl_config = datasette.plugin_config("datasette-acl") or {}
    dynamic_group_names = set((acl_config.get("dynamic-groups") or {}).keys())

    named: set = set()
    open_audience = False
    db = datasette.get_internal_database()
    for g in grants:
        if "paper-view" not in g["actions"]:
            continue
        if g["principal"] == "actor":
            if g["actor_id"] is not None:
                named.add(g["actor_id"])
        elif g["principal"] == "group":
            # Dynamic groups: membership computed from allow-blocks, only
            # materialized for already-seen actors → treat as open audience.
            if g["group_name"] in dynamic_group_names:
                open_audience = True
            # Expand the known (materialized) members either way.
            rows = await db.execute(
                "SELECT actor_id FROM acl_actor_groups WHERE group_id = ?",
                [g["group_id"]],
            )
            for r in rows.rows:
                named.add(r["actor_id"])
        else:
            # Public audience (everyone / authenticated / anonymous): the
            # paper-view set is not enumerable as named actors.
            open_audience = True
    return named, open_audience


async def can_paper_manage(datasette, actor, doc_id) -> bool:
    """True when ``actor`` may manage sharing for ``doc_id``.

    Manager-only capability; the owner gets it via the seeded Manager grant.
    """
    return await datasette.allowed(
        action=PAPER_MANAGE,
        resource=PaperDocResource(doc_id),
        actor=actor,
    )
