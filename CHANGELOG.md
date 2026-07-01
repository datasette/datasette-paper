# changelog

## 0.0.2a4 (2026-07-01)

A follow-on polish cycle for the data-aware features shipped in `0.0.2a3`:
a right-hand **Sources / Links sidebar**, reworked edit-mode link handling,
a cleaner listing page, and a batch of collab/backlink and editor-input bug
fixes.

### Features

- **Sources / Links sidebar.** A right-hand sidebar surfaces the document's
  `source` blocks (and its Links panel) alongside the editor, so named
  queries are discoverable without scrolling the doc.
- **Reworked edit-mode link UX.** In edit mode a click now opens a plain
  link in a new tab; hovering shows an Edit dialog (URL + Open / Copy)
  instead of the old inline behavior.
- **Value popover can retarget its source.** The inline-value popover now
  lets you switch which `source` a value references, not just which column.
- **Split embed slash command.** The native Datasette embed slash command
  is now two entries — one for tables, one for databases.
- **Polished listing page** (issue
  [#55](https://github.com/datasette/datasette-paper/issues/55)).

### Bug fixes

- Reindex inline `#tags` and links when a doc is created from markdown or a
  template (previously only indexed on later edits).
- Flush pending collab steps on `pagehide` so backlinks survive navigation,
  and refresh the Links panel on tab focus/visibility.
- Fix copy/paste degrading embed / wikilink atoms into plain links.
- Fix `Cmd+Left` triggering browser Back on lines that start with a link.
- Fix the `[[` wikilink popup Enter not committing inside lists.
- Grow the `source` name input to fit its content.

### Internal

- Add `@feat` feature markers + a `FEATURES.md` registry across all
  features (with a `just check-features` sync gate).

### All changes

- Add a right-hand sidebar for Sources (and Links) ([`c1c0d80`](https://github.com/datasette/datasette-paper/commit/c1c0d80))
- Rework edit-mode link UX: click opens in new tab, hover Edit dialog ([`61adc09`](https://github.com/datasette/datasette-paper/commit/61adc09))
- Let the value popover retarget its source, not just the column ([`ce398cb`](https://github.com/datasette/datasette-paper/commit/ce398cb))
- Split the native Datasette embed slash command into table/database ([`b9662d0`](https://github.com/datasette/datasette-paper/commit/b9662d0))
- Polish the listing page ([issue #55](https://github.com/datasette/datasette-paper/issues/55), [`cc4dd56`](https://github.com/datasette/datasette-paper/commit/cc4dd56))
- Grow the source name input to fit its content ([`1444926`](https://github.com/datasette/datasette-paper/commit/1444926))
- Reindex inline tags + links when creating a doc from markdown/template ([`4507148`](https://github.com/datasette/datasette-paper/commit/4507148))
- Fix Cmd+Left triggering browser Back on lines starting with a link ([`73ce4cc`](https://github.com/datasette/datasette-paper/commit/73ce4cc))
- Fix copy/paste degrading embed/wikilink atoms to plain links ([`277dbdb`](https://github.com/datasette/datasette-paper/commit/277dbdb))
- Refresh LinksPanel backlinks on tab focus/visibility ([`81df84c`](https://github.com/datasette/datasette-paper/commit/81df84c))
- Flush pending collab steps on pagehide so backlinks survive navigation ([`452cc91`](https://github.com/datasette/datasette-paper/commit/452cc91))
- Fix `[[` popup Enter not committing inside lists ([`2c15153`](https://github.com/datasette/datasette-paper/commit/2c15153))
- Add @feat feature markers + FEATURES.md registry across all features ([`f9ebca7`](https://github.com/datasette/datasette-paper/commit/f9ebca7))

## 0.0.2a3 (2026-06-29)

This cycle turns paper from a collaborative rich-text editor into a
**data-aware document platform**: papers can reference people (`@mentions`),
be organized with `#tags`, embed live Datasette tables/rows/databases, run
editable SQL, and splice query results inline as formatted values — plus a
round of security hardening and storage/collaboration robustness.

### Features

#### @mentions

`[@Name](paper:/actor/id)` inline atoms. Type `@` for a doc-scoped autocomplete
of the paper's named viewers; mentions render as pills that resolve the live
display name and avatar (gated on `profile_access` — see Migrating).

#### #tags (inline + document-level)

Inline `#tag` atoms with a suggest popup, plus document-level tags for storage,
API access, and list filtering. Inline tags are indexed and clickable, routing
to a per-tag page.

#### Datasette embeds (inline / block)

Embed live Datasette tables, rows, and databases as inline atoms or blocks,
rendered client-side over Datasette's native JSON. Includes a slash/toolbar
embed picker, per-table export menu, and block-embed column filtering. Other
plugins can register their own embed providers — see New APIs.

#### Inline SQL values & source / SQL blocks

A `source` block is a named SQL query; a `value` inline atom references one of
its columns as `${{source.column}}` and renders the result formatted inline.
Standalone SQL query blocks run an editable query into a results table.

#### Slash command menu

A Notion-style `/` command menu with sectioned headers and flat keyboard nav.

#### Wikilink autocomplete

`[[`-triggered page autocomplete, including a "Create … page" row to make a new
doc inline.

#### Auto-updating table of contents

A table-of-contents block that re-derives itself from the document's headings.

### New APIs

For third-party plugins and integrators. Endpoints are under `/-/paper/` and
view/edit-gated as noted in `docs/PERMISSIONS.md`.

**Python plugin hook** (`docs/EMBED_PROVIDERS.md`):

- `paper_embed_provider(datasette)` — pluggy hookspec (project `"datasette"`,
  so implement with `from datasette import hookimpl`) returning one or more
  embed providers. Each provider declares a stable `kind`, lazy-loaded
  `frontend_assets` (a JS bundle that `export default`s the client-side
  provider), and optional `label` / `ref_prefixes` / `resource_url(datasette,
  ref)`. Rendering is entirely client-side; the backend only describes
  providers so paper can `import()` the bundle on demand.

**New HTTP endpoints this cycle:**

- `GET /-/paper/tag/{tag}` — per-tag page.
- `GET /-/paper/api/tags` — list known tags.
- `GET /-/paper/api/tags/{tag}/refs` — docs that carry an inline `#tag`, with
  per-doc occurrence counts (indexed; no body scan).
- `GET /-/paper/api/docs/{doc_id}/tags` — a doc's document-level tags.
- `POST /-/paper/api/docs/{doc_id}/tags/add` · `/tags/remove` · `/tags/replace`
  — mutate a doc's document-level tags.
- `GET /-/paper/api/docs/{doc_id}/mention-search` — `?q=`-filtered mention
  autocomplete over the doc's named viewers.
- `POST /-/paper/api/actors/resolve` — batch-resolve actor ids → display names.

### Migrating

- **Schema migrations run automatically at startup** (`m006` adds the
  document-level tag table; `m007` adds the inline-`#tag` index). They're
  append-only — no manual step.
- **`datasette-plugin-router>=0.0.1a4`** and
  **`datasette-user-profiles>=0.1.0a8`** are now required (see
  `pyproject.toml`).
- **Profile resolution is gated on the `profile_access` action.** Mention
  pills and creator names resolve display names/avatars only when the actor is
  granted `profile_access`; denied lookups degrade to id-only rather than 403.
  If you rely on names/avatars showing, grant `profile_access`.
- **Third-party embed plugins**: the embed dialog API now takes typed `Body()`
  params; implement `paper_embed_provider` per `docs/EMBED_PROVIDERS.md`.

_(Section name TBD — "Upgrade notes" / "Operator notes" also fit.)_

### All changes

- Add @mentions ([#11](https://github.com/datasette/datasette-paper/pull/11))
- Add inline #tags: schema node + suggest popup ([#12](https://github.com/datasette/datasette-paper/pull/12))
- Add document-level tags: storage, API, list filter ([#15](https://github.com/datasette/datasette-paper/pull/15))
- Datasette embeds: schema lock-step (inline_embed + block_embed nodes) ([#16](https://github.com/datasette/datasette-paper/pull/16))
- Datasette embeds: editor integration (NodeViews, dialogs, paste) over native JSON ([#13](https://github.com/datasette/datasette-paper/pull/13))
- Datasette embeds: third-party embed provider JS API + asset hook ([#19](https://github.com/datasette/datasette-paper/pull/19))
- Datasette embeds: provider embed picker (slash → search → insert) ([#20](https://github.com/datasette/datasette-paper/pull/20))
- Sample plugin: demo + tests for custom embed APIs ([#21](https://github.com/datasette/datasette-paper/pull/21))
- Let embed providers supply a custom header icon (raw SVG) ([`710de4b`](https://github.com/datasette/datasette-paper/commit/710de4bd4c22ef18d8ef5cfd73937e385c070318))
- Datasette embeds: typed Body() params replace read_json_body ([`38648a7`](https://github.com/datasette/datasette-paper/commit/38648a7a576c3d7da2a055b7f5642e0564db30c4))
- Add Notion-style / slash command menu + lift ImageDialog into PaperApp ([#18](https://github.com/datasette/datasette-paper/pull/18))
- Slash menu sections: headers + flat nav ([#23](https://github.com/datasette/datasette-paper/pull/23))
- Toolbar embed dropdown ([#26](https://github.com/datasette/datasette-paper/pull/26))
- Table embed: export menu + footer layout ([#22](https://github.com/datasette/datasette-paper/pull/22))
- SQL query block: editable inline query → run → results table ([`869ba2b`](https://github.com/datasette/datasette-paper/commit/869ba2b363dc797831dffbfb13c7ea9b3c758327))
- Inline SQL values ([#28](https://github.com/datasette/datasette-paper/pull/28))
- Inline #tags: tag-search endpoint + clickable navigation ([#25](https://github.com/datasette/datasette-paper/pull/25))
- Images board: size limits, markdown escaping, render robustness ([#24](https://github.com/datasette/datasette-paper/pull/24))
- Consolidate reference encodings under the paper:/ namespace ([#27](https://github.com/datasette/datasette-paper/pull/27))
- Block-embed column filtering (config.columns + Columns… picker) ([#35](https://github.com/datasette/datasette-paper/pull/35))
- Add "Create … page" row to the [[ wikilink autocomplete ([#41](https://github.com/datasette/datasette-paper/pull/41))
- Auto-updating table-of-contents block ([#42](https://github.com/datasette/datasette-paper/pull/42))
- valueView: commit format edits on blur, not per keystroke ([#51](https://github.com/datasette/datasette-paper/pull/51))
- Preserve table names across the markdown round-trip ([#45](https://github.com/datasette/datasette-paper/pull/45))
- Fix lossy markdown round-trips for sql_block and value nodes ([#53](https://github.com/datasette/datasette-paper/pull/53))
- Compact step/snapshot log and index inline-#tag search ([#54](https://github.com/datasette/datasette-paper/pull/54))
- collab: retry bootstrap failures and fix reconnect backoff reset ([#52](https://github.com/datasette/datasette-paper/pull/52))
- Sanitize link/image hrefs in render sink (stored XSS) ([#46](https://github.com/datasette/datasette-paper/pull/46))
- Gate mention-search profile resolution on profile_access ([#44](https://github.com/datasette/datasette-paper/pull/44))
- Gate list_docs creator-profile resolution on profile_access ([`0eaf4fe`](https://github.com/datasette/datasette-paper/commit/0eaf4fe5ca1de87898f4dd2e2ec437a2337d1027))
- Document profile_access gate and new endpoints in PERMISSIONS.md ([#49](https://github.com/datasette/datasette-paper/pull/49))
- Delete link and tag rows in hard_delete_doc ([#43](https://github.com/datasette/datasette-paper/pull/43))
- Drop redundant idx_paper_doc_tag_doc index ([#48](https://github.com/datasette/datasette-paper/pull/48))
- Fix stale tag-page seed fixtures: legacy tag: scheme → paper:/tag/ ([`76e705e`](https://github.com/datasette/datasette-paper/commit/76e705e213b7ceda0358f037a9c25f642357b811))
- Fix stale comments: paper:/ ref scheme + ensure_paper_list ([#47](https://github.com/datasette/datasette-paper/pull/47))
- Bump datasette-plugin-router to 0.0.1a4; drop presence 400 xfail ([`a8d97b1`](https://github.com/datasette/datasette-paper/commit/a8d97b19c0a3dfed65a189becea07b716b4033fe))
- Extract ProseMirror editor styles into editor.css ([`2e6d76e`](https://github.com/datasette/datasette-paper/commit/2e6d76e9ed1d57438d55f71916333c3b48655dcc))
- Dedup markdown_parser split-twins + instance poison guard ([#29](https://github.com/datasette/datasette-paper/pull/29))
- Collapse db.py passthrough wrappers; drop dead select_max_version ([#30](https://github.com/datasette/datasette-paper/pull/30))
- Add shared pytest fixtures; dedup per-file test helpers ([#31](https://github.com/datasette/datasette-paper/pull/31))
- Simplify collab.ts — postJson, flatten input rules, drop repeat ([#32](https://github.com/datasette/datasette-paper/pull/32))
- Dedup embeds/tables helpers: paste preamble, iconMarkup, footer ([#33](https://github.com/datasette/datasette-paper/pull/33))
- Refactor screenshot harness: modules + one file per shot ([#40](https://github.com/datasette/datasette-paper/pull/40))

## 0.0.2a2

Previous tagged release.
