"""Textual app entry point for the paper TUI.

``PaperApp`` wires a :class:`PaperClient` to the reader screens: the doc browser
(:class:`DocListScreen`) by default, or straight to a live doc view
(:class:`DocScreen`) when a doc id is supplied. Global bindings: ``q`` quits and
``?`` shows the key panel; per-screen bindings live on the screens.

``run`` is the CLI entry the ``datasette paper tui`` command dispatches to
(``datasette_paper/__init__.py``). Importing textual at module top is
deliberate: it makes that command's ``ImportError`` guard fire when the
``[tui]`` extra isn't installed, so a user without textual gets the
``pip install 'datasette-paper[tui]'`` hint rather than a raw traceback.

@feat tui: PaperApp — textual app shell + CLI ``run`` entry point
"""

from __future__ import annotations

import asyncio
from typing import Optional

from textual.app import App

from .client import PaperClient
from .screens.doc_list import DocListScreen
from .screens.doc_view import DocScreen


class PaperApp(App):
    """Terminal reader/editor for paper docs over the HTTP + SSE protocol."""

    TITLE = "datasette-paper"

    BINDINGS = [
        ("q", "quit", "Quit"),
        ("question_mark", "help", "Help"),
    ]

    def __init__(self, client: PaperClient, doc_id: Optional[int] = None) -> None:
        super().__init__()
        self.client = client
        self._initial_doc = doc_id

    async def on_mount(self) -> None:
        if self._initial_doc is not None:
            await self._open_initial_doc(self._initial_doc)
        else:
            await self.push_screen(DocListScreen(self.client))

    async def _open_initial_doc(self, doc_id: int) -> None:
        session = await self.client.open_doc(doc_id)
        # Bootstrap carries no title; resolve it (best-effort) for the header.
        name = None
        try:
            links = await self.client.resolve_links([doc_id])
            entry = links.get(str(doc_id)) or links.get(doc_id) or {}
            name = entry.get("title")
        except Exception:
            pass
        await self.push_screen(DocScreen(self.client, session, name=name))

    def action_help(self) -> None:
        # Textual's built-in key panel when available; a hint otherwise.
        if hasattr(self, "action_show_help_panel"):
            self.action_show_help_panel()
        else:  # pragma: no cover - older textual
            self.notify("Keys: j/k move, Enter open, o browser, y copy, q quit")


def run(url: str, token: Optional[str] = None, doc: Optional[str] = None) -> None:
    """Launch the TUI against ``url`` (the CLI ``run`` entry point)."""
    client = PaperClient(base_url=url, token=token)
    doc_id = int(doc) if doc else None
    app = PaperApp(client, doc_id=doc_id)
    try:
        app.run()
    finally:
        # The app's event loop has ended; close the httpx client in a fresh one.
        try:
            asyncio.run(client.close())
        except Exception:  # pragma: no cover - best-effort cleanup
            pass
