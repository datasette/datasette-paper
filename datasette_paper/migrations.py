from sqlite_utils import Database
from sqlite_migrate import Migrations

migrations = Migrations("datasette-paper")


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
