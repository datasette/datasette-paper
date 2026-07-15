"""Live ``block_embed`` widget: fetch + render a read-only snapshot of the
node's ``ref`` (a Datasette URL path) honoring its stored
``config.filters``/``config.sort``/``config.columns``, then dispatch by ref
shape — a database ref (1 path segment) lists its tables, a table ref (2
segments) renders a filtered/sorted ``DataTable``, a row ref (3 segments)
renders a field:value listing. ``o`` (wired by ``DocScreen``) opens the
equivalent Datasette page in the browser.

This mirrors two frontend modules with no Python port of their own (per
``frontend/CLAUDE.md``, both are frontend-only):
``frontend/src/lib/datasetteEmbed.ts``'s ``fetchEmbed`` — ref segment count
decides the kind, *not* the node's ``mode`` attr (that only matters for a
third-party embed provider, which the TUI doesn't support) — and
``frontend/src/lib/embedFilters.ts``'s config→query-param mapping (the
``embed-filters`` feature) plus its shareable-URL builder (the
``embed-copy-url`` feature). Reimplemented here scoped to what a read-only
terminal viewer needs: no filter-*editing* UI, no columns picker — config is
read and rendered, never written.

@feat tui: block_embed live render — ref/mode/config -> table/row/db view, `o` opens Datasette URL
"""

from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.widgets import DataTable, Static

from .. import datasette_api
from .cells import format_cell

# Default capped row count for a table-mode embed — mirrors
# datasetteEmbed.ts's DEFAULT_EMBED_LIMIT (25), scaled for terminal reading.
DEFAULT_EMBED_LIMIT = 25

# Datasette's no-argument filter ops (send "1" as the wire value) — the
# subset of embedFilters.ts's FILTER_OPS this module needs to know about.
_NO_VALUE_OPS = {"isnull", "notnull", "isblank", "notblank"}
_KNOWN_OPS = {
    "exact",
    "not",
    "contains",
    "notcontains",
    "endswith",
    "startswith",
    "gt",
    "gte",
    "lt",
    "lte",
    "like",
    "notlike",
    "glob",
    "in",
    "notin",
    "arraycontains",
    "arraynotcontains",
    "date",
} | _NO_VALUE_OPS


def ref_segments(ref: str) -> list:
    """``/db/table/pk`` -> ``["db", "table", "pk"]`` — mirrors
    datasetteEmbed.ts's ``refSegments``."""
    return [p for p in (ref or "").strip("/").split("/") if p]


# @feat tui: block_embed live render — ref/mode/config -> table/row/db view, `o` opens Datasette URL
def sanitize_filters(raw: Any) -> list:
    """The valid filters from a raw ``config.filters`` value — mirrors
    embedFilters.ts's ``sanitizeFilters`` (bad entries dropped, never
    raised; config can arrive from hand-written markdown)."""
    if not isinstance(raw, list):
        return []
    out = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        column, op, value = entry.get("column"), entry.get("op"), entry.get("value")
        if not isinstance(column, str) or not column:
            continue
        if op not in _KNOWN_OPS:
            continue
        if op in _NO_VALUE_OPS:
            out.append({"column": column, "op": op})
        elif isinstance(value, str):
            out.append({"column": column, "op": op, "value": value})
    return out


def sanitize_sort(raw: Any) -> Optional[dict]:
    """The valid sort from a raw ``config.sort`` value, or ``None`` —
    mirrors embedFilters.ts's ``sanitizeSort``."""
    if not isinstance(raw, dict):
        return None
    column = raw.get("column")
    if not isinstance(column, str) or not column:
        return None
    return {"column": column, "desc": raw.get("desc") is True}


def sanitize_columns(raw: Any) -> list:
    """The valid ``config.columns`` selection — mirrors embedFilters.ts's
    ``sanitizeColumns``."""
    if not isinstance(raw, list):
        return []
    return [c for c in raw if isinstance(c, str) and c]


def filter_query_params(filters: list, sort: Optional[dict]) -> list:
    """Sanitized filters/sort -> ``column__op=value`` / ``_sort``(``_desc``)
    pairs — mirrors embedFilters.ts's ``filterQueryParams`` (always the
    explicit ``__op`` suffix, no-value ops send ``"1"``, sort emits exactly
    one of ``_sort``/``_sort_desc``)."""
    pairs = []
    for f in filters:
        value = "1" if f["op"] in _NO_VALUE_OPS else f.get("value", "")
        pairs.append((f"{f['column']}__{f['op']}", value))
    if sort:
        pairs.append(("_sort_desc" if sort.get("desc") else "_sort", sort["column"]))
    return pairs


# @feat tui: block_embed_url — the shareable Datasette URL for a block_embed ref+config (`o` binding)
def block_embed_url(ref: str, config: Optional[dict], origin: str = "") -> str:
    """The full Datasette URL a ``block_embed`` renders, rebuilt from its
    ``ref`` + ``config`` — mirrors embedFilters.ts's ``blockEmbedUrl``. What
    the ``o`` binding opens in the browser."""
    segments = ref_segments(ref)
    path = "/" + "/".join(quote(s, safe="") for s in segments)
    config = config or {}
    filters = sanitize_filters(config.get("filters"))
    sort = sanitize_sort(config.get("sort"))
    pairs = filter_query_params(filters, sort)
    for col in sanitize_columns(config.get("columns")):
        pairs.append(("_col", col))
    query = "&".join(f"{quote(k, safe='')}={quote(str(v), safe='')}" for k, v in pairs)
    return f"{origin}{path}" + (f"?{query}" if query else "")


class BlockEmbedBlock(Vertical):
    """Renders a ``block_embed`` node: header + fetched body (table/row/db),
    dispatched by ``ref`` segment count. ``ref``/``config`` are kept as
    public attrs so ``Block.browser_url`` (``blocks.py``) can build the
    Datasette URL for the ``o`` binding without re-parsing the doc node."""

    def __init__(self, *, client, ref: Optional[str], config: Optional[dict]) -> None:
        super().__init__()
        self._client = client
        self.ref = ref or ""
        self.config = config or {}

    def compose(self) -> ComposeResult:
        yield Static(self._header_text(), classes="embed-header")
        yield Vertical(id="embed-body")
        yield Static("Loading…", id="embed-status", classes="embed-status")

    def _header_text(self) -> str:
        seg = ref_segments(self.ref)
        kind = {1: "database", 2: "table", 3: "row"}.get(len(seg), "embed")
        return f"EMBED  {self.ref or '(no ref)'}  ({kind})"

    def on_mount(self) -> None:
        self.run_worker(self._load(), exclusive=True)

    async def _load(self) -> None:
        seg = ref_segments(self.ref)
        status = self.query_one("#embed-status", Static)
        body = self.query_one("#embed-body", Vertical)
        if len(seg) == 1:
            await self._load_database(seg[0], body, status)
        elif len(seg) == 2:
            await self._load_table(seg[0], seg[1], body, status)
        elif len(seg) == 3:
            await self._load_row(seg[0], seg[1], seg[2], body, status)
        else:
            status.update("No ref on this embed")

    async def _load_database(self, db: str, body: Vertical, status: Static) -> None:
        result = await datasette_api.list_tables(self._client, db)
        if isinstance(result, datasette_api.ApiError):
            status.update(f"Error: {result.message}")
            return
        table = DataTable(zebra_stripes=True)
        table.add_columns("Name", "Kind", "Count")
        for t in result:
            table.add_row(t.name, t.kind, "" if t.count is None else str(t.count))
        await body.mount(table)
        status.update(f"{len(result)} table(s)")

    async def _load_table(
        self, db: str, table_name: str, body: Vertical, status: Static
    ) -> None:
        filters = sanitize_filters(self.config.get("filters"))
        sort = sanitize_sort(self.config.get("sort"))
        wanted = sanitize_columns(self.config.get("columns"))
        extra = filter_query_params(filters, sort)
        result = await datasette_api.table_rows(
            self._client, db, table_name, size=DEFAULT_EMBED_LIMIT, extra_params=extra
        )
        if not result.ok:
            status.update(f"Error: {result.error}")
            return
        # config.columns projects client-side, same as the web NodeView — the
        # fetch always pulls every column so a filter saved against a hidden
        # one still has something to render.
        show_columns = [c for c in wanted if c in result.columns] or result.columns
        table = DataTable(zebra_stripes=True)
        table.add_columns(*show_columns)
        for row in result.rows:
            table.add_row(*[format_cell(row.get(c)) for c in show_columns])
        await body.mount(table)
        if result.count is None:
            count_text = ""
        else:
            count_text = f" of {result.count}{'+' if result.count_truncated else ''}"
        status.update(f"{len(result.rows)} row(s){count_text}")

    async def _load_row(
        self, db: str, table_name: str, pk: str, body: Vertical, status: Static
    ) -> None:
        result = await datasette_api.fetch_row(self._client, db, table_name, pk)
        if isinstance(result, datasette_api.ApiError):
            status.update(f"Error: {result.message}")
            return
        table = DataTable(zebra_stripes=True)
        table.add_columns("Column", "Value")
        for entry in result:
            table.add_row(entry["column"], format_cell(entry["value"]))
        await body.mount(table)
        status.update(f"1 row, {len(result)} field(s)")
