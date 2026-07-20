"""``datasette paper check`` — bulk integrity check: would every doc export cleanly?"""

import click

from ._common import open_db


# @feat cli-check: register the `datasette paper check` CLI command
@click.command()
@click.argument("internal_db", type=click.Path(exists=True, dir_okay=False))
@click.option(
    "--doc-id",
    "doc_id",
    type=int,
    default=None,
    help="Check a single doc instead of sweeping every doc.",
)
def check(internal_db, doc_id):
    """Materialize every doc and report which would export cleanly.

    INTERNAL_DB is the internal database this Datasette runs with
    (`datasette --internal <path>`). Every doc is checked regardless of
    state or kind — integrity is state-independent, and trashed docs can
    still be restored. Read-only: safe to run against a file a live
    Datasette is currently serving. One line per doc — `ok <id> <name>
    (version <n>)` or `FAIL <id> <name>: <message>` — then a
    `checked N docs, M failed` summary; exit 1 if anything failed.

    Cost: this fully materializes every doc through prosemirror-py — a
    maintenance command, not a lightweight health probe.
    """
    import sys

    from ..export import ExportError, load_live_doc
    from ..sql import _queries

    checked = 0
    failed = 0
    with open_db(internal_db) as conn:
        if doc_id is not None:
            ids = [doc_id]
        else:
            ids = [row.id for row in _queries.select_all_doc_ids(conn)]
        for one_id in ids:
            row = _queries.select_doc_by_id(conn, doc_id=one_id)
            name = row.name if row is not None else "?"
            checked += 1
            # @feat cli-check: load_live_doc is the actual integrity probe —
            # it fail-closes on gaps, truncation, snapshot parse errors,
            # schema mismatch, and steps that raise or fail to apply.
            try:
                load_live_doc(conn, one_id)
            except ExportError as exc:
                click.echo(f"FAIL {one_id} {name}: {exc}")
                failed += 1
            else:
                click.echo(f"ok {one_id} {name} (version {row.current_version})")

    click.echo(f"checked {checked} docs, {failed} failed")
    if failed:
        sys.exit(1)
