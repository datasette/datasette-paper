"""Textual app entry point for the paper TUI.

Ticket 02 builds the real screens (doc list + live doc view); this is the
placeholder ``run`` the CLI command dispatches to. Importing textual at module
top is deliberate: it makes the CLI command's ``ImportError`` guard fire when
the ``[tui]`` extra isn't installed, so a user without textual gets the
``pip install 'datasette-paper[tui]'`` hint rather than a raw traceback.
"""

from __future__ import annotations

from typing import Optional

from textual.app import App  # noqa: F401  (import guard for the [tui] extra)


def run(url: str, token: Optional[str] = None, doc: Optional[str] = None) -> None:
    """Launch the TUI against ``url``. Not built yet — ticket 02."""
    raise NotImplementedError(
        "The paper TUI is not implemented yet (ticket 02). "
        f"Would connect to {url}" + (f" and open doc {doc}" if doc else "") + "."
    )
