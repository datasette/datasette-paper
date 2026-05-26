import logging

from sqlite_utils import Database
from sqlite_migrate import Migrations

# NOTE: keep module-level imports limited to what the ``@migrations()`` step
# functions below actually need (``Database`` / ``Migrations``). The codegen
# pipeline (`just codegen-queries` → `sqlite-utils migrate`) loads this module
# via ``exec`` *without* package context, so a top-level relative import
# (``from .permissions import …``) raises ``KeyError: '__name__' not in
# globals``. The async share→acl backfill is the only code that needs the
# permission constants and acl grant helper, so those imports are deferred into
# ``migrate_shares_to_acl`` (see ``_acl_helpers``).

logger = logging.getLogger("datasette_paper.migrations")


def _acl_helpers():
    """Lazily resolve the permission constants + acl grant API.

    Imported on demand (not at module load) so this module stays loadable by
    the bare-``exec`` path that ``sqlite-utils migrate`` uses for codegen.
    Returns ``(PAPER_DOC_RESOURCE_TYPE, PAPER_DOCS_PARENT, grant,
    build_roles_registry)``; the two acl callables are ``None`` when acl isn't
    installed (the backfill then no-ops).
    """
    from .permissions import PAPER_DOC_RESOURCE_TYPE, PAPER_DOCS_PARENT

    try:  # acl is a soft dependency — the backfill no-ops when it is absent.
        from datasette_acl.grants import grant as acl_grant
    except ImportError:  # pragma: no cover
        acl_grant = None
    try:
        from datasette_acl.roles import build_roles_registry
    except ImportError:  # pragma: no cover
        build_roles_registry = None
    return PAPER_DOC_RESOURCE_TYPE, PAPER_DOCS_PARENT, acl_grant, build_roles_registry


migrations = Migrations("datasette-paper")

# Marker table recording that the one-time visibility/share → acl-grant data
# migration has completed. Distinct from the sqlite-migrate schema migrations
# above: those create/alter tables, this backfills acl grants and must not run
# before acl's startup has built the roles registry.
_ACL_MIGRATION_TABLE = "_datasette_paper_acl_migration"
_ACL_MIGRATION_KEY = "shares_to_acl_grants"

# Default general-access principal for ``link-*`` visibility. ``_signed_in``
# means "anyone signed in"; deployments wanting truly public (incl. anonymous)
# docs can set the ``share-general-principal`` plugin setting to ``*``.
DEFAULT_GENERAL_PRINCIPAL = "_signed_in"

# Old per-doc visibility enum → (general-access principal role) for the
# wildcard grant. ``private`` grants nothing extra (owner + explicit shares
# only). Per DECISIONS.md, upgrade default is CLOSED: we migrate *explicit*
# link-* visibility faithfully but never auto-open private docs.
_VISIBILITY_ROLE = {
    "link-view": "Viewer",
    "link-edit": "Editor",
}

# Old per-actor share role → new acl role.
_SHARE_ROLE = {
    "viewer": "Viewer",
    "editor": "Editor",
}


async def ensure_migrations(database) -> None:
    """Apply pending datasette-paper migrations to *database* (idempotent).

    *database* is a Datasette ``Database`` (typically
    ``datasette.get_internal_database()``). Runs inside a write
    transaction via ``execute_write_fn`` so we hold the writer lock
    while sqlite-migrate inspects + applies steps.
    """

    def _apply(connection):
        migrations.apply(Database(connection))

    await database.execute_write_fn(_apply)


def _general_principal(datasette) -> str:
    """Resolve the wildcard principal for ``link-*`` visibility.

    Configurable via the ``share-general-principal`` plugin setting
    (``datasette-paper`` block); defaults to ``_signed_in``. Only ``*`` and
    ``_signed_in`` are honoured — anything else falls back to the default.
    """
    config = datasette.plugin_config("datasette-paper") or {}
    principal = config.get("share-general-principal", DEFAULT_GENERAL_PRINCIPAL)
    if principal not in ("*", "_signed_in"):
        logger.warning(
            "datasette-paper: ignoring invalid share-general-principal %r; using %r",
            principal,
            DEFAULT_GENERAL_PRINCIPAL,
        )
        return DEFAULT_GENERAL_PRINCIPAL
    return principal


async def _acl_migration_done(db) -> bool:
    """True if the shares→grants migration marker has been recorded."""
    rows = (
        await db.execute(
            f"SELECT 1 FROM {_ACL_MIGRATION_TABLE} WHERE key = ?",
            [_ACL_MIGRATION_KEY],
        )
    ).rows
    return bool(rows)


async def _legacy_share_schema_present(db) -> bool:
    """True if the pre-acl share storage still exists to be migrated.

    Both the ``_datasette_paper_share`` table and the
    ``_datasette_paper_doc.visibility`` column are dropped by migration m004
    after their data is backfilled into acl. This guards the one-time backfill
    so it no-ops (rather than raising) once that schema is gone.
    """
    table = (
        await db.execute(
            "SELECT 1 FROM sqlite_master "
            "WHERE type = 'table' AND name = '_datasette_paper_share'"
        )
    ).rows
    if not table:
        return False
    cols = (await db.execute("PRAGMA table_info(_datasette_paper_doc)")).rows
    return any(row["name"] == "visibility" for row in cols)


async def _mark_acl_migration_done(db) -> None:
    await db.execute_write(
        f"INSERT OR IGNORE INTO {_ACL_MIGRATION_TABLE} (key, migrated_at) "
        "VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        [_ACL_MIGRATION_KEY],
    )


async def _ensure_paper_roles_registry(
    datasette, resource_type, build_roles_registry
) -> bool:
    """Make sure acl's roles registry knows the ``paper-doc`` roles.

    The data migration runs from paper's ``startup`` hook and calls acl's
    ``grant(role=...)`` helper, which resolves role names against
    ``datasette._acl_roles_registry``. That registry is populated by *acl's*
    own startup hook, and the relative ordering of two plugins' startup hooks
    is not contractually guaranteed. If paper's hook happened to run first the
    registry would be missing ``paper-doc`` and every grant would raise
    ``Unknown role``. Rather than depend on hook ordering, (re)build the
    registry here if our roles aren't present yet — it is cheap and idempotent.

    Returns False when acl isn't installed (registry helper unavailable), so
    the caller can skip the migration entirely.
    """
    if build_roles_registry is None:
        return False
    registry = getattr(datasette, "_acl_roles_registry", None)
    if not registry or resource_type not in registry:
        datasette._acl_roles_registry = await build_roles_registry(datasette)
    return resource_type in (getattr(datasette, "_acl_roles_registry", None) or {})


async def migrate_shares_to_acl(datasette, *, force: bool = False) -> dict:
    """One-time backfill of legacy share/visibility data into acl grants.

    Converts every existing doc's ``created_by`` + ``visibility`` and every
    ``_datasette_paper_share`` row into acl grants on the ``paper-doc``
    resource, using acl's ``grant`` helper (no raw writes into acl's schema):

        owner (created_by)      -> Manager grant for that actor
        share row 'viewer'      -> Viewer grant for that actor
        share row 'editor'      -> Editor grant for that actor
        visibility 'private'    -> nothing
        visibility 'link-view'  -> Viewer grant for the general principal
        visibility 'link-edit'  -> Editor grant for the general principal

    Idempotent on two levels: a marker row in ``_datasette_paper_acl_migration``
    short-circuits repeat runs, and acl's ``grant`` only inserts actions a
    principal doesn't already hold (so even a forced re-run produces no
    duplicate grants or audit rows). ``force=True`` bypasses the marker for
    tests / a deliberate re-run. No-ops (returning zero counts) when acl is not
    installed. Returns a small stats dict for logging / assertions.
    """
    stats = {"owners": 0, "shares": 0, "visibility": 0, "skipped": False}

    resource_type, parent, acl_grant, build_roles_registry = _acl_helpers()

    if acl_grant is None or not await _ensure_paper_roles_registry(
        datasette, resource_type, build_roles_registry
    ):
        # acl absent — nothing to migrate into. Still record the marker so we
        # don't re-scan on every startup; if acl is later installed the share
        # UI / create path seed grants going forward.
        stats["skipped"] = True
        return stats

    db = datasette.get_internal_database()
    await db.execute_write(
        f"CREATE TABLE IF NOT EXISTS {_ACL_MIGRATION_TABLE} ("
        "key TEXT PRIMARY KEY, migrated_at TEXT NOT NULL)"
    )

    if not force and await _acl_migration_done(db):
        stats["skipped"] = True
        return stats

    # The legacy ``visibility`` column + ``_datasette_paper_share`` table were
    # dropped in migration m004 once their data had been backfilled into acl.
    # On any DB that held legacy data the backfill ran (and set its marker) on
    # an earlier boot, so reaching here without that column/table means there is
    # nothing to migrate (fresh install, or a forced re-run after the drop).
    # Bail gracefully rather than raising on the missing schema.
    if not await _legacy_share_schema_present(db):
        stats["skipped"] = True
        await _mark_acl_migration_done(db)
        return stats

    general_principal = _general_principal(datasette)

    # Owner + visibility live on the doc row.
    docs = (
        await db.execute("SELECT id, created_by, visibility FROM _datasette_paper_doc")
    ).rows
    for row in docs:
        doc_id = str(row["id"])
        created_by = row["created_by"]
        visibility = row["visibility"]

        # Owner → Manager (skip anonymous-created docs: NULL/empty created_by).
        if created_by:
            await acl_grant(
                datasette,
                resource_type,
                parent,
                doc_id,
                actor_id=str(created_by),
                role="Manager",
                by_actor=str(created_by),
            )
            stats["owners"] += 1

        # Visibility → general-access (wildcard) grant.
        vis_role = _VISIBILITY_ROLE.get(visibility)
        if vis_role is not None:
            await acl_grant(
                datasette,
                resource_type,
                parent,
                doc_id,
                actor_id=general_principal,
                role=vis_role,
                by_actor=None,
            )
            stats["visibility"] += 1

    # Explicit per-actor share rows.
    shares = (
        await db.execute(
            "SELECT doc_id, actor_id, role, granted_by FROM _datasette_paper_share"
        )
    ).rows
    for row in shares:
        share_role = _SHARE_ROLE.get(row["role"])
        if share_role is None:  # pragma: no cover - CHECK constraint guards this
            logger.warning(
                "datasette-paper: skipping share with unknown role %r (doc %s)",
                row["role"],
                row["doc_id"],
            )
            continue
        await acl_grant(
            datasette,
            resource_type,
            parent,
            str(row["doc_id"]),
            actor_id=str(row["actor_id"]),
            role=share_role,
            by_actor=str(row["granted_by"]) if row["granted_by"] else None,
        )
        stats["shares"] += 1

    await _mark_acl_migration_done(db)
    logger.info(
        "datasette-paper: migrated shares to acl grants "
        "(owners=%(owners)s shares=%(shares)s visibility=%(visibility)s)",
        stats,
    )
    return stats


@migrations()
def m001_internal(db: Database):
    # Papers live in Datasette's internal DB (set via `--internal <path>`
    # on the CLI). All tables live under the ``_datasette_paper_*``
    # prefix. Future schema changes land as new ``m00N_*`` steps below
    # — never edit this step.
    #
    # Column-level descriptions use sqlite-docs doc comments
    # (``--!`` for tables, ``---`` for the following column). See
    # https://github.com/asg017/sqlite-docs.
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS _datasette_paper_doc (
            --! Canonical metadata for each paper. One row per document.
            --! _datasette_paper_step and _datasette_paper_snapshot
            --! reference this table by id; cascade delete removes a
            --! doc's full history.
            --! @details docs/PERMISSIONS.md

            --- Doc identifier — appears in URLs as /-/paper/<id>.
            id              INTEGER PRIMARY KEY NOT NULL,

            --- Human-readable title shown in the editor and the doc list.
            name            TEXT NOT NULL,

            --- Creation timestamp, ISO-8601 UTC with millisecond precision.
            created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

            --- Last-modified timestamp; bumped on rename and on every
            --- step insert.
            updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

            --- Actor id of the doc owner; NULL for anonymous-created
            --- papers. Owner-only operations (visibility / share
            --- mutation) gate on this column.
            created_by      TEXT,

            --- ProseMirror schema flavour the doc was created with.
            --- The editor (frontend/src/lib/schema.ts) and server-side
            --- materializer (datasette_paper/pm_schema.py) both pin to
            --- this value.
            schema_name     TEXT NOT NULL DEFAULT 'basic+list',

            --- Latest step version applied to the doc — equal to
            --- MAX(version) across this doc's steps. Bumped inside
            --- insert_step atomically with the step row so there is
            --- no TOCTOU gap.
            current_version INTEGER NOT NULL DEFAULT 0,

            --- Sharing mode for the paper. 'private' = owner plus
            --- explicit _datasette_paper_share rows only. 'link-view' =
            --- anyone with the URL can read. 'link-edit' = anyone
            --- with the URL can read and edit.
            --- @details docs/PERMISSIONS.md
            visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','link-view','link-edit'))
        );
        CREATE INDEX IF NOT EXISTS idx_paper_doc_owner
            ON _datasette_paper_doc(created_by);

        CREATE TABLE IF NOT EXISTS _datasette_paper_step (
            --! Append-only log of ProseMirror steps for collaborative
            --! editing. The live document is reconstructed by
            --! replaying steps with version > the latest snapshot's
            --! version on top of that snapshot's doc_json.
            --! (doc_id, version) is the primary key so version
            --! ordering is monotonic per doc.

            --- Doc this step belongs to.
            doc_id     INTEGER NOT NULL REFERENCES _datasette_paper_doc(id) ON DELETE CASCADE,

            --- 1-based, monotonically increasing within doc_id. Equal
            --- to the doc's current_version immediately after the
            --- step is applied.
            version    INTEGER NOT NULL,

            --- ProseMirror collab session id from the originating
            --- editor. Used by clients to distinguish echoes of their
            --- own steps over SSE.
            client_id  INTEGER NOT NULL,

            --- Actor id that produced the step; NULL for anonymous
            --- edits (e.g. via link-edit visibility without auth).
            actor_id   TEXT,

            --- Serialized ProseMirror Step (one step per row).
            step_json  TEXT NOT NULL,

            --- ISO-8601 UTC timestamp the step was committed server-side.
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

            PRIMARY KEY (doc_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_paper_step_doc_ver
            ON _datasette_paper_step(doc_id, version);

        CREATE TABLE IF NOT EXISTS _datasette_paper_snapshot (
            --! Periodic full-document checkpoints. The materializer
            --! reads the latest snapshot for a doc and then replays
            --! steps with version > snapshot.version to produce the
            --! live document. Snapshots also gate step-history
            --! eviction — clients that ask for steps older than the
            --! latest snapshot get HTTP 410 and must re-bootstrap.

            --- Doc this snapshot belongs to.
            doc_id     INTEGER NOT NULL REFERENCES _datasette_paper_doc(id) ON DELETE CASCADE,

            --- Step version this snapshot reflects: doc_json equals
            --- the doc after replaying all steps up to and including
            --- this version.
            version    INTEGER NOT NULL,

            --- Full ProseMirror document as JSON, frozen at *version*.
            doc_json   TEXT NOT NULL,

            --- Actor that triggered the snapshot — typically whoever
            --- authored the step that crossed the snapshot cadence.
            actor_id   TEXT,

            --- ISO-8601 UTC timestamp the snapshot was written.
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

            PRIMARY KEY (doc_id, version)
        );

        CREATE TABLE IF NOT EXISTS _datasette_paper_share (
            --! Explicit per-actor share grants for a paper. Combines
            --! with _datasette_paper_doc.visibility: link-* visibility
            --! opens the doc to anyone with the URL; rows here
            --! additionally name specific actors and the role they
            --! hold against an otherwise-private paper.
            --! @details docs/PERMISSIONS.md

            --- Doc the grant applies to.
            doc_id     INTEGER NOT NULL REFERENCES _datasette_paper_doc(id) ON DELETE CASCADE,

            --- Datasette actor id the grant is for.
            actor_id   TEXT NOT NULL,

            --- Role conferred by the share. 'viewer' is read-only;
            --- 'editor' can also write steps.
            role       TEXT NOT NULL CHECK (role IN ('viewer','editor')),

            --- Actor id that created the grant; NULL when the grant
            --- was emitted by a system / background flow.
            granted_by TEXT,

            --- ISO-8601 UTC timestamp the grant was created.
            granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

            PRIMARY KEY (doc_id, actor_id)
        );
        CREATE INDEX IF NOT EXISTS idx_paper_share_actor
            ON _datasette_paper_share(actor_id);
        """
    )


@migrations()
def m002_archive_trash(db: Database):
    # Adds the listing-state model: a paper can be 'active' (default,
    # shown on /-/paper), 'archived' (hidden from the main list, still
    # accessible via the Archive tab), or 'trashed' (in the trash, with
    # ``delete_at`` driving an eventual hard-delete sweep run by
    # datasette-cron — see datasette_paper/cron.py).
    #
    # State changes are owner-only and orthogonal to the permission
    # model: an editor share still grants edit on a trashed paper if you
    # navigate to it directly. The list endpoint filters by state.
    db.executescript(
        """
        ALTER TABLE _datasette_paper_doc
            ADD COLUMN state TEXT NOT NULL DEFAULT 'active'
                CHECK (state IN ('active','archived','trashed'));

        --- ISO-8601 UTC; NULL while the paper is active.
        ALTER TABLE _datasette_paper_doc ADD COLUMN archived_at TEXT;

        --- ISO-8601 UTC; NULL unless state = 'trashed'.
        ALTER TABLE _datasette_paper_doc ADD COLUMN trashed_at TEXT;

        --- ISO-8601 UTC; cron sweep hard-deletes rows whose delete_at
        --- has passed. Set at trash time to trashed_at + 7 days; cleared
        --- on restore.
        ALTER TABLE _datasette_paper_doc ADD COLUMN delete_at TEXT;

        CREATE INDEX IF NOT EXISTS idx_paper_doc_state
            ON _datasette_paper_doc(state);
        CREATE INDEX IF NOT EXISTS idx_paper_doc_delete_at
            ON _datasette_paper_doc(delete_at) WHERE delete_at IS NOT NULL;
        """
    )


@migrations()
def m003_templates_and_lock(db: Database):
    # Two orthogonal capability flags on the doc row:
    #
    # * ``kind`` distinguishes user-authored docs from template docs.
    #   Templates are still real papers (collab, snapshots, share, etc.
    #   all work the same); they're filtered out of the default listing
    #   and shown in their own tab. Create-from-template clones the
    #   materialized template doc into a fresh version-0 snapshot of a
    #   brand-new doc.
    #
    # * ``locked`` makes a paper read-only — owner can flip it back at
    #   any time, but everyone else loses edit grants while it's set.
    #   The permission_resources_sql hook (see permissions.py) ANDs
    #   ``locked = 0`` into the edit-side rules so the same column gates
    #   both share-row and visibility-based editors. Owner row stays
    #   unconditional so the owner can always unlock.
    #
    # The two are orthogonal: a locked template still lets others create
    # docs from it; an archived doc can still be locked or unlocked.
    db.executescript(
        """
        ALTER TABLE _datasette_paper_doc
            ADD COLUMN kind TEXT NOT NULL DEFAULT 'doc'
                CHECK (kind IN ('doc','template'));

        ALTER TABLE _datasette_paper_doc
            ADD COLUMN locked INTEGER NOT NULL DEFAULT 0
                CHECK (locked IN (0,1));

        CREATE INDEX IF NOT EXISTS idx_paper_doc_kind
            ON _datasette_paper_doc(kind) WHERE kind = 'template';
        """
    )


@migrations()
def m004_drop_legacy_share_model(db: Database):
    # Sharing is now owned by datasette-acl (resource type ``paper-doc``).
    # The owner/visibility/share data was backfilled into acl grants by the
    # one-time ``migrate_shares_to_acl`` startup routine (see above); this step
    # retires the legacy storage that fed it:
    #
    #   * ``_datasette_paper_share``      — explicit per-actor grants
    #   * ``_datasette_paper_doc.visibility`` — the link-* general-access enum
    #
    # IMPORTANT: this runs in ``ensure_migrations`` BEFORE the startup data
    # migration's read. On any DB that already holds legacy data the backfill
    # ran on a prior boot (its marker is set), so dropping here loses nothing;
    # on a fresh DB there was never any legacy data. ``migrate_shares_to_acl``
    # tolerates the missing column/table (it treats "no legacy schema" as
    # "nothing to migrate").
    #
    # SQLite only learned ``ALTER TABLE ... DROP COLUMN`` in 3.35; sqlite-migrate
    # may run against older engines, so drop ``visibility`` via the portable
    # 12-step table rebuild rather than DROP COLUMN. The rebuilt table keeps the
    # exact column set + constraints + indexes minus ``visibility``.
    db.executescript(
        """
        DROP TABLE IF EXISTS _datasette_paper_share;

        CREATE TABLE _datasette_paper_doc_new (
            id              INTEGER PRIMARY KEY NOT NULL,
            name            TEXT NOT NULL,
            created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            created_by      TEXT,
            schema_name     TEXT NOT NULL DEFAULT 'basic+list',
            current_version INTEGER NOT NULL DEFAULT 0,
            state           TEXT NOT NULL DEFAULT 'active'
                              CHECK (state IN ('active','archived','trashed')),
            archived_at     TEXT,
            trashed_at      TEXT,
            delete_at       TEXT,
            kind            TEXT NOT NULL DEFAULT 'doc'
                              CHECK (kind IN ('doc','template')),
            locked          INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1))
        );

        INSERT INTO _datasette_paper_doc_new (
            id, name, created_at, updated_at, created_by, schema_name,
            current_version, state, archived_at, trashed_at, delete_at,
            kind, locked
        )
        SELECT
            id, name, created_at, updated_at, created_by, schema_name,
            current_version, state, archived_at, trashed_at, delete_at,
            kind, locked
        FROM _datasette_paper_doc;

        DROP TABLE _datasette_paper_doc;
        ALTER TABLE _datasette_paper_doc_new RENAME TO _datasette_paper_doc;

        CREATE INDEX IF NOT EXISTS idx_paper_doc_owner
            ON _datasette_paper_doc(created_by);
        CREATE INDEX IF NOT EXISTS idx_paper_doc_state
            ON _datasette_paper_doc(state);
        CREATE INDEX IF NOT EXISTS idx_paper_doc_delete_at
            ON _datasette_paper_doc(delete_at) WHERE delete_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_paper_doc_kind
            ON _datasette_paper_doc(kind) WHERE kind = 'template';
        """
    )
