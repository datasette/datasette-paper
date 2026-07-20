"""``datasette paper tables`` — list/fetch a doc's tables, offline twin of ``/tables``."""

import click

from ._common import open_db


# @feat cli-tables: register the `datasette paper tables` CLI command
@click.command(name="tables")
@click.argument("internal_db", type=click.Path(exists=True, dir_okay=False))
@click.argument("doc_id", type=int)
@click.argument("name", required=False)
@click.option(
    "-f",
    "--format",
    "fmt",
    type=click.Choice(["csv", "json"]),
    default="csv",
    show_default=True,
    help="Output format. With NAME: csv rows or the raw table dict. Without"
    " NAME: json emits the full extract_tables() array instead of the"
    " one-line-per-table listing.",
)
def tables_cmd(internal_db, doc_id, name, fmt):
    """List a doc's tables, or fetch one by NAME as CSV/JSON.

    INTERNAL_DB is the internal database this Datasette runs with
    (`datasette --internal <path>`). DOC_ID is the numeric doc id. Read-only:
    safe to run against a file a live Datasette is currently serving.

    Without NAME, lists every table in document order: position, name (or
    `-` for anonymous), and its row x column shape; `-f json` prints the
    full `extract_tables` array instead. With NAME, prints that table's
    data — CSV by default (header row first iff the table has one), or
    `-f json` for the raw `{name, header, rows, position}` dict. Anonymous
    tables are listable but not fetchable by name, same as `/tables/{name}`.
    If more than one table shares NAME, a warning naming the count goes to
    stderr and the first match (document order) is used — stdout stays
    clean.
    """
    import csv
    import json as json_module
    import sys

    from ..export import load_live_doc
    from ..tables import count_tables_with_name, extract_tables, find_table_by_name

    with open_db(internal_db) as conn:
        doc = load_live_doc(conn, doc_id)

    tables = extract_tables(doc)

    if name is None:
        if fmt == "json":
            click.echo(json_module.dumps(tables, indent=2))
            return
        for t in tables:
            label = t["name"] if t["name"] is not None else "-"
            cols = (
                len(t["header"])
                if t["header"] is not None
                else (len(t["rows"][0]) if t["rows"] else 0)
            )
            click.echo(f"{t['position']}  {label}  {len(t['rows'])}x{cols}")
        return

    name = name.strip()
    if not name:
        raise click.ClickException("NAME must not be empty")

    found = find_table_by_name(doc, name)
    if found is None:
        raise click.ClickException(f"No table named {name!r} in this document")

    duplicates = count_tables_with_name(doc, name)
    if duplicates > 1:
        click.echo(
            f"warning: {duplicates} tables named {name!r}, using first in"
            " document order",
            err=True,
        )

    if fmt == "json":
        click.echo(json_module.dumps(found, indent=2))
        return

    writer = csv.writer(sys.stdout, lineterminator="\n")
    if found["header"] is not None:
        writer.writerow(found["header"])
    for row in found["rows"]:
        writer.writerow(row)
