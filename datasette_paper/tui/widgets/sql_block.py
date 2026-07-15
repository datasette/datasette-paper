"""Live ``sql_block`` / ``source`` widget: a read-only, syntax-highlighted SQL
body that runs on demand (Enter / ``ctrl+r`` on the focused block, wired by
``DocScreen``) via ``datasette_api.run_sql``, rendering its rows in a
``DataTable`` with a row-count/truncation footer beneath. An error surfaces
as inline status text, never a crash.

Unlike the web editor (where ``source`` feeds inline ``value`` chips and
never renders a results table of its own — see ``02-reader-ux.md``), the TUI
gives both node types the same runnable view: v1 renders ``value`` atoms as
literal ``${{...}}`` text (no chip resolution), so a bare "SOURCE" block with
no way to see what it returns would be a dead end for a terminal reader.

Results are cached per ``(db, sql text)`` in a dict the owning ``DocScreen``
holds across its own lifetime (threaded through ``make_block`` — see
``blocks.py``), not on the widget itself: a block rebuilt by an SSE
re-render constructs a *new* widget instance, so caching on the instance
would still refetch on every re-render. Keying by the literal SQL text means
an edited query (ticket 04) naturally misses the cache and re-fetches; nothing
has to invalidate it explicitly.

@feat tui: sql_block/source live widget — Enter/ctrl+r runs, cached by (db, sql)
"""

from __future__ import annotations

from typing import Optional

from rich.syntax import Syntax
from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import DataTable, Static

from .. import datasette_api
from .cells import format_cell

RUN_HINT = "Enter / ctrl+r: run"


class SqlRunnerBlock(Vertical):
    """Renders a ``sql_block``/``source`` node's header + SQL body, and (once
    run) its results ``DataTable``. ``cache`` is the owning ``DocScreen``'s
    shared ``{(db, sql): SqlResult}`` dict — see the module docstring."""

    def __init__(
        self,
        *,
        client,
        db: Optional[str],
        sql_text: str,
        header: str,
        cache: dict,
    ) -> None:
        super().__init__()
        self._client = client
        self._db = db
        self._sql = sql_text
        self._header_text = header
        self._cache = cache

    def compose(self) -> ComposeResult:
        yield Static(self._header_text, classes="sql-block-header")
        yield Static(
            Syntax(self._sql or "", "sql", word_wrap=True, theme="ansi_dark"),
            classes="sql-block-body",
        )
        yield Static(RUN_HINT, id="sql-status", classes="sql-block-status")
        table = DataTable(id="sql-results", zebra_stripes=True)
        table.display = False
        yield table

    def on_mount(self) -> None:
        # A block rebuilt from a prior run (SSE re-render, cursor revisit)
        # shows the cached result immediately — no network call.
        cached = self._cache.get(self._cache_key())
        if cached is not None:
            self._render_result(cached)

    def _cache_key(self) -> tuple:
        return (self._db or "", self._sql)

    def _set_status(self, text: str) -> None:
        self.query_one("#sql-status", Static).update(text)

    # @feat tui: sql_block/source live widget — Enter/ctrl+r runs, cached by (db, sql)
    async def run_query(self) -> None:
        """Run this block's SQL (or replay it from cache) and render the
        result. Called from ``DocScreen.action_run_block`` via ``Block``."""
        if not self._db:
            self._set_status("No db= on this block — nothing to run")
            return
        key = self._cache_key()
        cached = self._cache.get(key)
        if cached is not None:
            self._render_result(cached)
            return
        self._set_status("Running…")
        result = await datasette_api.run_sql(self._client, self._db, self._sql)
        self._cache[key] = result
        self._render_result(result)

    def _render_result(self, result: datasette_api.SqlResult) -> None:
        table = self.query_one("#sql-results", DataTable)
        table.clear(columns=True)
        if not result.ok:
            table.display = False
            self._set_status(f"Error: {result.error}")
            return
        table.display = True
        if result.columns:
            table.add_columns(*result.columns)
        for row in result.rows:
            table.add_row(*[format_cell(row.get(c)) for c in result.columns])
        count = len(result.rows)
        suffix = " (truncated)" if result.truncated else ""
        self._set_status(f"{count} row{'' if count == 1 else 's'}{suffix}")
