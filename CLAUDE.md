# datasette-paper

Datasette plugin: collaborative document editor (ProseMirror) over SSE,
stored in Datasette's internal database as an append-only step log +
periodic snapshots. Mirrors the sibling `datasette-sheets`; diverges from
the ProseMirror reference collab server by replacing long-poll with SSE,
so 409 = stale version (catch up + retry), 410 = history evicted (full
re-bootstrap), 400 = bad version.

## Where things live

- `datasette_paper/` — Python plugin. See `datasette_paper/CLAUDE.md`.
- `frontend/` — Svelte 5 + ProseMirror, Vite-built. See `frontend/CLAUDE.md`.
- `tests/` — pytest. `frontend/e2e/` — Playwright (build the bundle first).
- `docs/PERMISSIONS.md` — authoritative permission model.
- `.att/` — open follow-up tickets (`att list`).
- `context/` (gitignored) — sibling repos and ProseMirror reference checkout.

File-level docstrings cover most "what does this module do" questions —
this doc only flags things you wouldn't find by reading any one file.

## Finding feature code

Named capabilities carry a greppable marker, so you don't have to crawl the
tree to find them. To locate a feature end-to-end: read `FEATURES.md` (the
registry — slug → one-line description + the file to start in), then
`grep -rn "@feat <slug>"`. One grep returns every load-bearing site (schema
mirrors, markdown serialize/parse, NodeViews, tests), each marker
self-describing what that codepath does. The markers are the source of truth
for *where* a feature lives; `FEATURES.md` for *what* it is.

Adding or changing a feature: keep its `@feat <slug>: <what this does>`
markers truthful (one per load-bearing site, ≥1 in a test) and add a
`FEATURES.md` row. `just check-features` validates the two stay in sync and
that schema features touch all four lock-step files (rule 1). The checker
(`tools/features_check.py`) is project-agnostic — repo specifics live in the
recipe's flags. NOTE: markers are plain comments, so put them in the host
file's comment syntax — never inside a `db.executescript("""…""")` SQL string
(use `--` there, or anchor on a real Python line outside the string).

## Cross-cutting load-bearing rules

These each took a real bug to surface; tests cover them but they aren't
tied to any single file. Quirks that *are* tied to one file live as inline
comments at the relevant code site.

1. **Schema lock-step.** `frontend/src/lib/schema.ts` and
   `datasette_paper/pm_schema.py` must mirror each other. Adding a node
   or mark on one side without the other breaks `Step.apply` in the
   server-side materializer. The markdown serializer
   (`datasette_paper/markdown.py`) and `extract_tasks` NESTING set are
   the third member of that lock-step group; the markdown *parser*
   (`datasette_paper/markdown_parser.py`, md → PM JSON, used by the
   append/create-from-markdown API) is the fourth — it can only emit
   nodes/marks the schema accepts. The schema spans four
   node groups: `prosemirror-schema-basic`, lists, the custom
   `task_list` / `task_item` pair, and the table family
   (`table` / `table_row` / `table_cell` / `table_header`). The JS
   side gets the table specs from `prosemirror-tables`'s `tableNodes`
   helper; `prosemirror-py` ships no equivalent, so `pm_schema.py`
   hand-ports the same specs (incl. `colspan` / `rowspan` / `colwidth`
   on cells and a custom `name` attr on `table`). Beyond those four
   groups, several custom nodes are in the same lock-step and must be
   mirrored across all four files: the inline atoms `placeholder` /
   `paper_link` / `mention` / `tag` / `inline_embed` / `value`, and the
   blocks `block_embed` / `sql_block` / `source`. Note the inline-value
   pair: a `source` block is a named SQL query (markdown
   ` ```source name=NAME db=DB `) and a `value` inline atom references it
   as `${{source.column}}` (the leading `$` keeps it disjoint from a
   `placeholder`'s bare `{{key}}`; the markdown value parser requires
   the `$`-prefixed `name.column` shape).
2. **Migrations are append-only.** Schema lives in
   `datasette_paper/migrations.py`; add a new `m00N_` step, never edit a
   past one.
3. **No `from __future__ import annotations` in `datasette_paper/routes/*.py`.**
   `datasette-plugin-router` uses `param.annotation is int` introspection;
   PEP 563 turns those into strings and breaks URL var injection.
4. **Build before e2e.** Playwright's `webServer` does not run
   `just frontend` — if you skip it, the page loads nothing.

## Development

```
npm install --prefix frontend
just frontend            # build the bundle (required before e2e)
just dev                 # datasette + the four paper permissions granted
just dev-with-hmr        # vite dev server + watchexec restart
just test                # backend pytest
just test-e2e            # Playwright (build first)
```

Always run Python via `uv run --prerelease=allow …` — Datasette is on
the `>=1a23` pre-release pin.

## Before every commit

Run these (and fix anything they flag) before staging:

```
just format-backend      # ruff format the backend
just check-backend       # ruff check the backend
just check-features      # @feat markers ↔ FEATURES.md in sync
just verify-frontend     # vitest + svelte-check + tsc + eslint
```

`just verify-frontend` does NOT run the e2e suite; if your change
touches routing, SSE, or the editor, also run `just test-e2e` (build
the bundle first with `just frontend`). Run pytest (`just test`) too
if anything Python changed — it's not bundled into a single recipe yet.

If `format-backend` rewrites files, re-stage. Routes signature change
→ `just types-routes` (refreshes `frontend/api.d.ts`). Edits to
`sql/queries.sql` or `migrations.py` → `just codegen-queries`
(uses `uv run solite`; CI gate is `just check-queries-fresh`).

