"""``datasette paper list`` — enumerate every doc in an internal database."""

import click

from ._common import open_db


# @feat cli-list: register the `datasette paper list` CLI command
@click.command(name="list")
@click.argument("internal_db", type=click.Path(exists=True, dir_okay=False))
@click.option(
    "--state",
    "states",
    multiple=True,
    type=click.Choice(["active", "archived", "trashed"]),
    help="Filter by state (repeatable). Default: all states.",
)
@click.option("--json", "as_json", is_flag=True, help="Emit full doc rows as JSON.")
def list_docs(internal_db, states, as_json):
    """List every doc in an internal database.

    INTERNAL_DB is the internal database this Datasette runs with
    (`datasette --internal <path>`). Read-only: safe to run against a file
    a live Datasette is currently serving. There is no server-side
    equivalent of unfiltered discovery — the doc index only ever shows a
    subset by state/kind — so this is the offline way to find a doc id
    before `export`.
    """
    import json as json_module
    from dataclasses import asdict

    from ..sql import _queries

    with open_db(internal_db) as conn:
        docs = _queries.list_docs(conn)

    if states:
        wanted = set(states)
        docs = [doc for doc in docs if doc.state in wanted]

    if as_json:
        click.echo(json_module.dumps([asdict(doc) for doc in docs], indent=2))
        return

    header = ("ID", "NAME", "STATE", "KIND", "VERSION", "UPDATED")
    rows = [
        (
            str(doc.id),
            doc.name,
            doc.state,
            doc.kind,
            str(doc.current_version),
            doc.updated_at,
        )
        for doc in docs
    ]
    widths = [max(len(row[i]) for row in ([header] + rows)) for i in range(len(header))]
    for row in [header] + rows:
        click.echo("  ".join(cell.ljust(width) for cell, width in zip(row, widths)))
