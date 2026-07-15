"""EditModal — the block-editing modal (ticket 04's write path front end).

A single top-level block is edited as markdown in a ``TextArea`` seeded with
the block's *raw* serializer output (``DocSession.block_markdown`` — never the
prettified display text the reader shows, so canonical atom forms like
``[[3]]`` / ``@alice`` / ``${{q.total}}`` survive the round-trip). ``ctrl+s``
saves via ``DocSession.save_block``; Escape cancels (confirming first if the
buffer is dirty).

The save path is the only thing that relocates the block against the live doc
— the modal itself never re-seeds while the DocScreen's SSE worker keeps
advancing the session. Three save outcomes are handled here:

* ``saved`` → dismiss with the result so the screen rebuilds;
* ``needs_delete_confirm`` (the buffer parsed to nothing) → a confirm dialog,
  then re-save as a real deletion;
* ``changed_remotely`` → an in-modal conflict panel (theirs vs. mine) offering
  keep-mine / take-theirs / back-to-editing.

@feat tui: EditModal — block markdown editor + save + conflict resolution
"""

from __future__ import annotations

from typing import Optional

from textual import work
from textual.app import ComposeResult
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Label, Static, TextArea

from ..client import (
    ForbiddenError,
    GoneError,
    InvalidStepError,
    PaperError,
    SaveResult,
)


class ConfirmModal(ModalScreen[bool]):
    """A yes/no confirmation; dismisses ``True`` (y / Enter) or ``False``."""

    BINDINGS = [
        ("y", "confirm", "Yes"),
        ("enter", "confirm", "Yes"),
        ("n", "cancel", "No"),
        ("escape", "cancel", "No"),
    ]

    DEFAULT_CSS = """
    ConfirmModal { align: center middle; }
    ConfirmModal > Vertical {
        width: 60;
        height: auto;
        padding: 1 2;
        border: round $warning;
        background: $panel;
    }
    """

    def __init__(self, prompt: str) -> None:
        super().__init__()
        self._prompt = prompt

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Label(self._prompt)
            yield Label("y: yes   n: no", classes="confirm-hint")

    def action_confirm(self) -> None:
        self.dismiss(True)

    def action_cancel(self) -> None:
        self.dismiss(False)


class TaskPickerModal(ModalScreen[Optional[int]]):
    """Numbered picker for which task item (of several in one block) to toggle.

    Dismisses the chosen item's ordinal (0-based index into the block's task
    items) or ``None`` on cancel. Digit keys 1-9 pick directly."""

    BINDINGS = [("escape", "cancel", "Cancel")]

    DEFAULT_CSS = """
    TaskPickerModal { align: center middle; }
    TaskPickerModal > Vertical {
        width: 60;
        height: auto;
        max-height: 80%;
        padding: 1 2;
        border: round $primary;
        background: $panel;
    }
    """

    def __init__(self, labels: list) -> None:
        super().__init__()
        self._labels = labels

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Label("Toggle which item?", classes="conflict-label")
            for n, text in enumerate(self._labels, start=1):
                yield Label(f"{n}. {text}")

    def on_key(self, event) -> None:
        if event.key.isdigit():
            n = int(event.key)
            if 1 <= n <= len(self._labels):
                self.dismiss(n - 1)

    def action_cancel(self) -> None:
        self.dismiss(None)


class EditModal(ModalScreen[Optional[SaveResult]]):
    """Edit one top-level block's markdown and save it as a collab step."""

    BINDINGS = [
        ("ctrl+s", "save", "Save"),
        ("escape", "cancel", "Cancel"),
        # Conflict-panel keys — inert while the editor is focused (a TextArea
        # consumes printable keys, so these never steal typing).
        ("m", "keep_mine", "Keep mine"),
        ("t", "take_theirs", "Take theirs"),
        ("b", "back_edit", "Back to editing"),
    ]

    DEFAULT_CSS = """
    EditModal { align: center middle; }
    EditModal > #edit-box {
        width: 90%;
        max-width: 100;
        height: 80%;
        padding: 1 2;
        border: round $primary;
        background: $panel;
    }
    EditModal #edit-title { text-style: bold; height: 1; }
    EditModal #editor { height: 1fr; border: round $primary-darken-1; }
    EditModal #conflict-panel { height: 1fr; }
    EditModal .conflict-title { text-style: bold; color: $warning; }
    EditModal .conflict-label { text-style: bold; color: $text-muted; }
    EditModal .conflict-theirs { border: round $secondary; padding: 0 1; height: auto; }
    EditModal .conflict-mine { border: round $accent; padding: 0 1; height: auto; }
    EditModal .conflict-hint { color: $text-muted; }
    """

    def __init__(self, session, index: int, old_json: dict, raw_markdown: str) -> None:
        super().__init__()
        self.session = session
        self._index = index
        self._old_json = old_json
        self._raw = raw_markdown
        self._dirty = False
        self._conflict = False

    def compose(self) -> ComposeResult:
        with Vertical(id="edit-box"):
            yield Label(
                f"Edit block {self._index}   (ctrl+s save · esc cancel)",
                id="edit-title",
            )
            yield TextArea(self._raw, id="editor")
            yield VerticalScroll(id="conflict-panel")

    def on_mount(self) -> None:
        editor = self.query_one("#editor", TextArea)
        # Markdown syntax highlighting needs the optional tree-sitter extra; if
        # it isn't installed, fall back to a plain buffer rather than crashing.
        try:
            editor.language = "markdown"
        except Exception:
            pass
        self.query_one("#conflict-panel", VerticalScroll).display = False
        editor.focus()

    def on_text_area_changed(self, event: TextArea.Changed) -> None:
        self._dirty = event.text_area.text != self._raw

    # --- save ---------------------------------------------------------------

    # @feat tui: EditModal save — parse/locate/submit with delete + conflict UX
    @work
    async def action_save(self) -> None:
        if self._conflict:
            return
        await self._save(self.query_one("#editor", TextArea).text)

    async def _save(
        self, text: str, *, confirmed_delete: bool = False, old_json=None
    ) -> None:
        try:
            result = await self.session.save_block(
                self._index,
                self._old_json if old_json is None else old_json,
                text,
                confirmed_delete=confirmed_delete,
            )
        except GoneError:
            # 410: history evicted. The DocScreen's SSE worker owns re-bootstrap;
            # signal a reload and step out of the way.
            self.notify("Document history changed; reopening", severity="warning")
            self.dismiss(SaveResult("reload"))
            return
        except (ForbiddenError, InvalidStepError, PaperError) as exc:
            self.notify(f"Save failed: {exc}", severity="error")
            return

        if result.kind == "saved":
            self.dismiss(result)
        elif result.kind == "needs_delete_confirm":
            ok = await self.app.push_screen_wait(
                ConfirmModal("This will delete the block. Continue?")
            )
            if ok:
                await self._save(text, confirmed_delete=True)
        elif result.kind == "changed_remotely":
            await self._show_conflict(result.their_markdown or "", text)

    # --- conflict resolution ------------------------------------------------

    async def _show_conflict(self, their_md: str, my_text: str) -> None:
        self._conflict = True
        self._conflict_text = my_text
        self.query_one("#editor", TextArea).display = False
        panel = self.query_one("#conflict-panel", VerticalScroll)
        await panel.remove_children()
        await panel.mount(
            Label("This block changed remotely.", classes="conflict-title"),
            Label("Theirs:", classes="conflict-label"),
            Static(their_md or "(block was removed)", classes="conflict-theirs"),
            Label("Mine:", classes="conflict-label"),
            Static(my_text or "(delete)", classes="conflict-mine"),
            Label(
                "m: keep mine   t: take theirs   b: back to editing",
                classes="conflict-hint",
            ),
        )
        panel.display = True
        panel.focus()

    async def _hide_conflict(self) -> None:
        self._conflict = False
        self.query_one("#conflict-panel", VerticalScroll).display = False
        editor = self.query_one("#editor", TextArea)
        editor.display = True
        editor.focus()

    @work
    async def action_keep_mine(self) -> None:
        if not self._conflict:
            return
        # Overwrite whatever is at index i now (their version) with my text.
        count = self.session.block_count()
        current = (
            self.session.doc.child(self._index).to_json()
            if self._index < count
            else None
        )
        text = self._conflict_text
        await self._hide_conflict()
        await self._save(text, old_json=current)

    def action_take_theirs(self) -> None:
        if not self._conflict:
            return
        # Discard my edit; the live doc already holds their version. Ask the
        # screen to rebuild from the caught-up session.
        self.dismiss(SaveResult("reload"))

    @work
    async def action_back_edit(self) -> None:
        if not self._conflict:
            return
        await self._hide_conflict()

    # --- cancel -------------------------------------------------------------

    @work
    async def action_cancel(self) -> None:
        if self._conflict:
            await self._hide_conflict()
            return
        if self._dirty:
            ok = await self.app.push_screen_wait(ConfirmModal("Discard your changes?"))
            if not ok:
                return
        self.dismiss(None)
