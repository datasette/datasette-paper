"""``datasette paper export`` — print one doc to stdout as markdown."""

import click

from ._common import open_db


# @feat cli-export: register the `datasette paper export` CLI command
@click.command()
@click.argument("internal_db", type=click.Path(exists=True, dir_okay=False))
@click.argument("doc_id", type=int)
@click.option(
    "-f",
    "--format",
    "fmt",
    type=click.Choice(["markdown"]),
    default="markdown",
    show_default=True,
    help="Output format",
)
def export(internal_db, doc_id, fmt):
    """Print one paper doc to stdout.

    INTERNAL_DB is the internal database this Datasette runs with
    (`datasette --internal <path>` — papers live there, not in a content
    database). DOC_ID is the numeric id from the doc's URL. Read-only:
    safe to run against a file a live Datasette is currently serving.
    """
    from ..export import export_markdown

    with open_db(internal_db) as conn:
        click.echo(export_markdown(conn, doc_id), nl=False)
