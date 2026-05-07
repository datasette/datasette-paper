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
- `tests/` — pytest. `e2e/` — Playwright (build the bundle first).
- `docs/PERMISSIONS.md` — authoritative permission model.
- `.att/` — open follow-up tickets (`att list`).
- `context/` (gitignored) — sibling repos and ProseMirror reference checkout.

File-level docstrings cover most "what does this module do" questions —
this doc only flags things you wouldn't find by reading any one file.

## Cross-cutting load-bearing rules

These each took a real bug to surface; tests cover them but they aren't
tied to any single file. Quirks that *are* tied to one file live as inline
comments at the relevant code site.

1. **Schema lock-step.** `frontend/src/lib/schema.ts` and
   `datasette_paper/pm_schema.py` must mirror each other. Adding a node
   or mark on one side without the other breaks `Step.apply` in the
   server-side materializer. The markdown serializer
   (`datasette_paper/markdown.py`) and `extract_tasks` NESTING set are
   the third member of that lock-step group.
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

## Open follow-ups

- `si4oztnq` (p3) — stop routing read-only queries through Datasette's
  write queue. Correctness-adjacent, no current-test failures.
