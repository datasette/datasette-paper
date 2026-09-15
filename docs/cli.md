# CLI

`datasette paper <command> ...` — offline tools that read a paper's internal
database directly, with no Datasette process running. Every command is
read-only and safe to run against a file a live Datasette is currently
serving (`--internal <path>`). Most commands take that path as `INTERNAL_DB`.

## `export`

```bash
datasette paper export INTERNAL_DB DOC_ID [-f markdown]
```

Prints one paper to stdout as markdown. `-f`/`--format` currently only
accepts `markdown` (more formats later). Output is byte-identical to the
editor's "Copy as markdown" button and the `document` API's markdown
response.

## `list`

```bash
datasette paper list INTERNAL_DB [--state active|archived|trashed]... [--json]
```

Enumerates every paper. `--state` is repeatable and filters (default: all
states) — the offline way to find a paper's id before `export`. Default
output is an aligned `ID  NAME  STATE  KIND  VERSION  UPDATED` table;
`--json` emits the full doc rows.

## `dump`

```bash
datasette paper dump INTERNAL_DB OUT_DIR [--state active|archived|trashed]...
```

Writes every paper to `OUT_DIR` as `<id>-<slug>.md` (directory created if
missing, files overwritten — the backup / git-mirror workflow). Default
state set is `active` + `archived` (`trashed` is opt-in, since those papers
are pending deletion). A corrupt paper prints `FAILED <id> <name>: <msg>` to
stderr and the run continues; exits `1` if anything failed, so a partial
backup never looks complete.

## `check`

```bash
datasette paper check INTERNAL_DB [--doc-id N]
```

Sweeps every paper (regardless of state/kind — trashed papers can still be
restored) through the same integrity path `export` uses, without printing
content. One line per paper — `ok <id> <name> (version <n>)` or
`FAIL <id> <name>: <message>` — then a `checked N docs, M failed` summary;
exits `1` if anything failed. This fully materializes every document through
`prosemirror-py`, so it's a maintenance command, not a lightweight health
probe.

## `info`

```bash
datasette paper info INTERNAL_DB DOC_ID [--json]
```

Reports one paper's row plus history stats (snapshot version, step-tail
length, total step/snapshot row counts) from a single read transaction —
never materializes the document. A step tail that doesn't reach the paper's
`current_version` prints a warning instead of failing.

## `tables`

```bash
datasette paper tables INTERNAL_DB DOC_ID [NAME] [-f csv|json]
```

Offline twin of the `tables` / `tables/{name}` API. Without `NAME`, lists
every table in document order (position, name or `-` for anonymous, row ×
column shape); `-f json` prints the full array instead. With `NAME`, prints
that table's data — CSV by default (header row first iff the table has
one), or `-f json` for the raw dict. If more than one table shares `NAME`, a
warning goes to stderr and the first match (document order) is used.

## `tasks`

```bash
datasette paper tasks INTERNAL_DB [DOC_ID] [-f json|markdown]
```

Offline twin of the `tasks` API. `DOC_ID` prints one paper's task items;
omitted, it sweeps every active `kind='doc'` paper (the same scoping the
profile TODOs page uses). `-f json` (default) matches the API's `tasks` list
shape byte-for-byte; `-f markdown` renders a `- [ ]`/`- [x]` checklist
indented two spaces per depth (grouped under `## <doc name>` headings when
sweeping, skipping papers with no tasks).

:::{note}
TODO: confirm whether a `datasette paper serve` launcher subcommand exists —
`FEATURES.md` has no `cli-serve` row as of this writing, so it isn't
documented here.
:::
