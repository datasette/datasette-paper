-- schema: ../../schema.db
-- Named queries for datasette-paper.
--
-- Edit here, then run `just codegen-queries` to regenerate
-- `_queries.sql.json` (the IR) and `_queries.py` (typed Python helpers).
-- `just check-queries-fresh` is the CI gate.
--
-- solite codegen syntax (subset):
--     -- name: foo                     -- :rows by default → list[Row]
--     -- name: foo :rows -> Doc        -- list[Doc] using a named class
--     -- name: foo :row  -> Doc        -- Doc | None
--     -- name: foo :value              -- scalar | None
--     -- name: foo                     -- Void for INSERT/UPDATE/DELETE
--
-- Parameter sigils:
--     $foo::text                       -- non-null text → str
--     $foo::text::                     -- nullable text → str | None
--     $foo::integer                    -- int (non-null)
--
-- Multi-statement orchestration (e.g. the step+version bump) lives in
-- db.py — codegen emits one helper per query block.

-- ============================================================================
-- Docs
--
-- Every Doc-returning query selects the same column set so the generated
-- ``Doc`` dataclass has one shape. The state/timestamp columns added by
-- migration m002 are part of that set.
-- ============================================================================

-- name: insertDoc :row -> Doc
INSERT INTO _datasette_paper_doc (name, created_by, schema_name, kind)
VALUES ($name::text, $created_by::text::, $schema_name::text, $kind::text)
RETURNING id, name, created_at, updated_at, created_by, schema_name, current_version, state, archived_at, trashed_at, delete_at, kind, locked;

-- name: updateDocName :row -> Doc
UPDATE _datasette_paper_doc
SET name = $name::text,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id = $doc_id::integer
RETURNING id, name, created_at, updated_at, created_by, schema_name, current_version, state, archived_at, trashed_at, delete_at, kind, locked;

-- name: selectDocById :row -> Doc
SELECT id, name, created_at, updated_at, created_by, schema_name, current_version, state, archived_at, trashed_at, delete_at, kind, locked
FROM _datasette_paper_doc
WHERE id = $doc_id::integer;

-- name: listDocs :rows -> Doc
SELECT id, name, created_at, updated_at, created_by, schema_name, current_version, state, archived_at, trashed_at, delete_at, kind, locked
FROM _datasette_paper_doc
ORDER BY created_at;

-- Variable-length IN clauses: caller passes JSON arrays of integers /
-- strings (db.py uses ``json.dumps(...)``); ``json_each`` unpacks them.
-- Empty list collapses to no rows naturally — no special case needed.
-- ``$states_json`` is a JSON array of strings drawn from the same set as
-- the state CHECK constraint, e.g. ``["active"]`` or
-- ``["archived","trashed"]``. ``$kinds_json`` similarly filters by the
-- kind CHECK set (e.g. ``["doc"]`` for the default index listing or
-- ``["template"]`` for the templates tab).
-- name: listDocsByIdsStatesAndKinds :rows -> Doc
SELECT id, name, created_at, updated_at, created_by, schema_name, current_version, state, archived_at, trashed_at, delete_at, kind, locked
FROM _datasette_paper_doc
WHERE id IN (
    SELECT CAST(value AS INTEGER) FROM json_each($doc_ids_json::text)
)
  AND state IN (
    SELECT value FROM json_each($states_json::text)
)
  AND kind IN (
    SELECT value FROM json_each($kinds_json::text)
)
ORDER BY updated_at DESC;

-- name: searchDocsByTitle :rows -> Doc
SELECT id, name, created_at, updated_at, created_by, schema_name, current_version, state, archived_at, trashed_at, delete_at, kind, locked
FROM _datasette_paper_doc
WHERE id IN (
    SELECT CAST(value AS INTEGER) FROM json_each($doc_ids_json::text)
)
  AND state = 'active'
  AND kind = 'doc'
  AND name LIKE $like::text
ORDER BY
  CASE WHEN name LIKE $prefix::text THEN 0 ELSE 1 END,
  length(name),
  updated_at DESC
LIMIT $limit::integer;

-- name: listDocsByIds :rows -> Doc
SELECT id, name, created_at, updated_at, created_by, schema_name, current_version, state, archived_at, trashed_at, delete_at, kind, locked
FROM _datasette_paper_doc
WHERE id IN (
    SELECT CAST(value AS INTEGER) FROM json_each($doc_ids_json::text)
);

-- ============================================================================
-- Links
--
-- Outgoing paper_link edges for a doc, rebuilt wholesale per src by the
-- write-tail reindex (delete-all + re-insert in one transaction). dst_doc_id
-- is intentionally not a FK; src_doc_id cascades on doc hard-delete.
-- ============================================================================

-- name: deleteLinksForSrc
DELETE FROM _datasette_paper_link WHERE src_doc_id = $src_doc_id::integer;

-- name: insertLink
INSERT INTO _datasette_paper_link (src_doc_id, dst_doc_id, occurrences, src_version)
VALUES ($src_doc_id::integer, $dst_doc_id::integer, $occurrences::integer, $src_version::integer);

-- Forward links: every dst this src points at, with how many times.
-- name: selectLinksBySrc :rows -> LinkEdge
SELECT dst_doc_id, occurrences
FROM _datasette_paper_link
WHERE src_doc_id = $src_doc_id::integer
ORDER BY dst_doc_id;

-- Backlinks restricted to sources the requester can view (no existence
-- disclosure of private papers that link this one). Caller passes the
-- viewable id set as a JSON array of integers.
-- name: selectBacklinksByDstScoped :rows -> Backlink
SELECT src_doc_id, occurrences
FROM _datasette_paper_link
WHERE dst_doc_id = $dst_doc_id::integer
  AND src_doc_id IN (
    SELECT CAST(value AS INTEGER) FROM json_each($viewable_json::text)
  )
ORDER BY src_doc_id;

-- Edges where BOTH endpoints are viewable — the permitted subgraph. Caller
-- passes the viewable id set as a JSON array of integers.
-- name: selectEdgesWithin :rows -> GraphEdge
SELECT src_doc_id, dst_doc_id, occurrences
FROM _datasette_paper_link
WHERE src_doc_id IN (SELECT CAST(value AS INTEGER) FROM json_each($viewable_json::text))
  AND dst_doc_id IN (SELECT CAST(value AS INTEGER) FROM json_each($viewable_json::text))
ORDER BY src_doc_id, dst_doc_id;

-- ============================================================================
-- State transitions (archive / trash)
--
-- Owner-only — enforced inline in the route handler. Each query is a
-- single-row UPDATE keyed on id; the route fetches the post-update row
-- via selectDocById to get the full Doc shape for the response and the
-- SSE state-changed broadcast.
-- ============================================================================

-- name: archiveDoc
UPDATE _datasette_paper_doc
SET state = 'archived',
    archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    trashed_at = NULL,
    delete_at = NULL
WHERE id = $doc_id::integer;

-- ``unarchiveDoc`` and ``restoreDoc`` are the same statement: both put
-- the doc back in 'active' and clear all three timestamps. They're kept
-- as separate names so route handlers read clearly. The codegen will
-- emit identical bodies.
-- name: unarchiveDoc
UPDATE _datasette_paper_doc
SET state = 'active',
    archived_at = NULL,
    trashed_at = NULL,
    delete_at = NULL
WHERE id = $doc_id::integer;

-- name: trashDoc
UPDATE _datasette_paper_doc
SET state = 'trashed',
    trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    delete_at = $delete_at::text
WHERE id = $doc_id::integer;

-- name: restoreDoc
UPDATE _datasette_paper_doc
SET state = 'active',
    archived_at = NULL,
    trashed_at = NULL,
    delete_at = NULL
WHERE id = $doc_id::integer;

-- Cron sweep: rows whose delete_at has passed. Caller passes ``$now``
-- as an ISO-8601 UTC string in the same format strftime emits, so
-- string comparison matches chronological order.
-- name: listTrashedToDelete :rows -> Doc
SELECT id, name, created_at, updated_at, created_by, schema_name, current_version, state, archived_at, trashed_at, delete_at, kind, locked
FROM _datasette_paper_doc
WHERE state = 'trashed'
  AND delete_at IS NOT NULL
  AND delete_at < $now::text
ORDER BY delete_at;

-- ============================================================================
-- Template + lock toggles
--
-- Owner-only — enforced inline in the route handler, same pattern as
-- archive/trash. Each is a single-row UPDATE keyed on id; the route
-- refetches via selectDocById for the response and any SSE broadcast.
-- ============================================================================

-- name: setDocKind
UPDATE _datasette_paper_doc
SET kind = $kind::text,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id = $doc_id::integer;

-- name: setDocLocked
UPDATE _datasette_paper_doc
SET locked = $locked::integer,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id = $doc_id::integer;

-- ``hardDeleteDoc`` deletes from each child table explicitly because
-- SQLite only honors ON DELETE CASCADE when ``PRAGMA foreign_keys = ON``
-- is set per-connection and we can't guarantee that in every host
-- environment. Caller wraps these in a single execute_write_fn closure
-- so the four statements run in one transaction.
-- name: deleteStepsForDoc
DELETE FROM _datasette_paper_step WHERE doc_id = $doc_id::integer;

-- name: deleteSnapshotsForDoc
DELETE FROM _datasette_paper_snapshot WHERE doc_id = $doc_id::integer;

-- name: hardDeleteDoc
DELETE FROM _datasette_paper_doc WHERE id = $doc_id::integer;

-- ============================================================================
-- Steps
-- ============================================================================

-- Insert a step at (current_version + 1). Computing the next version
-- inside SQLite removes the TOCTOU gap between SELECT MAX(version) and
-- INSERT. Caller follows up with `bumpDocVersion` so
-- `_datasette_paper_doc.current_version` matches the new step.
-- name: insertStep :value
INSERT INTO _datasette_paper_step (doc_id, version, client_id, actor_id, step_json)
VALUES (
    $doc_id::integer,
    (SELECT current_version + 1 FROM _datasette_paper_doc WHERE id = $doc_id::integer),
    $client_id::integer,
    $actor_id::text::,
    $step_json::text
)
RETURNING version;

-- name: bumpDocVersion
UPDATE _datasette_paper_doc
SET current_version = $version::integer,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id = $doc_id::integer;

-- name: selectStepsAfter :rows -> Step
SELECT doc_id, version, client_id, actor_id, step_json, created_at
FROM _datasette_paper_step
WHERE doc_id = $doc_id::integer
  AND version > $after_version::integer
ORDER BY version;

-- name: selectMaxVersion :value
SELECT MAX(version) FROM _datasette_paper_step WHERE doc_id = $doc_id::integer;

-- ============================================================================
-- Snapshots
-- ============================================================================

-- name: insertSnapshot
INSERT INTO _datasette_paper_snapshot (doc_id, version, doc_json, actor_id)
VALUES ($doc_id::integer, $version::integer, $doc_json::text, $actor_id::text::);

-- name: selectLatestSnapshot :row -> Snapshot
SELECT doc_id, version, doc_json, created_at
FROM _datasette_paper_snapshot
WHERE doc_id = $doc_id::integer
ORDER BY version DESC
LIMIT 1;
