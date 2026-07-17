"""Shared plumbing for ``datasette paper`` subcommands.

Import-light like every module in this package: only click/contextlib at
top level; the export machinery is late-imported when a command actually
opens a database.
"""

from contextlib import contextmanager

import click


@contextmanager
def open_db(path):
    """Yield a read-only connection to *path*'s internal database.

    Maps :class:`datasette_paper.export.ExportError` to
    ``click.ClickException`` for the *whole* ``with`` body, not just the
    open — commands raise/propagate ExportError mid-body (e.g.
    ``load_live_doc`` on a corrupt history) and rely on it becoming a
    clean CLI error. The connection is closed on the way out either way.
    """
    from ..export import ExportError, open_internal_db

    try:
        conn = open_internal_db(path)
        try:
            yield conn
        finally:
            conn.close()
    except ExportError as exc:
        raise click.ClickException(str(exc)) from exc
