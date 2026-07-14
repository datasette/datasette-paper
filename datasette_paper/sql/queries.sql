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
-- Document tags
--
-- Manual document-level tags (distinct from inline #tag nodes — separate
-- namespace, no auto-rollup). Mutations are manage-gated in the route
-- handler; listing/filtering is ACL-filtered by passing a viewable doc-id
-- set. insertDocTag is INSERT OR IGNORE so a duplicate (doc_id, tag) is a
-- no-op. Tags are normalized before storage (see normalize_tag in util.py).
-- ============================================================================

-- Add one (doc_id, tag) row. OR IGNORE makes a duplicate a no-op (the
-- pair is UNIQUE), so add_doc_tag is idempotent.
-- name: insertDocTag
INSERT OR IGNORE INTO _datasette_paper_doc_tag (doc_id, tag)
VALUES ($doc_id::integer, $tag::text);

-- Remove one tag from a doc. Deleting an absent tag affects 0 rows.
-- name: deleteDocTag
DELETE FROM _datasette_paper_doc_tag
WHERE doc_id = $doc_id::integer AND tag = $tag::text;

-- Clear every tag on a doc — the first half of set_doc_tags (replace).
-- name: deleteTagsForDoc
DELETE FROM _datasette_paper_doc_tag WHERE doc_id = $doc_id::integer;

-- All tags on a single doc, alphabetical (the doc's tag list response).
-- name: listTagsForDoc
SELECT tag
FROM _datasette_paper_doc_tag
WHERE doc_id = $doc_id::integer
ORDER BY tag;

-- Tags for many docs in one query (the list page). Caller passes the
-- visible doc-id set as a JSON array of integers.
-- name: listTagsForDocs
SELECT doc_id, tag
FROM _datasette_paper_doc_tag
WHERE doc_id IN (SELECT CAST(value AS INTEGER) FROM json_each($doc_ids_json::text))
ORDER BY doc_id, tag;

-- Distinct tags + doc counts over a viewable doc-id scope (filter typeahead
-- / editor autocomplete). Caller passes the ACL-visible id set.
-- name: listAllTags
SELECT tag, COUNT(*) AS n
FROM _datasette_paper_doc_tag
WHERE doc_id IN (SELECT CAST(value AS INTEGER) FROM json_each($doc_ids_json::text))
GROUP BY tag
ORDER BY n DESC, tag;

-- Doc list filtered by ids/states/kinds AND a tag intersection (a doc must
-- carry EVERY requested tag). CTEs name the two moving parts: the requested
-- tag set, and the docs that hold all of them (relational division — group
-- a doc's matching tags and require the distinct count to equal the number
-- requested). $tags_json is nullable: NULL means "no tag filter" and skips
-- the intersection (the caller passes NULL, not an empty array, when there
-- are no tags). json_each(NULL) yields zero rows, so the CTEs stay empty and
-- harmless in that case.
-- name: listDocsByIdsStatesKindsAndTags :rows -> Doc
WITH requested_tags AS (
    SELECT DISTINCT value AS tag FROM json_each($tags_json::text::)
),
docs_with_all_tags AS (
    SELECT doc_id
    FROM _datasette_paper_doc_tag
    WHERE tag IN (SELECT tag FROM requested_tags)
    GROUP BY doc_id
    HAVING COUNT(DISTINCT tag) = (SELECT COUNT(*) FROM requested_tags)
)
SELECT id, name, created_at, updated_at, created_by, schema_name, current_version, state, archived_at, trashed_at, delete_at, kind, locked
FROM _datasette_paper_doc
WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each($doc_ids_json::text))
  AND state IN (SELECT value FROM json_each($states_json::text))
  AND kind IN (SELECT value FROM json_each($kinds_json::text))
  AND ($tags_json::text:: IS NULL OR id IN (SELECT doc_id FROM docs_with_all_tags))
ORDER BY updated_at DESC;

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
-- Compaction
--
-- The step log + snapshot table are append-only on the hot path but would
-- otherwise grow without bound: every snapshot supersedes all prior steps and
-- snapshots for that doc. After a new snapshot at version V lands, every step
-- with version <= V is baked into the snapshot doc_json, and every snapshot
-- with version < V is dead weight (hydrate only reads the latest one). Pruning
-- them is safe because a client asking for evicted history already gets HTTP
-- 410 → full re-bootstrap from the latest snapshot. Caller (PaperDB.compact_doc)
-- runs both DELETEs in one execute_write_fn closure after the snapshot insert.
-- ============================================================================

-- Drop steps now folded into the snapshot at $version (inclusive).
-- name: deleteStepsUpToVersion
DELETE FROM _datasette_paper_step
WHERE doc_id = $doc_id::integer
  AND version <= $version::integer;

-- Drop every snapshot older than the latest one at $version. The latest
-- snapshot (version == $version) is kept; hydrate only ever reads it.
-- name: deleteSnapshotsBelowVersion
DELETE FROM _datasette_paper_snapshot
WHERE doc_id = $doc_id::integer
  AND version < $version::integer;

-- ============================================================================
-- Inline #tag index (derived from the materialized doc body)
--
-- ``_datasette_paper_inline_tag`` (migration m007) is a derived index of the
-- inline ``#tag`` nodes in each doc's live body, rebuilt wholesale per doc by
-- the write-tail reindex (mirrors _datasette_paper_link / reindex_links).
-- ``GET /tags/{slug}/refs`` JOINs it on an exact, indexed tag match — no more
-- unindexed ``step_json LIKE`` scan over every step of every viewable doc, and
-- no N+1 materialize loop to confirm candidates (the index already holds the
-- confirmed, normalized tag + per-doc occurrence count).
-- ============================================================================

-- Clear a doc's inline-tag rows — the first half of replace_inline_tags.
-- name: deleteInlineTagsForDoc
DELETE FROM _datasette_paper_inline_tag WHERE doc_id = $doc_id::integer;

-- name: insertInlineTag
INSERT INTO _datasette_paper_inline_tag (doc_id, tag, occurrences, src_version)
VALUES ($doc_id::integer, $tag::text, $occurrences::integer, $src_version::integer);

-- Docs containing inline ``#tag`` $tag, scoped to the requester's viewable
-- set, with the per-doc occurrence count. id is a deterministic tie-break:
-- updated_at has second resolution, so docs touched in the same second would
-- otherwise order arbitrarily (flaky results page + flaky screenshot diffs).
-- name: selectTagRefsScoped :rows -> TagRef
SELECT d.id, d.name, d.state, d.kind, d.updated_at, t.occurrences
FROM _datasette_paper_doc d
JOIN _datasette_paper_inline_tag t ON t.doc_id = d.id AND t.tag = $tag::text
WHERE d.id IN (
    SELECT CAST(value AS INTEGER) FROM json_each($viewable_json::text)
  )
ORDER BY d.updated_at DESC, d.id DESC;

-- ============================================================================
-- Doc activity (m008 _datasette_paper_doc_activity)
--
-- Durable per-(doc, actor) last-edited rollup. Upserted on every accepted
-- step (survives step compaction), purged with the doc on hard delete.
-- Currently read by listProfileDocs for the profile "Papers" section.
-- ============================================================================

-- @feat doc-activity: bump a (doc, actor)'s last_edited_at on every
-- accepted step; keyed on the (doc_id, actor_id) PK so repeat edits update
-- in place rather than accumulate rows. The single load-bearing write.
-- Stamped here (same strftime shape as the created_at defaults) so
-- last_edited_at sorts lexically against created_at in listProfileDocs'
-- COALESCE key.
-- name: upsertDocActivity
INSERT INTO _datasette_paper_doc_activity (doc_id, actor_id, last_edited_at)
VALUES ($doc_id::integer, $actor_id::text, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(doc_id, actor_id) DO UPDATE SET
    last_edited_at = excluded.last_edited_at;

-- @feat doc-activity: purge a doc's activity rows on hard delete. Mirrors
-- deleteStepsForDoc — activity carries no FK cascade (matching steps/
-- snapshots), so the hard-delete closure removes it explicitly.
-- name: deleteActivityForDoc
DELETE FROM _datasette_paper_doc_activity WHERE doc_id = $doc_id::integer;

-- @feat profile-papers: list profile actor $actor's active docs the viewer
-- can see (id set $doc_ids_json, same IN-list shape as
-- listDocsByIdsStatesAndKinds) — those the actor created OR has recorded
-- edit activity on — ordered by the actor's most recent edit, falling back
-- to doc creation, capped at $limit. Returns the standard Doc columns plus
-- the actor's last_edited_at (null for created-but-never-edited docs).
-- name: listProfileDocs :rows -> ProfileDoc
SELECT d.id, d.name, d.created_at, d.updated_at, d.created_by, d.schema_name,
       d.current_version, d.state, d.archived_at, d.trashed_at, d.delete_at,
       d.kind, d.locked, a.last_edited_at
FROM _datasette_paper_doc d
LEFT JOIN _datasette_paper_doc_activity a
    ON a.doc_id = d.id AND a.actor_id = $actor::text
WHERE d.id IN (
    SELECT CAST(value AS INTEGER) FROM json_each($doc_ids_json::text)
  )
  AND d.state = 'active'
  AND (d.created_by = $actor::text OR a.actor_id IS NOT NULL)
ORDER BY COALESCE(a.last_edited_at, d.created_at) DESC
LIMIT $limit::integer;

-- @feat last-edited-indicator: per-doc latest *attributed* editor for the
-- listing page — the actor holding MAX(last_edited_at) per doc (SQLite
-- bare-column-with-MAX semantics pick actor_id from the max row). Reads the
-- rollup, not the step log, so it survives step compaction. Anonymous edits
-- never wrote a rollup row, so a doc whose latest edit was anonymous
-- reports its last attributed editor (timestamp older than doc.updated_at);
-- pre-m008 docs with no surviving history return no row at all.
-- name: latestEditorForDocs :rows -> DocEditor
SELECT doc_id, actor_id, MAX(last_edited_at) AS last_edited_at
FROM _datasette_paper_doc_activity
WHERE doc_id IN (
    SELECT CAST(value AS INTEGER) FROM json_each($doc_ids_json::text)
  )
GROUP BY doc_id;

-- ============================================================================
-- Task assignment index (m009 _datasette_paper_task_assignment)
--
-- Derived cross-doc index of assigned task_items — one row per (doc, ordinal,
-- effective assignee). Rebuilt wholesale per doc by the write-tail reindex
-- (mirrors _datasette_paper_inline_tag / reindex_tags), purged with the doc on
-- hard delete. Read by the /todos endpoint that backs both TODO surfaces.
-- ============================================================================

-- Clear a doc's assignment rows — the first half of replace_task_assignments,
-- and the doc hard-delete purge (mirrors deleteInlineTagsForDoc).
-- name: deleteTaskAssignmentsForDoc
DELETE FROM _datasette_paper_task_assignment WHERE doc_id = $doc_id::integer;

-- name: insertTaskAssignment
INSERT INTO _datasette_paper_task_assignment
    (doc_id, ordinal, assignee, inherited, checked, text, section,
     due_date, due_time, due_tz, due_inherited, src_version)
VALUES
    ($doc_id::integer, $ordinal::integer, $assignee::text, $inherited::integer,
     $checked::integer, $text::text, $section::text, $due_date::text,
     $due_time::text, $due_tz::text, $due_inherited::integer,
     $src_version::integer);

-- Every doc id (any state/kind) — drives the one-time task-assignment backfill,
-- which materializes each doc and reindexes it best-effort. Archived/trashed/
-- template docs are indexed too (rows filtered at query time), so a later
-- restore needs no reindex.
-- name: selectAllDocIds :rows -> DocId
SELECT id FROM _datasette_paper_doc;

-- @feat task-assign: one profile actor $actor's assigned tasks across every
-- active (non-archived/trashed) doc the *viewer* can see — the viewable set is
-- passed as $doc_ids_json (same IN-list shape + acl-filter role as
-- listProfileDocs), so visibility is enforced at query time, not at index
-- time. Templates (kind != 'doc') are excluded. ``all_assignees`` is the full
-- co-assignee set for the task (the index is one row per assignee, so a
-- correlated group_concat re-gathers the others for the UI's chips). Status
-- (open/done/all) is filtered in Python on ``checked``, matching the per-doc
-- /tasks endpoint. Order: dated tasks first (undated sink to the end),
-- ascending by due, then doc + ordinal for a stable, deterministic list.
-- name: listProfileTodos :rows -> ProfileTodo
SELECT t.doc_id, d.name AS doc_name, t.ordinal, t.text, t.checked,
       t.section, t.inherited AS assignee_inherited,
       t.due_date, t.due_time, t.due_tz, t.due_inherited,
       (
         SELECT group_concat(a2.assignee, ',')
         FROM _datasette_paper_task_assignment a2
         WHERE a2.doc_id = t.doc_id AND a2.ordinal = t.ordinal
       ) AS all_assignees
FROM _datasette_paper_task_assignment t
JOIN _datasette_paper_doc d ON d.id = t.doc_id
WHERE t.assignee = $actor::text
  AND d.state = 'active'
  AND d.kind = 'doc'
  AND t.doc_id IN (
    SELECT CAST(value AS INTEGER) FROM json_each($doc_ids_json::text)
  )
ORDER BY (t.due_date IS NULL), t.due_date, t.doc_id, t.ordinal;
