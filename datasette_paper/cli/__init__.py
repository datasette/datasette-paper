"""The ``datasette paper`` click group — offline commands over an internal db.

Registered by :func:`datasette_paper.register_commands` (a thin delegate).
One module per subcommand so parallel feature branches don't collide in a
single file: each module defines a plain ``click.command`` and is
registered here with ``add_command`` — adding a command touches one new
file plus one import/register line below. Keep the hookimpl-adjacent
surface import-light: modules in this package only import ``click`` (and
``._common``) at top level, and each command body late-imports its
machinery (``datasette_paper.export`` pulls in prosemirror-py, which must
not load until a command that actually materializes a doc runs).
"""

import click

from .dump import dump
from .export import export
from .list import list_docs


@click.group()
def paper():
    "Commands for datasette-paper"


paper.add_command(dump)
paper.add_command(export)
paper.add_command(list_docs)
