"""DocListScreen — the doc browser (a DataTable over ``GET /api/docs``).

Columns: Name / Updated (relative) / Tags. A tab row switches the
``state`` / ``kind`` params (Active / Archived / Templates). ``/`` reveals a
client-side substring filter (the listing is server-capped at 1000 rows). Enter
opens the doc; ``n`` creates one (name prompt → ``create`` → open); ``r``
renames the selected doc; ``b`` opens ``BrowseScreen`` (``screens/browse.py``),
a read-only Datasette database/table browser.

@feat tui: doc browser screen (list / filter / open / create / rename)
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from textual import work
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import ModalScreen, Screen
from textual.widgets import DataTable, Footer, Input, Label, Tabs, Tab

from .browse import BrowseScreen
from .doc_view import DocScreen

# Tab id → (state, kind) query params for GET /api/docs.
_TABS = {
    "active": ("active", "doc"),
    "archived": ("archived", "doc"),
    "templates": ("active", "template"),
}


def _relative_time(iso: Optional[str]) -> str:
    """Human relative time for an ISO-8601 ``updated_at`` (e.g. ``3h ago``)."""
    if not iso:
        return ""
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return iso
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = datetime.now(timezone.utc) - dt
    secs = int(delta.total_seconds())
    if secs < 0:
        secs = 0
    if secs < 60:
        return "just now"
    mins = secs // 60
    if mins < 60:
        return f"{mins}m ago"
    hours = mins // 60
    if hours < 24:
        return f"{hours}h ago"
    days = hours // 24
    if days < 30:
        return f"{days}d ago"
    return dt.strftime("%Y-%m-%d")


class PromptModal(ModalScreen[Optional[str]]):
    """A one-line text prompt; dismisses with the entered value or ``None``."""

    BINDINGS = [("escape", "cancel", "Cancel")]

    DEFAULT_CSS = """
    PromptModal { align: center middle; }
    PromptModal > Vertical {
        width: 60;
        height: auto;
        padding: 1 2;
        border: round $primary;
        background: $panel;
    }
    """

    def __init__(self, title: str, initial: str = "") -> None:
        super().__init__()
        self._title = title
        self._initial = initial

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Label(self._title)
            yield Input(value=self._initial, id="prompt-input")

    def on_mount(self) -> None:
        self.query_one("#prompt-input", Input).focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.dismiss(event.value.strip() or None)

    def action_cancel(self) -> None:
        self.dismiss(None)


class DocListScreen(Screen):
    """Browse, open, create and rename docs."""

    BINDINGS = [
        ("slash", "filter", "Filter"),
        ("n", "new", "New"),
        ("r", "rename", "Rename"),
        ("b", "browse", "Browse"),
    ]

    DEFAULT_CSS = """
    DocListScreen > Tabs { dock: top; }
    DocListScreen > DataTable { height: 1fr; }
    DocListScreen > #filter-input { dock: bottom; display: none; }
    DocListScreen > #filter-input.-visible { display: block; }
    """

    def __init__(self, client) -> None:
        super().__init__()
        self.client = client
        self._all_rows: list = []
        self._filter = ""
        self._state = "active"
        self._kind = "doc"

    def compose(self) -> ComposeResult:
        yield Tabs(
            Tab("Active", id="active"),
            Tab("Archived", id="archived"),
            Tab("Templates", id="templates"),
        )
        table = DataTable(id="doc-table", cursor_type="row", zebra_stripes=True)
        table.add_columns("Name", "Updated", "Tags")
        yield table
        yield Input(placeholder="filter", id="filter-input")
        yield Footer()

    async def on_mount(self) -> None:
        self.table = self.query_one("#doc-table", DataTable)
        await self.reload()

    # --- data ---------------------------------------------------------------

    async def reload(self) -> None:
        self._all_rows = await self.client.list_docs(state=self._state, kind=self._kind)
        self._repopulate()

    def _repopulate(self) -> None:
        self.table.clear()
        needle = self._filter.lower()
        for row in self._all_rows:
            name = row.get("name") or ""
            tags = row.get("tags") or []
            if needle:
                hay = (name + " " + " ".join(tags)).lower()
                if needle not in hay:
                    continue
            self.table.add_row(
                name,
                _relative_time(row.get("updated_at")),
                " ".join(f"#{t}" for t in tags),
                key=str(row["id"]),
            )

    def _row_name(self, doc_id: int) -> str:
        for row in self._all_rows:
            if row["id"] == doc_id:
                return row.get("name") or f"Document {doc_id}"
        return f"Document {doc_id}"

    # --- open ---------------------------------------------------------------

    async def open_doc_id(self, doc_id: int, name: Optional[str] = None) -> None:
        session = await self.client.open_doc(doc_id)
        await self.app.push_screen(
            DocScreen(self.client, session, name=name or self._row_name(doc_id))
        )

    async def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        if event.row_key.value is not None:
            await self.open_doc_id(int(event.row_key.value))

    def _selected_doc_id(self) -> Optional[int]:
        if self.table.row_count == 0:
            return None
        try:
            key = self.table.coordinate_to_cell_key(self.table.cursor_coordinate)
        except Exception:
            return None
        return int(key.row_key.value) if key.row_key.value is not None else None

    # --- tabs / filter ------------------------------------------------------

    async def on_tabs_tab_activated(self, event: Tabs.TabActivated) -> None:
        tab_id = event.tab.id
        if tab_id in _TABS:
            self._state, self._kind = _TABS[tab_id]
            await self.reload()

    def action_filter(self) -> None:
        inp = self.query_one("#filter-input", Input)
        inp.add_class("-visible")
        inp.focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id == "filter-input":
            self._filter = event.value
            self._repopulate()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "filter-input":
            self.table.focus()

    # --- create / rename / browse ------------------------------------------

    @work
    async def action_new(self) -> None:
        name = await self.app.push_screen_wait(PromptModal("New document name"))
        if not name:
            return
        doc = await self.client.create(name)
        await self.open_doc_id(doc["id"], doc.get("name") or name)

    @work
    async def action_rename(self) -> None:
        doc_id = self._selected_doc_id()
        if doc_id is None:
            return
        new_name = await self.app.push_screen_wait(
            PromptModal("Rename document", initial=self._row_name(doc_id))
        )
        if not new_name:
            return
        await self.client.rename(doc_id, new_name)
        await self.reload()

    # @feat tui: BrowseScreen — database/table/row browsing over the Datasette JSON API
    def action_browse(self) -> None:
        self.app.push_screen(BrowseScreen(self.client))
