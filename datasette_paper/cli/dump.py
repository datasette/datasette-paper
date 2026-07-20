"""``datasette paper dump`` — export every doc to a directory of markdown files."""

import re

import click

from ._common import open_db


def _slug(name):
    """Filesystem-safe slug of *name*: lowercase, runs of non-alphanumerics
    collapsed to ``-``, trimmed, capped at 60 chars. May be empty — the
    caller falls back to a bare ``<id>.md`` (the id prefix already
    guarantees uniqueness, so duplicates need no counter)."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60].rstrip("-")


# @feat cli-dump: register the `datasette paper dump` CLI command
@click.command()
@click.argument("internal_db", type=click.Path(exists=True, dir_okay=False))
@click.argument("out_dir", type=click.Path(file_okay=False))
@click.option(
    "--state",
    "states",
    multiple=True,
    type=click.Choice(["active", "archived", "trashed"]),
    help="States to include (repeatable). Default: active + archived —"
    " trashed docs are pending deletion, so a routine backup only"
    " includes them when opted in explicitly.",
)
def dump(internal_db, out_dir, states):
    """Export every doc to OUT_DIR as `<id>-<slug>.md`.

    INTERNAL_DB is the internal database this Datasette runs with
    (`datasette --internal <path>`). OUT_DIR is created if missing and
    existing files are overwritten — re-dumping into a git checkout is the
    intended backup workflow. Read-only on the database: safe to run
    against a file a live Datasette is currently serving.

    A doc whose history is corrupt prints `FAILED <id> <name>: <msg>` to
    stderr and the run continues; the exit code is 1 if anything failed,
    so a partial backup never looks complete.
    """
    import sys
    from pathlib import Path

    from ..export import ExportError, export_markdown
    from ..sql import _queries

    wanted = set(states) if states else {"active", "archived"}
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    dumped = 0
    failed = 0
    with open_db(internal_db) as conn:
        docs = [doc for doc in _queries.list_docs(conn) if doc.state in wanted]
        for doc in docs:
            # @feat cli-dump: per-doc fail-open — a corrupt doc is reported
            # on stderr and skipped (no partial file), the rest still dump.
            try:
                markdown = export_markdown(conn, doc.id)
            except ExportError as exc:
                click.echo(f"FAILED {doc.id} {doc.name}: {exc}", err=True)
                failed += 1
                continue
            slug = _slug(doc.name)
            filename = f"{doc.id}-{slug}.md" if slug else f"{doc.id}.md"
            (out / filename).write_text(markdown, encoding="utf-8")
            dumped += 1

    click.echo(f"dumped {dumped} docs to {out_dir}, {failed} failed")
    if failed:
        sys.exit(1)
