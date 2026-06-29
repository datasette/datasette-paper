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
-- Inline #tag search (LIKE-scan v1)
--
-- Candidate scan for `GET /tags/{slug}/refs`: restrict to docs the requester
-- can view, then LIKE-match either the latest snapshot's doc_json OR any step's
-- step_json for the tag node's serialized slug ("tag":"<slug>"). Scanning the
-- step log too is load-bearing: a doc edited fewer than SNAPSHOT_THRESHOLD
-- steps ago (e.g. a tag just typed) has no snapshot reflecting that content —
-- it may have no snapshot at all — so a snapshot-only candidate scan would
-- silently miss it. This is a *candidate* filter — false positives are
-- confirmed in Python by walking the materialized live doc (snapshot + live
-- steps) for a real `tag` node. A derived inline-tag index table is the
-- documented follow-up if this scan becomes a hotspot (see
-- todos/tags/07-tag-search.md).
-- ============================================================================

-- name: selectTagRefCandidatesScoped :rows -> Doc
SELECT d.id, d.name, d.created_at, d.updated_at, d.created_by, d.schema_name, d.current_version, d.state, d.archived_at, d.trashed_at, d.delete_at, d.kind, d.locked
FROM _datasette_paper_doc d
WHERE d.id IN (
    SELECT CAST(value AS INTEGER) FROM json_each($viewable_json::text)
  )
  AND (
    EXISTS (
      SELECT 1 FROM _datasette_paper_snapshot s
      WHERE s.doc_id = d.id
        AND s.version = (
          SELECT MAX(s2.version) FROM _datasette_paper_snapshot s2 WHERE s2.doc_id = d.id
        )
        AND s.doc_json LIKE $like::text
    )
    OR EXISTS (
      SELECT 1 FROM _datasette_paper_step st
      WHERE st.doc_id = d.id
        AND st.step_json LIKE $like::text
    )
  )
-- id is a deterministic tie-break: updated_at has second resolution, so docs
-- touched in the same second would otherwise order arbitrarily (flaky results
-- page + flaky screenshot diffs).
ORDER BY d.updated_at DESC, d.id DESC;

-- ============================================================================
-- Publications (publishing feature)
--
-- ``materialize_at(version)`` needs the latest snapshot at-or-before a target
-- version plus the steps strictly after it through that version — the
-- arbitrary-version analogue of selectLatestSnapshot + selectStepsAfter.
-- ============================================================================

-- name: selectLatestSnapshotAtOrBefore :row -> Snapshot
SELECT doc_id, version, doc_json, created_at
FROM _datasette_paper_snapshot
WHERE doc_id = $doc_id::integer
  AND version <= $version::integer
ORDER BY version DESC
LIMIT 1;

-- name: selectStepsInRange :rows -> Step
SELECT doc_id, version, client_id, actor_id, step_json, created_at
FROM _datasette_paper_step
WHERE doc_id = $doc_id::integer
  AND version > $after_version::integer
  AND version <= $through_version::integer
ORDER BY version;

-- Immutable per (doc_id, version); REPLACE so republishing the same version
-- overwrites cleanly (re-render with different data modes).
-- name: upsertPublication
INSERT OR REPLACE INTO _datasette_paper_publication
    (doc_id, version, html, doc_json, data_mode_default, config_json, has_live_blocks, published_by)
VALUES (
    $doc_id::integer,
    $version::integer,
    $html::text,
    $doc_json::text,
    $data_mode_default::text,
    $config_json::text,
    $has_live_blocks::integer,
    $published_by::text::
);

-- name: selectPublication :row -> Publication
SELECT doc_id, version, html, doc_json, data_mode_default, config_json, has_live_blocks, published_at, published_by
FROM _datasette_paper_publication
WHERE doc_id = $doc_id::integer
  AND version = $version::integer;

-- name: listPublicationVersions :rows -> PublicationMeta
SELECT doc_id, version, data_mode_default, has_live_blocks, published_at, published_by
FROM _datasette_paper_publication
WHERE doc_id = $doc_id::integer
ORDER BY version DESC;

-- The currently-live publication pointer (NULL = not published).
-- name: selectPublishedVersion :value
SELECT published_version FROM _datasette_paper_doc WHERE id = $doc_id::integer;

-- name: setPublishedVersion
UPDATE _datasette_paper_doc
SET published_version = $version::integer
WHERE id = $doc_id::integer;

-- name: clearPublishedVersion
UPDATE _datasette_paper_doc
SET published_version = NULL
WHERE id = $doc_id::integer;

-- name: deletePublicationData
DELETE FROM _datasette_paper_publication_data
WHERE doc_id = $doc_id::integer AND version = $version::integer;

-- name: insertPublicationData
INSERT OR REPLACE INTO _datasette_paper_publication_data
    (doc_id, version, block_id, kind, payload_json, computed_by)
VALUES (
    $doc_id::integer,
    $version::integer,
    $block_id::text,
    $kind::text,
    $payload_json::text,
    $computed_by::text::
);

-- name: selectPublicationData :rows -> PublicationData
SELECT doc_id, version, block_id, kind, payload_json, computed_at, computed_by
FROM _datasette_paper_publication_data
WHERE doc_id = $doc_id::integer AND version = $version::integer;
