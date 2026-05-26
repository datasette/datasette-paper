"""Permission model for datasette-paper.

Per-document access is answered by **datasette-acl**: the
``paper-view`` / ``paper-edit`` / ``paper-manage`` actions resolve against
acl grants on the :class:`PaperDocResource` resource (type ``paper-doc``).
Paper no longer ships owner/shared/visibility permission SQL — owner
semantics come from a Manager grant seeded for ``created_by`` on create
(see :func:`seed_owner_manager_grant`); shares and general access are acl
grants written through the share UI / data migration.

The one piece of bespoke permission SQL paper keeps is the ``locked``
read-only flag (:func:`permission_resources_sql`): when a doc has
``locked = 1`` it emits a child-level **deny** for ``paper-edit``. Deny
beats allow at the same depth in core's rule resolver, so the lock
composes over any acl grant (owner, editor, or general access). View is
unaffected; the owner restores edit via the dedicated /unlock route,
which gates on view (+ an inline owner check) rather than edit, so the
lock can never trap them.

Two global actions remain config-driven (handled by Datasette's standard
config-permissions plugin from the ``permissions:`` block):

    - ``datasette-paper-list``    — see the index page + list endpoint
    - ``datasette-paper-create``  — POST /-/paper/api/docs
"""

from __future__ import annotations

from datasette import hookimpl
from datasette.permissions import PermissionSQL, Resource

try:  # acl is a soft dependency — the roles hook + grant seeding no-op when absent.
    from datasette_acl.roles import AclRole
except ImportError:  # pragma: no cover
    AclRole = None

try:
    from datasette_acl.grants import grant as _acl_grant
except ImportError:  # pragma: no cover
    _acl_grant = None


# Resource type name for the acl-backed model.
PAPER_DOC_RESOURCE_TYPE = "paper-doc"

# Resource-scoped actions, resolved by datasette-acl against grants on
# PaperDocResource.
PAPER_DOC_ACTIONS = (
    "paper-view",
    "paper-edit",
    "paper-manage",
)

# Papers all live in a single internal database, so the resource hierarchy's
# ``parent`` is a fixed sentinel rather than a real database name. The doc id
# is the ``child``. Keeping a real parent level (vs. a flat parent-only
# resource) lets acl model "all paper docs" with a single parent row and means
# general-access grants can later target the parent if desired.
PAPER_DOCS_PARENT = "_paper"


class PaperDocsParent(Resource):
    """Parent level for :class:`PaperDocResource`.

    All paper docs live in a single internal database, so there is exactly one
    parent: the fixed sentinel :data:`PAPER_DOCS_PARENT`. This class exists only
    to give ``PaperDocResource`` a ``parent_class`` (Datasette requires the
    two-level hierarchy be expressed via ``parent_class``); it is not granted on
    directly today.
    """

    name = "paper-docs-parent"
    parent_class = None

    @classmethod
    async def resources_sql(cls, datasette, actor=None) -> str:
        return f"SELECT '{PAPER_DOCS_PARENT}' AS parent, NULL AS child"


class PaperDocResource(Resource):
    """A single paper doc, acl-backed (resource type ``paper-doc``).

    Two-level resource: ``parent`` is the fixed sentinel
    :data:`PAPER_DOCS_PARENT`, ``child`` is the doc id. This is the model the
    ``paper-view`` / ``paper-edit`` / ``paper-manage`` actions resolve against
    via datasette-acl's ``permission_resources_sql`` and grant helpers.

    The constructor accepts ``(parent, child)`` positionally to satisfy acl's
    ``build_resource`` convention, but callers normally pass just the doc id::

        PaperDocResource(doc_id)              # parent defaults to the sentinel
        PaperDocResource(PAPER_DOCS_PARENT, doc_id)  # explicit (build_resource)
    """

    name = PAPER_DOC_RESOURCE_TYPE
    parent_class = PaperDocsParent

    def __init__(self, parent=None, child=None):
        # Single-arg call ``PaperDocResource(doc_id)`` is the common path: the
        # lone positional is the doc id, parent falls back to the sentinel.
        # Two-arg ``PaperDocResource(parent, child)`` is what acl.build_resource
        # uses (parent, child) — honoured as-is.
        if child is None and parent is not None:
            parent, child = PAPER_DOCS_PARENT, parent
        elif parent is None:
            parent = PAPER_DOCS_PARENT
        super().__init__(parent=str(parent), child=str(child) if child is not None else None)

    @classmethod
    async def resources_sql(cls, datasette, actor=None) -> str:
        return (
            f"SELECT '{PAPER_DOCS_PARENT}' AS parent, "
            "CAST(id AS TEXT) AS child FROM _datasette_paper_doc"
        )


@hookimpl
async def permission_resources_sql(datasette, actor, action):
    """Emit the ``locked`` deny for ``paper-edit``; delegate everything else.

    The only rule paper still owns is the read-only ``locked`` flag, which has
    no acl equivalent. For every locked doc we emit a **child-level deny** of
    ``paper-edit``: ``(parent=sentinel, child=doc_id, allow=0)``. acl grants
    land at the same (child) depth, and deny beats allow at the same depth, so
    the lock wins over any owner / editor / general-access grant. View grants
    and the two global actions are untouched (we return ``None`` for them, so
    acl and the config-permissions plugin answer them).
    """
    if action != "paper-edit":
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
    """Grant the doc creator the Manager role on the new doc.

    Replaces the old ``created_by``-based owner SQL: ownership is now an acl
    Manager grant on the ``paper-doc`` resource. No-op for anonymous creates
    (``created_by`` falsy — anonymous actors never own) and when acl isn't
    installed.
    """
    if not created_by or _acl_grant is None:
        return
    await _acl_grant(
        datasette,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(doc_id),
        actor_id=str(created_by),
        role="Manager",
        by_actor=str(created_by),
    )


# ---------------------------------------------------------------------------
# Per-action helpers used by route handlers
# ---------------------------------------------------------------------------


async def ensure_paper_list(datasette, request) -> None:
    await datasette.ensure_permission(
        action="datasette-paper-list", actor=request.actor
    )


async def ensure_paper_create(datasette, request) -> None:
    await datasette.ensure_permission(
        action="datasette-paper-create", actor=request.actor
    )


async def ensure_paper_view(datasette, request, doc_id) -> None:
    await datasette.ensure_permission(
        action="paper-view",
        resource=PaperDocResource(doc_id),
        actor=request.actor,
    )


async def ensure_paper_edit(datasette, request, doc_id) -> None:
    await datasette.ensure_permission(
        action="paper-edit",
        resource=PaperDocResource(doc_id),
        actor=request.actor,
    )


async def can_paper_view(datasette, actor, doc_id) -> bool:
    """Like ensure_paper_view but returns True/False without raising.

    Used by the SSE handler (raw ASGI — no Forbidden middleware) and by
    the share/list endpoints where we need to inspect rather than gate.
    """
    return await datasette.allowed(
        action="paper-view",
        resource=PaperDocResource(doc_id),
        actor=actor,
    )


async def can_paper_edit(datasette, actor, doc_id) -> bool:
    """Like ensure_paper_edit but returns True/False without raising.

    Used by the agent tools, which receive an ``actor`` (not a request) and
    surface denial as a tool-result error rather than an HTTP Forbidden.
    """
    return await datasette.allowed(
        action="paper-edit",
        resource=PaperDocResource(doc_id),
        actor=actor,
    )


async def can_paper_manage(datasette, actor, doc_id) -> bool:
    """True when ``actor`` may manage sharing for ``doc_id``.

    Manage is the acl Manager-only capability (the owner gets it via the
    seeded Manager grant). Used by the share endpoints in place of the old
    inline ``created_by``-equality owner check.
    """
    return await datasette.allowed(
        action="paper-manage",
        resource=PaperDocResource(doc_id),
        actor=actor,
    )
