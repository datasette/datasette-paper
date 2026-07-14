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
| `embed-copy-url` | Copying a block embed puts its full Datasette URL (filters/sort/hidden-columns in the query) on the clipboard as text/plain, via the node's `leafText` | `frontend/src/lib/embedFilters.ts` |
| `result-cells` | Clamped, expandable cell rendering + h-scroll edge fades shared by embed/SQL result tables and the row card; blobs render as their byte size | `frontend/src/lib/resultCell.ts` |
| `source` | A named, parameterless SQL query block (fenced `source name=NAME db=DB`) that inline `value` atoms reference; its SQL surface upgrades to a CodeMirror editor on focus (a collapsed pill declines the mount), and the Sources panel drafts SQL in a standalone CM field | `frontend/src/lib/sourceBlockView.ts` |
| `value` | Inline atom rendering a single live SQL value from a named source (`${{source.column}}`), fetched per-viewer | `frontend/src/lib/valueView.ts` |
| `sql-block` | Editable SQL query block (fenced `sql db=NAME`) run per-viewer against a named Datasette database; its SQL surface upgrades to a CodeMirror editor on focus (SQLite keyword completion, Mod-Enter runs) with a (db, sql) result cache spanning the static↔CM rebuild | `frontend/src/lib/sqlBlockView.ts` |
| `code-language` | `code_block` carries a `language` attr — typed via ` ```lang ` + space/Enter, round-tripped as the markdown fence info string (reserved/unsafe tokens refused), preserved through the markdown paste path | `frontend/src/lib/schema.ts` |
| `code-highlight` | Tier-0 static syntax highlighting for `code_block` / `sql_block` / `source` — a PM decoration plugin runs lazily-loaded lezer grammars and emits `tok-*` inline classes (zero `@codemirror/*` on the read path), mapped incrementally and colored via the `--pp-code-*` palette | `frontend/src/lib/codeHighlight.ts` |
| `code-lang-picker` | Edit-mode-only corner chrome on `code_block` — a button labeled with the resolved language opens a type-to-filter popup over the language registry (plus a "Plain text" row), selection writing `language` via `setNodeMarkup` | `frontend/src/lib/codeBlockView.ts` |
| `code-cm-focus` | Tier-1 CodeMirror-on-focus for `code_block` — while the selection is inside an editable code block it mounts a lazy CM6 editor (real indent/bracket/close, per-language highlighting) over the text surface, syncing bidirectionally with PM via minimal-diff transactions with echo suppression; undo/redo stay PM-owned; all `@codemirror/*` core sits behind the single `cmCore.ts` chunk | `frontend/src/lib/codeBlockView.ts` |
| `tables` | Table family (table / table_row / table_cell / table_header) hand-ported from prosemirror-tables, with a custom `name` attr addressable via `/tables/{name}` | `frontend/src/lib/tables.ts` |
| `task-list` | Checkbox lists (task_list / task_item) — GFM `- [ ]` round-trip, a live checkbox NodeView, and a `/tasks` extractor | `frontend/src/lib/taskItemView.ts` |
| `collab-sse` | Realtime collaboration protocol — client EditorConnection state machine + server SSE stream, step submission with 409/410/400 version semantics and broadcast | `frontend/src/lib/collab.ts` |
| `presence` | Live cursors / presence riding the same SSE channel — selection reporting, remote-cursor decorations, self-filtered by clientID+actorID | `frontend/src/lib/cursors.ts` |
| `permissions` | Per-doc access model — five actions resolved via datasette-acl, the bespoke `locked` read-only edit-deny, owner=Manager seeding, route gating (see docs/PERMISSIONS.md) | `datasette_paper/permissions.py` |
| `snapshot-log` | Storage model — append-only step log + periodic snapshots; the live doc is materialized by replaying the steps_tail over the latest snapshot, with compaction | `datasette_paper/instance.py` |
| `line-boundary` | Cmd/Home + Left/Right move the caret to the *visual* line start/end ourselves, so a line that begins with a link mark can't leak the keystroke to Chromium's Back shortcut | `frontend/src/lib/lineBoundary.ts` |
| `pwa` | Installable home-screen app — a dynamic web app manifest at `/-/paper/manifest.webmanifest`, apple/theme-color `<head>` tags in `paper_base.html`, and packaged icons under `static/icons/` | `datasette_paper/routes/docs.py` |
| `dark-mode` | Per-device Light/Dark/System theme — a `--pp-*` token palette, a FOUC-free head-script resolver that stamps `<html data-theme>` before first paint, and localStorage persistence driven by an index-page cycle button + a doc-header submenu; defaults to light regardless of OS (dark/system are explicit opt-ins) | `frontend/src/lib/theme.ts` |
| `doc-activity` | Durable per-(doc, actor) last-edited attribution — the `_datasette_paper_doc_activity` rollup: upserted on every accepted step at both step-insert sites, survives step compaction, backfilled by m008, purged on doc hard-delete. Currently backs `profile-papers`; built for any "who touched this doc" consumer | `datasette_paper/migrations.py` |
| `profile-papers` | "Papers" section on user-profiles pages — created/recently-edited docs, viewer-acl-filtered, backed by the `doc-activity` rollup | `datasette_paper/routes/docs.py` |
| `last-edited-indicator` | "edited Xm ago by Y" — last-editor attribution on the listing's Updated column and live in the doc header (SSE ride-along + own-send confirm + wall-clock ticker); reads the `doc-activity` rollup, so anonymous edits show time but no name | `frontend/src/lib/DocHeader.svelte` |
| `callout` | GitHub-style admonition block (`> [!NOTE]` family) — a title + body, top-level-only (not in the `block` group; `doc` content overridden to `(block \| callout)+`), five closed kinds clamped defensively, round-trips as a `> [!KIND] Title` marker + `> `-prefixed body | `frontend/src/lib/schema.ts` |
