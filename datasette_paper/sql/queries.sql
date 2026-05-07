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
-- Multi-statement orchestration (e.g. share replacement, step+version
-- bump) lives in db.py — codegen emits one helper per query block.

-- ============================================================================
-- Docs
-- ============================================================================

-- name: insertDoc :row -> Doc
INSERT INTO _datasette_paper_doc (name, created_by, schema_name)
VALUES ($name::text, $created_by::text::, $schema_name::text)
RETURNING id, name, created_at, updated_at, created_by, schema_name, current_version, visibility;

-- name: updateDocName :row -> Doc
UPDATE _datasette_paper_doc
SET name = $name::text,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id = $doc_id::integer
RETURNING id, name, created_at, updated_at, created_by, schema_name, current_version, visibility;

-- name: selectDocById :row -> Doc
SELECT id, name, created_at, updated_at, created_by, schema_name, current_version, visibility
FROM _datasette_paper_doc
WHERE id = $doc_id::integer;

-- name: listDocs :rows -> Doc
SELECT id, name, created_at, updated_at, created_by, schema_name, current_version, visibility
FROM _datasette_paper_doc
ORDER BY created_at;

-- Variable-length IN clause: caller passes a JSON array of integers
-- (db.py uses ``json.dumps(doc_ids)``); ``json_each`` unpacks it.
-- Empty list collapses to no rows naturally — no special case needed.
-- name: listDocsByIds :rows -> Doc
SELECT id, name, created_at, updated_at, created_by, schema_name, current_version, visibility
FROM _datasette_paper_doc
WHERE id IN (
    SELECT CAST(value AS INTEGER) FROM json_each($doc_ids_json::text)
)
ORDER BY updated_at DESC;

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

-- ============================================================================
-- Shares
--
-- `replaceShares` in db.py orchestrates the three statements below
-- in a single write transaction (visibility update + wipe existing
-- shares + insert new ones). Roles are validated in Python before
-- this runs; visibility is also gated by the doc table's CHECK.
-- ============================================================================

-- name: selectShares :rows -> Share
SELECT actor_id, role, granted_by, granted_at
FROM _datasette_paper_share
WHERE doc_id = $doc_id::integer
ORDER BY actor_id;

-- name: updateDocVisibility
UPDATE _datasette_paper_doc
SET visibility = $visibility::text
WHERE id = $doc_id::integer;

-- name: deleteSharesForDoc
DELETE FROM _datasette_paper_share WHERE doc_id = $doc_id::integer;

-- name: insertShare
INSERT INTO _datasette_paper_share (doc_id, actor_id, role, granted_by)
VALUES ($doc_id::integer, $actor_id::text, $role::text, $granted_by::text::);
