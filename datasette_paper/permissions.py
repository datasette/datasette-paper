"""Permission model for datasette-paper.

Four actions:

    - ``datasette-paper-list``    (global)         — see the index page + list endpoint
    - ``datasette-paper-create``  (global)         — POST /-/paper/api/docs
    - ``datasette-paper-view``    (PaperResource)    — read a specific paper
    - ``datasette-paper-edit``    (PaperResource)    — modify a specific paper

The two paper-level actions are gated by :func:`permission_resources_sql`,
which returns SQL run against Datasette's internal database (where papers
live). The hook emits three rule sets:

    1. Owner — actor's id matches ``_datasette_paper_doc.created_by``.
    2. Shared — actor has a row in ``_datasette_paper_share`` for this doc.
       Filtered by ``role='editor'`` for the edit action.
    3. Visibility — when the actor passes ``datasette-paper-list``,
       ``visibility = 'link-view'`` grants view, ``'link-edit'`` grants both.

Manage (visibility flips, share mutations) is owner-only and enforced
inline in the share route handler.

Anonymous actors (``actor=None``) never own anything: the SQL guard
``:_paper_aid IS NOT NULL`` keeps NULL=NULL from being interpreted as a
match.
"""

from __future__ import annotations

from datasette import hookimpl
from datasette.permissions import PermissionSQL, Resource


ACTIONS = (
    "datasette-paper-list",
    "datasette-paper-create",
    "datasette-paper-view",
    "datasette-paper-edit",
)


class PaperResource(Resource):
    """A single paper. Single-level resource: doc_id lives in ``parent``.

    Datasette's resource hierarchy treats the *outermost* identifier as
    ``parent`` and the *inner* one as ``child``. ``DatabaseResource``
    follows the same convention (database name in ``parent``,
    ``child=None``). Putting the id in ``child`` instead breaks the
    permission-rule join at ``child_lvl`` because SQLite's
    ``NULL = NULL`` is NULL, not true.
    """

    name = "paper"
    parent_class = None

    def __init__(self, doc_id):
        super().__init__(parent=str(doc_id), child=None)

    @classmethod
    async def resources_sql(cls, datasette, actor=None) -> str:
        return (
            "SELECT CAST(id AS TEXT) AS parent, NULL AS child FROM _datasette_paper_doc"
        )


@hookimpl
async def permission_resources_sql(datasette, actor, action):
    """Emit SQL rules for the two paper-level actions.

    The hook returns ``None`` for actions we don't own — Datasette's
    standard config-permissions plugin handles ``datasette-paper-list``
    and ``datasette-paper-create`` from the ``permissions:`` block in
    ``datasette.yaml`` / startup ``-s`` flags.
    """
    if action not in ("datasette-paper-view", "datasette-paper-edit"):
        return None

    actor_id = actor.get("id") if actor else None
    is_edit = action == "datasette-paper-edit"
    role_filter = "AND s.role = 'editor'" if is_edit else ""
    # ``locked`` is the read-only flag. Owner row is unconditional so the
    # owner can always unlock; share + visibility *edit* grants are
    # filtered by ``locked = 0`` so a locked paper denies edit to
    # everyone except the owner. View grants ignore ``locked``.
    share_lock_join = (
        "JOIN _datasette_paper_doc d ON d.id = s.doc_id" if is_edit else ""
    )
    share_lock_filter = "AND d.locked = 0" if is_edit else ""
    visibility_lock_filter = "AND locked = 0" if is_edit else ""

    # Owner edit rule must also respect ``locked``: previously the owner
    # branch was unconditional, which made the lock a no-op from the
    # owner's perspective ("I locked the doc but I can still type" —
    # surprising and contrary to user expectation). With the filter,
    # ``locked = 1`` flips canEdit to False for everyone including the
    # owner; the owner uses the dedicated /unlock route to restore it,
    # which goes through ``_ensure_owner`` (view + inline owner check,
    # no edit gate) so the lock can't trap them.
    owner_lock_filter = "AND locked = 0" if is_edit else ""
    rules = [
        # Owner row — anonymous actors never own (NULL guard).
        PermissionSQL(
            sql=(
                "SELECT CAST(id AS TEXT) AS parent, NULL AS child, "
                "1 AS allow, 'owner' AS reason "
                "FROM _datasette_paper_doc "
                "WHERE :_paper_aid IS NOT NULL AND created_by = :_paper_aid "
                f"{owner_lock_filter}"
            ),
            params={"_paper_aid": actor_id},
        ),
        # Explicit per-actor shares.
        PermissionSQL(
            sql=(
                "SELECT CAST(s.doc_id AS TEXT) AS parent, NULL AS child, "
                "1 AS allow, 'shared' AS reason "
                f"FROM _datasette_paper_share s {share_lock_join} "
                f"WHERE :_paper_aid IS NOT NULL AND s.actor_id = :_paper_aid "
                f"{role_filter} {share_lock_filter}"
            ),
            params={"_paper_aid": actor_id},
        ),
    ]

    # Explicit per-resource deny when the doc is locked and we're
    # resolving edit. Necessary because the cascading rule resolver
    # picks the most specific (deepest) rule, and at the same depth
    # deny beats allow. Without this, a configuration that statically
    # grants ``datasette-paper-edit`` globally (depth 0) would override
    # the absence of our per-resource allow and let everyone edit a
    # locked doc anyway. Emitting the deny at parent-level (depth 1)
    # guarantees the lock wins regardless of how broadly edit was
    # granted elsewhere. The owner can still unlock because the
    # /unlock route gates on view (+ inline owner check), bypassing
    # the edit action entirely.
    if is_edit:
        rules.append(
            PermissionSQL(
                sql=(
                    "SELECT CAST(id AS TEXT) AS parent, NULL AS child, "
                    "0 AS allow, 'locked' AS reason "
                    "FROM _datasette_paper_doc WHERE locked = 1"
                ),
            )
        )

    # Visibility-based grants — gated by the global list permission so
    # admins can keep papers off the list-page while still allowing
    # owners + share-recipients in.
    if await datasette.allowed(action="datasette-paper-list", actor=actor):
        if action == "datasette-paper-view":
            visibilities = "('link-view','link-edit')"
        else:
            visibilities = "('link-edit')"
        rules.append(
            PermissionSQL(
                sql=(
                    "SELECT CAST(id AS TEXT) AS parent, NULL AS child, "
                    "1 AS allow, 'visibility' AS reason "
                    f"FROM _datasette_paper_doc WHERE visibility IN {visibilities} "
                    f"{visibility_lock_filter}"
                ),
            )
        )

    return rules


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
        action="datasette-paper-view",
        resource=PaperResource(doc_id),
        actor=request.actor,
    )


async def ensure_paper_edit(datasette, request, doc_id) -> None:
    await datasette.ensure_permission(
        action="datasette-paper-edit",
        resource=PaperResource(doc_id),
        actor=request.actor,
    )


async def can_paper_view(datasette, actor, doc_id) -> bool:
    """Like ensure_paper_view but returns True/False without raising.

    Used by the SSE handler (raw ASGI — no Forbidden middleware) and by
    the share/list endpoints where we need to inspect rather than gate.
    """
    return await datasette.allowed(
        action="datasette-paper-view",
        resource=PaperResource(doc_id),
        actor=actor,
    )
