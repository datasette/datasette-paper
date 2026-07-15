"""Thin fetch layer over Datasette's *native* browser JSON API — no paper
backend routes, no textual imports. Mirrors the frontend embed/SQL-block
design (``frontend/CLAUDE.md``'s "Datasette JSON API" section): same-origin
``.json`` GETs, the actor's cookie already enforces permissions, and a
non-``ok`` response becomes a typed error rather than a raised exception (a
widget must be able to show "table not found" inline, never crash the app).

Every function accepts either a :class:`~datasette_paper.tui.client.PaperClient`
or its bare ``httpx.AsyncClient`` (``_http``) — ``_http()`` below normalizes
either into the client to issue requests against, so a caller that already
has the underlying httpx client (as some tests do) doesn't need to wrap it.

Endpoint shapes were verified in-process against the pinned Datasette 1.0a36
(``uv run --prerelease=allow python -c "..."`` against a throwaway
``Datasette(files=[...])``), since they've moved across 1.0 alphas:

- ``run_sql``: ``GET /{db}/-/query.json?sql=...&_shape=objects&_extra=columns``.
  (``/{db}.json?sql=...`` — the form the SQL editor page posts to — 302s to
  this same URL; hitting it directly skips the redirect hop.) Success:
  ``{"ok": true, "rows": [...], "columns": [...], "truncated": bool}``.
  Failure (bad SQL, missing table, …): ``{"ok": false, "error": "...",
  ...}``, HTTP 400 — the ``error`` string is exactly what a human wants to
  see inline.
- ``table_rows``: ``GET /{db}/{table}.json?_shape=objects&_size=N`` (+
  ``_next=<token>`` for the next page). ``_extra=columns,count,
  count_truncated,primary_keys`` gets the header (even for a zero-row page,
  where ``rows[0].keys()`` would be nothing) plus the same "capped, and
  that's a signal" count semantics the frontend depends on: ``count`` tops
  out at Datasette's ``count_limit`` (default 10000) with
  ``count_truncated: true`` marking the cap, so render "N+" rather than
  trusting ``count`` as exact.
- ``list_databases``: ``GET /-/databases.json`` → ``{"databases": [{"name":
  ...}, ...]}``. ``list_tables``: ``GET /{db}.json`` → ``{"tables": [...],
  "views": [...]}``. Both skip ``_``-prefixed names (Datasette's own
  ``_memory`` scratch db, and — belt and braces — an ``_internal``-routed
  db some deployments might expose; paper's *own* internal db is a
  separate, unrouted ``Database`` handle per ``Datasette(internal=...)``
  and never appears in either listing at all) — the same rule
  ``datasetteEmbed.ts``'s ``searchResources`` uses. ``list_tables`` also
  drops any ``_datasette_paper_*`` table name, mirroring
  ``datasetteEmbed.ts``'s ``isPaperTable`` (defense in depth — normally
  unreachable, since paper's tables live in the separate internal db).
- ``fetch_row``: ``GET /{db}/{table}/{pk}.json?_shape=objects`` →
  ``{"rows": [{...}], "primary_keys": [...]}`` (404 → not-found). Blob
  columns arrive as Datasette's ``{"$base64": true, "encoded": "..."}``
  envelope in every shape above — callers format it (see ``widgets/cells.py``),
  this module passes it through verbatim.

@feat tui: datasette JSON API fetch layer (run_sql / table_rows / list_databases / list_tables / fetch_row)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Union

import httpx

# All Datasette table-of-tables listings ("Datasette's own scratch db",
# potential `_internal`-routed dbs) share this prefix — same rule
# datasetteEmbed.ts's searchResources() applies before offering a db.
_HIDDEN_DB_PREFIX = "_"
# Paper's own storage tables, in case a content db and paper's internal db
# were ever the same physical file — mirrors datasetteEmbed.ts's isPaperTable.
_PAPER_TABLE_PREFIX = "_datasette_paper_"


@dataclass
class ApiError:
    """A Datasette-reported (or transport-level) failure, never raised."""

    message: str


def _http(client: Any) -> httpx.AsyncClient:
    """Normalize a ``PaperClient`` or a bare ``httpx.AsyncClient`` to the
    latter — every function here accepts either (see module docstring)."""
    inner = getattr(client, "_http", None)
    return inner if inner is not None else client


async def _get_json(
    http: httpx.AsyncClient, path: str, params: Any
) -> tuple[Optional[dict], Optional[str]]:
    """GET ``path``, returning ``(body, None)`` on a Datasette-``ok`` JSON
    response or ``(None, message)`` on any failure — network error,
    non-JSON body, or a well-formed ``{"ok": false, "error": ...}``."""
    try:
        resp = await http.get(path, params=params)
    except httpx.HTTPError as exc:
        return None, str(exc)
    try:
        body = resp.json()
    except ValueError:
        return None, f"Unexpected response ({resp.status_code})"
    if not isinstance(body, dict):
        return None, f"Unexpected response ({resp.status_code})"
    if not body.get("ok", False):
        message = body.get("error")
        if not (isinstance(message, str) and message):
            message = f"Request failed ({resp.status_code})"
        return None, message
    return body, None


def _columns_of(body: dict) -> list:
    """``_extra=columns`` always sets ``columns`` on success; fall back to
    the first row's keys for endpoints that don't support that extra (belt
    and braces — every call site here does pass it)."""
    columns = body.get("columns")
    if isinstance(columns, list):
        return columns
    rows = body.get("rows") or []
    return list(rows[0].keys()) if rows else []


# --- run_sql -----------------------------------------------------------


@dataclass
class SqlResult:
    """``run_sql``'s outcome. ``error`` is ``None`` iff the query succeeded
    (``ok`` is a convenience over that, mirroring the frontend's ``ok``
    discriminated-union status field)."""

    columns: list = field(default_factory=list)
    rows: list = field(default_factory=list)
    truncated: bool = False
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.error is None


# @feat tui: run_sql — GET /{db}/-/query.json, a Datasette error surfaces as a message
async def run_sql(client: Any, db: str, sql: str) -> SqlResult:
    """Run ``sql`` against ``db`` and return its rows, or an inline error."""
    http = _http(client)
    body, error = await _get_json(
        http,
        f"/{db}/-/query.json",
        {"sql": sql, "_shape": "objects", "_extra": "columns"},
    )
    if error is not None:
        return SqlResult(error=error)
    rows = body.get("rows") or []
    return SqlResult(
        columns=_columns_of(body), rows=rows, truncated=bool(body.get("truncated"))
    )


# --- table_rows ----------------------------------------------------------


@dataclass
class TableRowsResult:
    """``table_rows``'s outcome, including the ``_next`` paging token and
    the (possibly capped — see ``count_truncated``) row count."""

    columns: list = field(default_factory=list)
    rows: list = field(default_factory=list)
    next_token: Optional[str] = None
    count: Optional[int] = None
    count_truncated: bool = False
    primary_keys: list = field(default_factory=list)
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.error is None


# @feat tui: table_rows — GET /{db}/{table}.json with _next paging
async def table_rows(
    client: Any,
    db: str,
    table: str,
    *,
    size: Optional[int] = None,
    next_token: Optional[str] = None,
    extra_params: Optional[list] = None,
) -> TableRowsResult:
    """Fetch one page of ``table``'s rows. ``extra_params`` carries the
    ``column__op=value`` / ``_sort``(``_desc``) pairs a table-mode
    ``block_embed``'s filter/sort config translates to (see
    ``widgets/block_embed.py``) — plain browsing passes none."""
    http = _http(client)
    params: list = [
        ("_shape", "objects"),
        ("_extra", "columns,count,count_truncated,primary_keys"),
    ]
    if size is not None:
        params.append(("_size", str(size)))
    if next_token is not None:
        params.append(("_next", next_token))
    params.extend(extra_params or [])
    body, error = await _get_json(http, f"/{db}/{table}.json", params)
    if error is not None:
        return TableRowsResult(error=error)
    return TableRowsResult(
        columns=_columns_of(body),
        rows=body.get("rows") or [],
        next_token=body.get("next"),
        count=body.get("count"),
        count_truncated=bool(body.get("count_truncated")),
        primary_keys=body.get("primary_keys") or [],
    )


# --- fetch_row -------------------------------------------------------------


# @feat tui: fetch_row — GET /{db}/{table}/{pk}.json for a block_embed row ref
async def fetch_row(client: Any, db: str, table: str, pk: str) -> Union[list, ApiError]:
    """A single row's ``[{"column": ..., "value": ...}, ...]`` fields, or an
    error (including "not found", Datasette's 404 for a missing pk)."""
    http = _http(client)
    body, error = await _get_json(
        http, f"/{db}/{table}/{pk}.json", {"_shape": "objects"}
    )
    if error is not None:
        return ApiError(error)
    rows = body.get("rows") or []
    if not rows:
        return ApiError("Row not found")
    row = rows[0]
    columns = body.get("columns") or list(row.keys())
    return [{"column": c, "value": row.get(c)} for c in columns]


# --- list_databases / list_tables ------------------------------------------


@dataclass
class DatabaseInfo:
    name: str


@dataclass
class TableInfo:
    name: str
    kind: str  # "table" | "view"
    count: Optional[int] = None


# @feat tui: list_databases — GET /-/databases.json, hidden/internal dbs skipped
async def list_databases(client: Any) -> Union[list, ApiError]:
    """Every visible, non-hidden database — paper's own internal db is a
    separate unrouted handle and never appears here (see module docstring)."""
    http = _http(client)
    body, error = await _get_json(http, "/-/databases.json", {})
    if error is not None:
        return ApiError(error)
    out = []
    for entry in body.get("databases") or []:
        name = entry.get("name")
        if isinstance(name, str) and name and not name.startswith(_HIDDEN_DB_PREFIX):
            out.append(DatabaseInfo(name=name))
    return out


# @feat tui: list_tables — GET /{db}.json (tables + views), paper-internal tables skipped
async def list_tables(client: Any, db: str) -> Union[list, ApiError]:
    """Every table and view in ``db``, in that order — a missing/denied
    database surfaces as :class:`ApiError`, never a crash."""
    http = _http(client)
    body, error = await _get_json(http, f"/{db}.json", {})
    if error is not None:
        return ApiError(error)
    out = []
    for entry in body.get("tables") or []:
        name = entry.get("name")
        if isinstance(name, str) and name and not name.startswith(_PAPER_TABLE_PREFIX):
            out.append(TableInfo(name=name, kind="table", count=entry.get("count")))
    for entry in body.get("views") or []:
        name = entry.get("name")
        if isinstance(name, str) and name and not name.startswith(_PAPER_TABLE_PREFIX):
            out.append(TableInfo(name=name, kind="view"))
    return out
