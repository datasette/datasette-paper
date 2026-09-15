# Papers as data

Paper data lives in Datasette's internal database under tables prefixed
`_datasette_paper_`, so it's queryable like any other Datasette table (subject
to the [permissions](permissions/index.md) model — these tables aren't
exposed for arbitrary SQL browsing by default).

:::{note}
`README.md`'s "Papers as data" section lists a `_datasette_paper_share` table
for per-actor grants. That table was dropped by migration `m004` — sharing
moved to [datasette-acl](https://github.com/datasette/datasette-acl)'s own
grant tables. The list below reflects the current schema
(`datasette_paper/migrations.py`).
:::

## Tables

- `_datasette_paper_doc` — one row per paper (id, name, state, kind,
  `created_by`, `current_version`, `locked`, timestamps).
- `_datasette_paper_step` — append-only log of ProseMirror steps, the source
  of truth for a paper's edit history.
- `_datasette_paper_snapshot` — periodic full-document snapshots, so the live
  document is reconstructed by replaying only the steps after the latest
  snapshot rather than the whole history.
- `_datasette_paper_link` — the `[[wikilink]]` graph: one row per
  source-doc → destination-doc reference.
- `_datasette_paper_doc_tag` — document-level metadata tags (as distinct from
  inline `#tag` atoms in the body).
- `_datasette_paper_inline_tag` — index of inline `#tag` atoms found in a
  paper's body, backing the tag results page.
- `_datasette_paper_doc_activity` — durable per-(doc, actor) last-edited
  rollup, survives step compaction; backs the profile "Papers" section and
  the listing's last-edited column.
- `_datasette_paper_task_assignment` — write-tail index of `@mention`-assigned
  task items (with their due date, if any), backing the cross-paper `/todos`
  API and page.

## Storage model (`snapshot-log`)

Storage is an append-only step log plus periodic snapshots: the live document
is materialized by replaying `_datasette_paper_step` rows newer than the
latest `_datasette_paper_snapshot`, over that snapshot, via `prosemirror-py`.
Old steps are periodically compacted into a fresh snapshot so the tail stays
short. See `datasette_paper/instance.py`.

## Reading papers without a server

The `datasette paper` CLI reads this database directly, without a running
Datasette process — see [CLI](cli.md) for `export`, `dump`, `list`, `info`,
`tables`, `tasks` and `check`. For example, to see every active/archived
paper's id and name:

```bash
datasette paper list papers.db
```

:::{note}
TODO: a short worked SQL example against `_datasette_paper_doc` /
`_datasette_paper_step` (e.g. "papers edited in the last week") once one has
been verified against a real internal database.
:::
