# Features

Registry of named capabilities, hand-authored. This file is the source of
truth for *what a feature is*; the code is the source of truth for *where it
lives*. The slug is a greppable handle — `grep -rn "@feat <slug>"` returns
every codepath for the feature, and each marker describes what it does there.
Start reading at the **start** file.

A *feature* is a named, user-observable capability that cuts vertically
through the stack and has a test proving it. To add one: pick a kebab-case
slug, add a row here, then drop `@feat <slug>: <what this site does>` markers
at every load-bearing site (including ≥1 test). `just check-features` keeps
this table and the markers in sync.

| feature | what | start |
| --- | --- | --- |
| `paper-link` | `[[wikilink]]` cross-document references: `[[`-autocomplete, an inline NodeView that resolves the id to a title, markdown round-trip, and a write-tail edge index | `datasette_paper/links.py` |
| `mention` | `@user` mention inline atom — id-only (actorId), authored via `@`-autocomplete, name resolved live per-viewer | `frontend/src/lib/mentionView.ts` |
| `tag` | `#tag` inline atom — the value is its own label, authored via `#`-autocomplete, links to the tag-search page | `frontend/src/lib/tagView.ts` |
| `placeholder` | `{{key}}` template-placeholder inline atom — authored only in templates, substituted server-side at create time (write-only: never parsed back) | `datasette_paper/template_params.py` |
| `inline-embed` | Inline atom referencing a Datasette resource by ref path, resolved to a live pill label per-viewer | `frontend/src/lib/inlineEmbedView.ts` |
| `block-embed` | Block atom embedding a read-only live render of a Datasette table/row/db; round-trips as a `paper-embed` JSON fence | `frontend/src/lib/blockEmbedView.ts` |
| `video-embed` | "Lite" YouTube embed: a lone YouTube URL pasted in its own paragraph becomes a facade block (thumbnail → click-to-iframe); round-trips as a bare canonical watch URL on its own line | `frontend/src/lib/videoEmbedView.ts` |
| `embed-filters` | Datasette-style filter/sort config on table embeds, stored in the paper-embed fence | `frontend/src/lib/embedFilters.ts` |
| `embed-pk-links` | Table-embed rows link to their Datasette row page (single pk → the pk cell; compound pk → a leading "#" column), pk path tilde-encoded; pk headers carry a key glyph and can't be hidden | `frontend/src/lib/blockEmbedView.ts` |
| `result-cells` | Clamped, expandable cell rendering + h-scroll edge fades shared by embed/SQL result tables and the row card; blobs render as their byte size | `frontend/src/lib/resultCell.ts` |
| `source` | A named, parameterless SQL query block (fenced `source name=NAME db=DB`) that inline `value` atoms reference | `frontend/src/lib/sourceBlockView.ts` |
| `value` | Inline atom rendering a single live SQL value from a named source (`${{source.column}}`), fetched per-viewer | `frontend/src/lib/valueView.ts` |
| `sql-block` | Editable SQL query block (fenced `sql db=NAME`) run per-viewer against a named Datasette database | `frontend/src/lib/sqlBlockView.ts` |
| `tables` | Table family (table / table_row / table_cell / table_header) hand-ported from prosemirror-tables, with a custom `name` attr addressable via `/tables/{name}` | `frontend/src/lib/tables.ts` |
| `task-list` | Checkbox lists (task_list / task_item) — GFM `- [ ]` round-trip, a live checkbox NodeView, and a `/tasks` extractor | `frontend/src/lib/taskItemView.ts` |
| `collab-sse` | Realtime collaboration protocol — client EditorConnection state machine + server SSE stream, step submission with 409/410/400 version semantics and broadcast | `frontend/src/lib/collab.ts` |
| `presence` | Live cursors / presence riding the same SSE channel — selection reporting, remote-cursor decorations, self-filtered by clientID+actorID | `frontend/src/lib/cursors.ts` |
| `permissions` | Per-doc access model — five actions resolved via datasette-acl, the bespoke `locked` read-only edit-deny, owner=Manager seeding, route gating (see docs/PERMISSIONS.md) | `datasette_paper/permissions.py` |
| `snapshot-log` | Storage model — append-only step log + periodic snapshots; the live doc is materialized by replaying the steps_tail over the latest snapshot, with compaction | `datasette_paper/instance.py` |
| `line-boundary` | Cmd/Home + Left/Right move the caret to the *visual* line start/end ourselves, so a line that begins with a link mark can't leak the keystroke to Chromium's Back shortcut | `frontend/src/lib/lineBoundary.ts` |
| `pwa` | Installable home-screen app — a dynamic web app manifest at `/-/paper/manifest.webmanifest`, apple/theme-color `<head>` tags in `paper_base.html`, and packaged icons under `static/icons/` | `datasette_paper/routes/docs.py` |
