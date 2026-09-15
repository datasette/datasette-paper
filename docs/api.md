# API

JSON API rooted at `/-/paper/api/...` — no per-database segment, since every
paper lives in Datasette's internal database. All endpoints below are gated
by [permissions](permissions/index.md) (`paper-view` / `paper-edit` /
`paper-manage`, resolved per paper).

## Documents

| Method & path | What |
|---|---|
| `GET /-/paper/api/docs` | List papers viewable by the actor. Query params: `state` (`active` default, `archived`, `trashed`), `kind` (`doc` default, `template`, `all`), repeatable `tag`. |
| `POST /-/paper/api/docs` | Create a paper. Body: `{"name": ..., "kind": "doc"|"template", "template_id"?, "content"?, "content_type"?}`. `template_id` instantiates from a template (placeholders substituted server-side); `content` (markdown) seeds the initial snapshot instead — the two are mutually exclusive. |
| `GET /-/paper/api/docs/{doc_id}` | Bootstrap payload for opening a paper (id, name, version, timestamps). |
| `GET /-/paper/api/docs/{doc_id}/document` | The materialized live document. `Accept: text/markdown` returns raw markdown instead of the JSON envelope (`{id, name, version, snapshot_version, pending_steps, content_markdown, ...}`). |
| `POST /-/paper/api/docs/{doc_id}/append` | Append markdown to the end of a paper as one collab step (parsed via the [markdown parser](#markdown-in-and-out), broadcast to any live editors over SSE). Body: `{"content": "<markdown>", "content_type": "markdown"}`. |
| `POST /-/paper/api/docs/{doc_id}/rename` | Rename a paper. |
| `POST /-/paper/api/docs/{doc_id}/archive` / `/unarchive` / `/trash` / `/restore` | Move a paper between `active` / `archived` / `trashed` state. |
| `POST /-/paper/api/docs/{doc_id}/lock` / `/unlock` | Toggle the read-only `locked` flag (denies `paper-edit` while set). |
| `POST /-/paper/api/docs/{doc_id}/make_template` / `/unmake_template` | Convert a paper to/from `kind="template"`. |
| `POST /-/paper/api/docs/{doc_id}/snapshot` | Force a snapshot compaction. |

## Reading structured content

| Method & path | What |
|---|---|
| `GET /-/paper/api/docs/{doc_id}/tasks` | The paper's task items (`extract_tasks`). Query param `status`: `all` (default), `open`, `done`. |
| `GET /-/paper/api/docs/{doc_id}/tables` | Every named/anonymous table in the doc, with shape but no row data. |
| `GET /-/paper/api/docs/{doc_id}/tables/{name}` | One table's data by its `name` attribute (first match; `duplicates` reports collisions). |

## Links, mentions, tags

| Method & path | What |
|---|---|
| `GET /-/paper/api/link-search` | `[[`-autocomplete: search papers by title. |
| `POST /-/paper/api/links/resolve` | Resolve a batch of paper ids to titles (for rendering existing `[[links]]`). |
| `GET /-/paper/api/docs/{doc_id}/links` / `/backlinks` | Forward / backward `[[wikilink]]` edges for a paper. |
| `GET /-/paper/api/links/graph` | The full viewable link graph (nodes + edges), backing the [link graph](editor.md) view. |
| `GET /-/paper/api/docs/{doc_id}/mention-search` | `@`-autocomplete: search actors to mention. |
| `POST /-/paper/api/actors/resolve` | Resolve a batch of actor ids to display name + avatar. |
| `GET /-/paper/api/docs/{doc_id}/tags` | Document-level metadata tags. |
| `POST /-/paper/api/docs/{doc_id}/tags/add` / `/remove` / `/replace` | Mutate a paper's metadata tags. |
| `GET /-/paper/api/tags` | Every tag in use, across viewable papers. |
| `GET /-/paper/api/tags/{tag}/refs` | Every paper whose body mentions an inline `#tag`. |

## Profile / cross-paper views

| Method & path | What |
|---|---|
| `GET /-/paper/api/profile/{actor}/docs` | Papers that actor created or recently edited, viewer-filtered — backs the [profile integration](configuration.md#profile-integration). |
| `GET /-/paper/api/profile/{actor}/todos` | That actor's assigned task items across every viewable paper, viewer-filtered — backs the profile TODOs section and `/-/paper/todos`. |

## Sharing

Sharing itself is owned by [datasette-acl](https://github.com/datasette/datasette-acl) —
the `<datasette-acl-share-dialog>` component grants/updates/revokes access
directly against acl's own JSON API, not a paper-specific endpoint. Paper
exposes one supporting route, `POST /-/paper/api/docs/{doc_id}/sweep-subscribers`,
which disconnects any open SSE subscribers whose access was just revoked
(acl can't reach into an open connection itself). See
[Permissions](permissions/index.md) for the full model.

## Collaboration protocol (SSE)

`GET /-/paper/api/docs/{doc_id}/events` opens a Server-Sent Events stream —
the sync transport for the collaborative editor. Query params: `version`
(the client's last-seen version) and, for browser clients, `client_id`.

The reference [ProseMirror collab server](https://prosemirror.net/docs/guide/#collab)
protocol is long-poll; this plugin swaps that for SSE, which changes how
version conflicts surface:

- **409** (Conflict) — the submitted step batch is stale; catch up (re-fetch
  events since your version) and retry.
- **410** (Gone) — the requested backlog has been evicted by snapshot
  compaction; a full re-bootstrap is required. **Exception:** if the GET
  request included `client_id`, the server sends a `reset` SSE event instead
  of a raw 410 — native `EventSource` hides HTTP status codes from page
  script, so in-band signalling is the only way a browser client can react.
- **400** (Bad version) — the requested version is out of range.

On top of that, the SSE GET adds two in-band event types beyond plain step
broadcasts:

- `ready` — sent once, right after the catch-up backlog, so clients know
  they're caught up and can start submitting local edits (they hold pending
  sends until it arrives).
- `reset` — sent instead of a 410 when the client supplied `client_id` (see
  above); the client should discard local state and re-bootstrap from
  `GET /-/paper/api/docs/{doc_id}`.

Step submission is `POST /-/paper/api/docs/{doc_id}/events`, body
`{"version": N, "client_id": ..., "steps": [...]}` — returns `409` / `400` /
`410` with the same semantics, or `{"version": new_version}` on success.

`POST /-/paper/api/docs/{doc_id}/presence` records a client's caret/selection
and broadcasts it to other subscribers over the same SSE channel (`204` on
success).

## Markdown in and out

Every paper round-trips through Markdown:

- **Out:** `GET /-/paper/api/docs/{doc_id}/document` with
  `Accept: text/markdown`, or the doc header's "Copy as markdown" button, or
  the CLI's `export` / `dump` commands — all go through
  `datasette_paper/markdown.py`'s serializer, so they're byte-identical.
- **In:** `POST /-/paper/api/docs` with a `content` field, or
  `POST /-/paper/api/docs/{doc_id}/append` — both go through
  `datasette_paper/markdown_parser.py` (`markdown_to_doc` /
  `markdown_to_fragment`). The parser is intentionally lossy for content
  outside the schema (raw HTML renders as plain text, unknown inline kinds
  drop) since it can only emit nodes the schema accepts.

See [Sources and values](sources-and-values.md) for the ` ```source ` /
`${{source.column}}` markdown syntax, and [CLI](cli.md) for the offline
(no-server) equivalents of several of these endpoints.
