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

``_sql_cache`` (``{(db, sql): SqlResult}``) is owned here, not by any one
block widget, and threaded through every ``make_block`` call — it survives
block rebuilds (an SSE re-render constructs fresh widget instances), so a
``sql_block``/``source`` that was already run shows its cached result again
without a second network call (see ``widgets/sql_block.py``).

@feat tui: live read-only doc view (per-block widgets + SSE re-render)
"""

from __future__ import annotations

import copy
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
from .edit_modal import ConfirmModal, EditModal, TaskPickerModal

# The DocScreen actions that mutate the doc — hidden + refused when the doc is
# read-only or locked (see check_action / _editing_enabled).
_EDIT_ACTIONS = frozenset({"edit_block", "delete_block", "append_block", "rename_doc"})


def _task_item_labels(node_json: dict) -> list:
    """Short text labels for a task_list block's task items (for the picker)."""
    labels = []
    for child in node_json.get("content") or []:
        if child.get("type") != "task_item":
            continue
        text = ""
        for para in child.get("content") or []:
            for inline in para.get("content") or []:
                text += inline.get("text", "")
        mark = "x" if (child.get("attrs") or {}).get("checked") else " "
        labels.append(f"[{mark}] {text.strip()}"[:50])
    return labels


class DocScreen(Screen):
    """Read-only, live-updating view of a single doc."""

    BINDINGS = [
        ("j", "cursor_down", "Down"),
        ("down", "cursor_down", "Down"),
        ("k", "cursor_up", "Up"),
        ("up", "cursor_up", "Up"),
        ("space", "toggle_callout", "Toggle / check"),
        ("enter", "run_block", "Run SQL"),
        ("ctrl+r", "run_block", "Run SQL"),
        # `e` edits any block (including a sql_block/source's SQL); Enter is
        # kept for running SQL blocks so the two never clash.
        ("e", "edit_block", "Edit"),
        ("d", "delete_block", "Delete"),
        ("a", "append_block", "Append"),
        ("r", "rename_doc", "Rename"),
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
    SqlRunnerBlock {
        border: round $primary-darken-1;
        padding: 0 1;
        height: auto;
    }
    .sql-block-header { text-style: bold; color: $text-muted; }
    .sql-block-body { height: auto; }
    .sql-block-status { color: $text-muted; height: auto; }
    #sql-results { height: auto; max-height: 16; }
    BlockEmbedBlock {
        border: round $primary-darken-1;
        padding: 0 1;
        height: auto;
    }
    .embed-header { text-style: bold; color: $text-muted; }
    .embed-status { color: $text-muted; height: auto; }
    #embed-body { height: auto; max-height: 16; }
    """

    def __init__(self, client, session, name: Optional[str] = None) -> None:
        super().__init__()
        self.client = client
        self.session = session
        # (db, sql) -> SqlResult, shared across block rebuilds — see the
        # module docstring and widgets/sql_block.py.
        self._sql_cache: dict = {}
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
            make_block(
                self.session,
                i,
                self._links,
                self._actors,
                client=self.client,
                sql_cache=self._sql_cache,
            )
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
            new = make_block(
                self.session,
                i,
                self._links,
                self._actors,
                client=self.client,
                sql_cache=self._sql_cache,
            )
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
            # Edit bindings are gated on the freshest permissions — re-evaluate
            # check_action so the footer shows/hides them after the change.
            self.refresh_bindings()
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
        # Space is overloaded: it collapses a callout locally (no step), or —
        # on a task_list block — toggles a checkbox (a real collab edit). The
        # callout path stays synchronous; the task edit is offloaded to a
        # worker so this handler never blocks.
        if not self.blocks:
            return
        block = self.blocks[self._cursor]
        if block.node_type == "task_list":
            if self._editing_enabled():
                self.run_worker(self._toggle_task(self._cursor), exclusive=False)
            return
        block.toggle_collapsed()

    # @feat tui: sql_block/source live widget — Enter/ctrl+r runs, cached by (db, sql)
    @work
    async def action_run_block(self) -> None:
        await self._run_current_block()

    async def _run_current_block(self) -> None:
        if self.blocks:
            await self.blocks[self._cursor].run_query()

    # --- editing ------------------------------------------------------------

    def _editing_enabled(self) -> bool:
        return self.session.can_edit and not self.session.permissions.get("locked")

    def check_action(self, action: str, parameters):
        """Hide (and disable) the doc-mutating bindings when the doc is
        read-only or locked. Re-evaluated per keypress and refreshed by
        ``refresh_bindings`` when a permissions-changed SSE event lands."""
        if action in _EDIT_ACTIONS and not self._editing_enabled():
            return False
        return True

    async def _rebootstrap(self) -> None:
        """410 recovery for a write: re-open the doc and rebuild the view."""
        self.session = await self.client.open_doc(self.doc_id)
        await self._rebuild()
        self._update_header()

    # @feat tui: DocScreen edit binding — `e` opens the block editor modal
    @work
    async def action_edit_block(self) -> None:
        if not self._editing_enabled() or not self.blocks:
            return
        i = self._cursor
        old_json = self.session.doc.child(i).to_json()
        raw = self.session.block_markdown(i)
        result = await self.app.push_screen_wait(
            EditModal(self.session, i, old_json, raw)
        )
        # "saved" and "reload" both mean the doc advanced — rebuild wholesale
        # (a save may split one block into several or delete it). Cancel → None.
        if result is not None:
            await self._rebuild()
            self._update_header()

    @work
    async def action_delete_block(self) -> None:
        if not self._editing_enabled() or not self.blocks:
            return
        ok = await self.app.push_screen_wait(ConfirmModal("Delete this block?"))
        if not ok:
            return
        i = self._cursor
        old_json = self.session.doc.child(i).to_json()
        try:
            result = await self.session.save_block(
                i, old_json, "", confirmed_delete=True
            )
        except GoneError:
            await self._rebootstrap()
            return
        if result.kind == "changed_remotely":
            self.notify("Block changed remotely; not deleted", severity="warning")
        await self._rebuild()
        self._update_header()

    @work
    async def action_append_block(self) -> None:
        if not self._editing_enabled():
            return
        # Imported lazily to avoid a screens import cycle (doc_list imports us).
        from .doc_list import PromptModal

        md = await self.app.push_screen_wait(PromptModal("Append markdown"))
        if not md:
            return
        # The server appends and broadcasts; the SSE worker lands the new block.
        await self.client.append(self.doc_id, md)

    @work
    async def action_rename_doc(self) -> None:
        if not self._editing_enabled():
            return
        from .doc_list import PromptModal

        new_name = await self.app.push_screen_wait(
            PromptModal("Rename document", initial=self.doc_name)
        )
        if not new_name:
            return
        await self.client.rename(self.doc_id, new_name)
        self.doc_name = new_name
        self._update_header()

    async def _toggle_task(self, i: int) -> None:
        """Flip a task_item's ``checked`` in block ``i`` and save it as a step,
        reusing the same locate + submit path as a text edit (no markdown
        round-trip). With one item it toggles that item; with several it opens a
        numbered picker (cursor-within-block isn't tracked)."""
        if i >= self.session.block_count():
            return
        node_json = self.session.doc.child(i).to_json()
        items = node_json.get("content") or []
        task_positions = [
            k for k, c in enumerate(items) if c.get("type") == "task_item"
        ]
        if not task_positions:
            return
        if len(task_positions) == 1:
            which = 0
        else:
            which = await self.app.push_screen_wait(
                TaskPickerModal(_task_item_labels(node_json))
            )
            if which is None:
                return
        target = task_positions[which]
        new_json = copy.deepcopy(node_json)
        attrs = new_json["content"][target].setdefault("attrs", {})
        attrs["checked"] = not bool(attrs.get("checked"))
        try:
            result = await self.session.save_block_json(i, node_json, [new_json])
        except GoneError:
            await self._rebootstrap()
            return
        if result.kind == "changed_remotely":
            self.notify("Task list changed remotely", severity="warning")
        await self._rebuild()
        self._update_header()

    def action_open_browser(self) -> None:
        base = str(self.client._http.base_url).rstrip("/")
        url = None
        if self.blocks:
            url = self.blocks[self._cursor].browser_url(base)
        webbrowser.open(url or f"{base}/-/paper/doc/{self.doc_id}")

    @work
    async def action_yank(self) -> None:
        md = await self.client.get_document_markdown(self.doc_id)
        self.app.copy_to_clipboard(md)
        self.notify("Copied document markdown")

    def action_back(self) -> None:
        if len(self.app.screen_stack) > 1:
            self.app.pop_screen()
