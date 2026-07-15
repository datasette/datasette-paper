"""BrowseScreen — a lightweight, read-only Datasette table browser reachable
from the doc list (``b``): database list -> table list -> a paginated
``DataTable`` of rows (``_next``-token paging, a "load more" binding). This
deliberately reimplements none of Datasette's faceting; it's a viewer, and
``o`` at any level opens the equivalent real Datasette page in the browser.

Each level is its own ``Screen`` pushed onto the app's screen stack
(``BrowseScreen`` -> ``BrowseTablesScreen`` -> ``BrowseRowsScreen``), so
Escape's default "pop back" reuses the same walk-back-up behavior
``DocScreen.action_back`` already relies on — no separate state machine.

@feat tui: BrowseScreen — database/table/row browsing over the Datasette JSON API
"""

from __future__ import annotations

import webbrowser
from typing import Optional
from urllib.parse import quote

from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import DataTable, Footer, Static

from .. import datasette_api
from ..widgets.cells import format_cell

ROW_PAGE_SIZE = 50


def _page_url(base: str, *segments: str) -> str:
    path = "/".join(quote(s, safe="") for s in segments)
    return f"{base.rstrip('/')}/{path}"


class _BrowseLevel(Screen):
    """Shared chrome + Escape-pops-back for the three browse levels."""

    DEFAULT_CSS = """
    _BrowseLevel > .browse-header {
        dock: top;
        height: 1;
        padding: 0 1;
        background: $panel;
        color: $text;
    }
    _BrowseLevel > DataTable { height: 1fr; }
    _BrowseLevel > .browse-status {
        dock: bottom;
        height: 1;
        padding: 0 1;
        color: $text-muted;
    }
    """

    def action_back(self) -> None:
        if len(self.app.screen_stack) > 1:
            self.app.pop_screen()


class BrowseScreen(_BrowseLevel):
    """Level 1: pick a database."""

    BINDINGS = [
        ("o", "open_browser", "Open in browser"),
        ("escape", "back", "Back"),
    ]

    def __init__(self, client) -> None:
        super().__init__()
        self.client = client
        self._names: list = []

    def compose(self) -> ComposeResult:
        yield Static("Databases", classes="browse-header")
        table = DataTable(id="browse-table", cursor_type="row", zebra_stripes=True)
        table.add_columns("Name")
        yield table
        yield Static("", id="browse-status", classes="browse-status")
        yield Footer()

    async def on_mount(self) -> None:
        self.table = self.query_one("#browse-table", DataTable)
        status = self.query_one("#browse-status", Static)
        result = await datasette_api.list_databases(self.client)
        if isinstance(result, datasette_api.ApiError):
            status.update(f"Error: {result.message}")
            return
        self._names = [d.name for d in result]
        for name in self._names:
            self.table.add_row(name, key=name)
        status.update(f"{len(self._names)} database(s)")

    async def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        name = event.row_key.value
        if name:
            await self.app.push_screen(BrowseTablesScreen(self.client, name))

    def action_open_browser(self) -> None:
        base = self.client.server_url
        if not base:
            self.notify("No server URL in internal mode")
            return
        webbrowser.open(f"{base.rstrip('/')}/")


class BrowseTablesScreen(_BrowseLevel):
    """Level 2: pick a table (or view) within a chosen database."""

    BINDINGS = [
        ("o", "open_browser", "Open in browser"),
        ("escape", "back", "Back"),
    ]

    def __init__(self, client, db: str) -> None:
        super().__init__()
        self.client = client
        self.db = db
        self._tables: list = []

    def compose(self) -> ComposeResult:
        yield Static(f"{self.db} — tables", classes="browse-header")
        table = DataTable(id="browse-table", cursor_type="row", zebra_stripes=True)
        table.add_columns("Name", "Kind", "Count")
        yield table
        yield Static("", id="browse-status", classes="browse-status")
        yield Footer()

    async def on_mount(self) -> None:
        self.table = self.query_one("#browse-table", DataTable)
        status = self.query_one("#browse-status", Static)
        result = await datasette_api.list_tables(self.client, self.db)
        if isinstance(result, datasette_api.ApiError):
            status.update(f"Error: {result.message}")
            return
        self._tables = result
        for t in result:
            count = "" if t.count is None else str(t.count)
            self.table.add_row(t.name, t.kind, count, key=t.name)
        status.update(f"{len(result)} table(s)")

    async def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        name = event.row_key.value
        if name:
            await self.app.push_screen(BrowseRowsScreen(self.client, self.db, name))

    def action_open_browser(self) -> None:
        base = self.client.server_url
        if not base:
            self.notify("No server URL in internal mode")
            return
        webbrowser.open(_page_url(base.rstrip("/"), self.db))


class BrowseRowsScreen(_BrowseLevel):
    """Level 3: a paginated row browser for one table/view."""

    BINDINGS = [
        ("n", "load_more", "Load more"),
        ("o", "open_browser", "Open in browser"),
        ("escape", "back", "Back"),
    ]

    def __init__(self, client, db: str, table: str) -> None:
        super().__init__()
        self.client = client
        self.db = db
        self.table_name = table
        self._columns: list = []
        self._next_token: Optional[str] = None
        self._loaded_count = 0
        self._exhausted = False

    def compose(self) -> ComposeResult:
        yield Static(f"{self.db}/{self.table_name}", classes="browse-header")
        yield DataTable(id="browse-rows", zebra_stripes=True)
        yield Static("", id="browse-status", classes="browse-status")
        yield Footer()

    async def on_mount(self) -> None:
        self.table = self.query_one("#browse-rows", DataTable)
        await self._load_page()

    # @feat tui: BrowseScreen — database/table/row browsing over the Datasette JSON API
    async def _load_page(self) -> None:
        status = self.query_one("#browse-status", Static)
        status.update("Loading…")
        result = await datasette_api.table_rows(
            self.client,
            self.db,
            self.table_name,
            size=ROW_PAGE_SIZE,
            next_token=self._next_token,
        )
        if not result.ok:
            status.update(f"Error: {result.error}")
            return
        if not self._columns and result.columns:
            self._columns = result.columns
            self.table.add_columns(*self._columns)
        for row in result.rows:
            self.table.add_row(*[format_cell(row.get(c)) for c in self._columns])
        self._loaded_count += len(result.rows)
        self._next_token = result.next_token
        self._exhausted = self._next_token is None
        if result.count is None:
            count_text = ""
        else:
            count_text = f" of {result.count}{'+' if result.count_truncated else ''}"
        more = "" if self._exhausted else "  (n: load more)"
        status.update(f"{self._loaded_count} row(s){count_text}{more}")

    async def action_load_more(self) -> None:
        if not self._exhausted:
            await self._load_page()

    def action_open_browser(self) -> None:
        base = self.client.server_url
        if not base:
            self.notify("No server URL in internal mode")
            return
        webbrowser.open(_page_url(base.rstrip("/"), self.db, self.table_name))
