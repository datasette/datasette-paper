"""The ``datasette paper`` click group.

Mostly offline commands over an internal db file, plus one server:
``serve`` launches an in-process local single-user instance (see
``serve.py``; the same command object doubles as the ``datasette-paper``
console script via ``[project.scripts]``).

Registered by :func:`datasette_paper.register_commands` (a thin delegate).
One module per subcommand so parallel feature branches don't collide in a
single file: each module defines a plain ``click.command`` and is
registered here with ``add_command`` — adding a command touches one new
file plus one import/register line below. Keep the hookimpl-adjacent
surface import-light: modules in this package only import ``click`` (and
``._common``) at top level — ``serve.py`` adds ``datasette.hookimpl``,
documented there — and each command body late-imports its machinery
(``datasette_paper.export`` pulls in prosemirror-py, which must not load
until a command that actually materializes a doc runs).
"""

import click

from .check import check
from .dump import dump
from .export import export
from .info import info
from .list import list_docs

# Import the command under a distinct name: binding it as `serve` here
# would overwrite the package's `serve` *submodule* attribute (set by the
# import machinery), breaking `import datasette_paper.cli.serve`.
from .serve import serve as serve_cmd
from .tables import tables_cmd
from .tasks import tasks


@click.group()
def paper():
    "Commands for datasette-paper"


paper.add_command(check)
paper.add_command(dump)
paper.add_command(export)
paper.add_command(info)
paper.add_command(list_docs)
paper.add_command(serve_cmd)
paper.add_command(tables_cmd)
paper.add_command(tasks)
