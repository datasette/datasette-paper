# Changelog

## 0.0.2a3 (unreleased)

This cycle adds rich linking, embedding, and inline-data primitives to the
editor, plus a round of dedup/refactor work. Highlights:

### @mentions

- Add `@mentions`: schema node, suggest popup, and resolution. (#11)

### #tags (inline + document-level)

- Add inline `#tags` as a schema node with a suggest popup. (#12)
- Add document-level tags: storage, API, and list filtering. (#15)
- Inline `#tags` tag-search endpoint with clickable navigation. (#25)
- Add the `GET /-/paper/tag/{tag}` tag page route (reflected in
  `frontend/api.d.ts`); fix stale tag-page seed fixtures (legacy `tag:`
  scheme → `paper:/tag/`).

### Datasette embeds (inline / block) + third-party providers

- Datasette embeds: schema lock-step adding `inline_embed` and
  `block_embed` nodes. (#16)
- Editor integration: NodeViews, dialogs, and paste handling over
  Datasette's native JSON. (#13)
- Third-party embed provider JS API + asset hook. (#19)
- Provider embed picker (slash → search → insert). (#20)
- Sample plugin demonstrating custom embed APIs, with tests. (#21)
- Embed providers can supply a custom header icon (raw SVG).
- Toolbar embed dropdown. (#26)
- Table embed: export menu + footer layout. (#22)
- Block-embed column filtering (`config.columns` + a Columns… picker). (#35)
- Datasette embeds: typed `Body()` params replace `read_json_body`.

### Inline SQL values + source / SQL blocks

- Inline SQL values: a `source` block (named query) referenced by a
  `value` inline atom as `${{source.column}}`. (#28)
- SQL query block: editable inline query → run → results table.

### Slash menu

- Add a Notion-style `/` slash command menu; lift `ImageDialog` into
  `PaperApp`. (#18)
- Slash menu sections: headers + flat keyboard nav. (#23)

### Wikilink autocomplete

- Add a "Create … page" row to the `[[` wikilink autocomplete. (#41)

### Other editor work

- Auto-updating table-of-contents block. (#42)
- Images board: size limits, markdown escaping, render robustness. (#24)
- Consolidate reference encodings under the `paper:/` namespace. (#27)
- Extract ProseMirror editor styles into `editor.css`.
- Gate `list_docs` creator-profile resolution on `profile_access`.
- Bump `datasette-plugin-router` to `0.0.1a4`; drop the presence 400 xfail.

### Refactors / dedup

- Dedup embeds/tables helpers: paste preamble, `iconMarkup`, footer. (#33)
- Simplify `collab.ts`: `postJson`, flattened input rules, drop repeat. (#32)
- Add shared pytest fixtures; dedup per-file test helpers. (#31)
- Collapse `db.py` passthrough wrappers; drop dead `select_max_version`. (#30)
- Dedup `markdown_parser` split-twins + instance poison guard. (#29)
- Refactor screenshot harness: modules + one file per shot. (#40)

## 0.0.2a2

Previous tagged release.
