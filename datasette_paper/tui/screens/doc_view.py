"""DocScreen — a live, read-only view of one paper doc.

A ``VerticalScroll`` of one focusable ``Block`` widget per top-level node of the
materialized ``DocSession.doc``. A block cursor (j/k/arrows) moves focus between
blocks and paints a left accent bar on the current one, matching the web
editor's visual language. The header shows name / version / user count and a
locked / editable chip.

An exclusive SSE worker keeps the view live: each ``update`` batch is applied to
the local Node **while holding ``session.lock``** (the contract in
``client.py`` — it serialises a foreign batch against ticket 04's in-flight
``submit_replace`` so neither clobbers the other), then only the touched block
widgets are rebuilt (the whole list when the block count moves or the batch
touched everything). ``renamed`` / ``state-changed`` / ``permissions-changed``
refresh the header; ``closed`` pops back to the list; a ``GoneError`` from the
event iterator re-bootstraps the doc.

@feat tui: live read-only doc view (per-block widgets + SSE re-render)
"""

from __future__ import annotations

import webbrowser
from typing import Optional

from textual import work
from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.screen import Screen
from textual.widgets import Footer, Static

from ..client import GoneError
from ..prettify import collect_ref_ids
from ..widgets.blocks import Block, make_block


class DocScreen(Screen):
    """Read-only, live-updating view of a single doc."""

    BINDINGS = [
        ("j", "cursor_down", "Down"),
        ("down", "cursor_down", "Down"),
        ("k", "cursor_up", "Up"),
        ("up", "cursor_up", "Up"),
        ("space", "toggle_callout", "Toggle callout"),
        ("o", "open_browser", "Open in browser"),
        ("y", "yank", "Copy markdown"),
        ("escape", "back", "Back"),
    ]

    DEFAULT_CSS = """
    DocScreen { layout: vertical; }
    DocScreen > .doc-header {
        dock: top;
        height: 1;
        padding: 0 1;
        background: $panel;
        color: $text;
    }
    DocScreen > VerticalScroll { height: 1fr; }
    Block {
        border-left: blank;
        padding: 0 1;
        height: auto;
        margin-bottom: 1;
    }
    Block.-cursor { border-left: thick $accent; }
    Block:focus { border-left: thick $accent; }
    Callout {
        border: round $primary;
        padding: 0 1;
        height: auto;
    }
    Callout > .callout-title { text-style: bold; }
    Callout.callout--note { border: round #4c8dff; }
    Callout.callout--tip { border: round #34b158; }
    Callout.callout--important { border: round #a371f7; }
    Callout.callout--warning { border: round #d9a441; }
    Callout.callout--caution { border: round #e5534b; }
    .sql-placeholder {
        border: round $primary-darken-1;
        padding: 0 1;
        height: auto;
        color: $text-muted;
    }
    """

    def __init__(self, client, session, name: Optional[str] = None) -> None:
        super().__init__()
        self.client = client
        self.session = session
        self.doc_id = session.doc_id
        self.doc_name = name or f"Document {session.doc_id}"
        self.blocks: list[Block] = []
        self._cursor = 0
        self._links: dict = {}
        self._actors: dict = {}
        self._sse_worker = None
        self._closing = False

    def compose(self) -> ComposeResult:
        yield Static(id="doc-header", classes="doc-header")
        yield VerticalScroll(id="blocks")
        yield Footer()

    async def on_mount(self) -> None:
        self.container = self.query_one("#blocks", VerticalScroll)
        await self._rebuild()
        self._update_header()
        self._sse_worker = self.run_worker(
            self._consume_sse(), exclusive=True, name="sse"
        )

    def on_unmount(self) -> None:
        # Stop the worker and short-circuit any in-flight event still landing
        # (a buffered SSE batch can race the unmount).
        self._closing = True
        if self._sse_worker is not None:
            self._sse_worker.cancel()

    # --- header -------------------------------------------------------------

    def _update_header(self) -> None:
        if self._closing:
            return
        locked = bool(self.session.permissions.get("locked"))
        if locked:
            chip = "locked"
        elif self.session.can_edit:
            chip = "editable"
        else:
            chip = "read-only"
        users = self.session.users
        header = self.query_one("#doc-header", Static)
        header.update(
            f"{self.doc_name}   v{self.session.version}   "
            f"{users} user{'s' if users != 1 else ''}   [{chip}]"
        )

    # --- block list ---------------------------------------------------------

    async def _resolve_refs(self) -> None:
        """Batch-resolve every wikilink / mention id in the doc once, cached on
        the screen for the prettify pass."""
        doc_ids: set = set()
        actor_ids: set = set()
        for i in range(self.session.block_count()):
            d, a = collect_ref_ids(self.session.block_markdown(i))
            doc_ids.update(d)
            actor_ids.update(a)
        self._links = await self.client.resolve_links(list(doc_ids)) if doc_ids else {}
        self._actors = (
            await self.client.resolve_actors(list(actor_ids)) if actor_ids else {}
        )

    async def _rebuild(self) -> None:
        if self._closing:
            return
        await self._resolve_refs()
        await self.container.remove_children()
        self.blocks = [
            make_block(self.session, i, self._links, self._actors)
            for i in range(self.session.block_count())
        ]
        if self.blocks:
            await self.container.mount(*self.blocks)
        if self._cursor >= len(self.blocks):
            self._cursor = max(0, len(self.blocks) - 1)
        self._focus_cursor()

    async def _apply_touched(self, touched: set) -> None:
        if self._closing:
            return
        count = self.session.block_count()
        if len(self.blocks) != count or touched == set(range(count)):
            await self._rebuild()
            return
        await self._resolve_refs()
        for i in sorted(touched):
            old = self.blocks[i]
            new = make_block(self.session, i, self._links, self._actors)
            await self.container.mount(new, before=old)
            await old.remove()
            self.blocks[i] = new
        self._focus_cursor()

    def _focus_cursor(self) -> None:
        for b in self.blocks:
            b.remove_class("-cursor")
        if self.blocks:
            cur = self.blocks[self._cursor]
            cur.add_class("-cursor")
            cur.focus()
            cur.scroll_visible()

    # --- SSE ----------------------------------------------------------------

    async def _consume_sse(self) -> None:
        while True:
            if self._closing:
                return
            gen = self.session.events()
            try:
                async for ev in gen:
                    await self._handle_event(ev)
                    if ev.kind == "closed":
                        return
                return  # generator returned cleanly
            except GoneError:
                # History evicted — re-bootstrap the doc and rebuild the view.
                await gen.aclose()
                self.session = await self.client.open_doc(self.doc_id)
                await self._rebuild()
                self._update_header()
                continue

    async def _handle_event(self, ev) -> None:
        if self._closing:
            return
        if ev.kind == "update":
            async with self.session.lock:
                touched = self.session.apply_update(ev.data)
            users = ev.data.get("users")
            if users is not None:
                self.session.users = users
            await self._apply_touched(touched)
            self._update_header()
        elif ev.kind == "presence":
            users = ev.data.get("users")
            if users is not None:
                self.session.users = users
                self._update_header()
        elif ev.kind == "renamed":
            self.doc_name = ev.data.get("name") or self.doc_name
            self._update_header()
        elif ev.kind in ("state-changed", "permissions-changed"):
            if "locked" in ev.data:
                self.session.permissions["locked"] = ev.data["locked"]
            if "canEdit" in ev.data:
                self.session.permissions["canEdit"] = ev.data["canEdit"]
            self._update_header()
        elif ev.kind == "closed":
            self.notify("Access to this document was revoked", severity="warning")
            if len(self.app.screen_stack) > 1:
                self.app.pop_screen()

    # --- actions ------------------------------------------------------------

    def action_cursor_down(self) -> None:
        if self._cursor < len(self.blocks) - 1:
            self._cursor += 1
            self._focus_cursor()

    def action_cursor_up(self) -> None:
        if self._cursor > 0:
            self._cursor -= 1
            self._focus_cursor()

    def action_toggle_callout(self) -> None:
        if self.blocks:
            self.blocks[self._cursor].toggle_collapsed()

    def action_open_browser(self) -> None:
        base = str(self.client._http.base_url).rstrip("/")
        webbrowser.open(f"{base}/-/paper/doc/{self.doc_id}")

    @work
    async def action_yank(self) -> None:
        md = await self.client.get_document_markdown(self.doc_id)
        self.app.copy_to_clipboard(md)
        self.notify("Copied document markdown")

    def action_back(self) -> None:
        if len(self.app.screen_stack) > 1:
            self.app.pop_screen()
