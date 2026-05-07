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
    role_filter = "" if action == "datasette-paper-view" else "AND s.role = 'editor'"

    rules = [
        # Owner row — anonymous actors never own (NULL guard).
        PermissionSQL(
            sql=(
                "SELECT CAST(id AS TEXT) AS parent, NULL AS child, "
                "1 AS allow, 'owner' AS reason "
                "FROM _datasette_paper_doc "
                "WHERE :_paper_aid IS NOT NULL AND created_by = :_paper_aid"
            ),
            params={"_paper_aid": actor_id},
        ),
        # Explicit per-actor shares.
        PermissionSQL(
            sql=(
                "SELECT CAST(s.doc_id AS TEXT) AS parent, NULL AS child, "
                "1 AS allow, 'shared' AS reason "
                "FROM _datasette_paper_share s "
                f"WHERE :_paper_aid IS NOT NULL AND s.actor_id = :_paper_aid {role_filter}"
            ),
            params={"_paper_aid": actor_id},
        ),
    ]

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
                    f"FROM _datasette_paper_doc WHERE visibility IN {visibilities}"
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
