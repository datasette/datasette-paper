# Installation

Install `datasette-paper` in the same environment as Datasette:

```bash
datasette install datasette-paper
```

## Quickstart

No user database is required — papers live in Datasette's internal database.
Pass `--internal <path>` so a real file backs it (see
[Persisting papers](#persisting-papers) below), and grant the one global
permission new papers need:

```bash
datasette --internal papers.db \
  -s permissions.datasette-paper-create true
```

That's enough to create papers as the signed-in actor (e.g. Datasette's
`--root` link) — the creator automatically gets full access to their own
paper. See [Configuration](configuration.md) and
[Permissions](permissions/index.md) for how per-paper view/edit access is
actually resolved (it isn't a global setting).

(persisting-papers)=
## Persisting papers

**Pass `--internal <path>` to persist papers across restarts.** Without it,
Datasette uses an ephemeral tempfile for the internal database that is
deleted when the process exits. The plugin emits a startup warning when it
detects this, so you don't lose your papers to a forgotten flag.

:::{note}
TODO: confirm whether `datasette paper serve` (a dedicated launcher
subcommand) has shipped — it isn't in `FEATURES.md`'s `cli-*` rows yet, so
this page only documents running the plugin through the regular `datasette`
command.
:::
