"""Build a publication: materialize a doc version, resolve identity labels,
and render it to static HTML via ``html_render``.

Separated from the route handlers so the rendering pipeline is unit-testable
without HTTP and so the frozen-data executor (T05) has a clean seam to plug
into. The route layer (``routes/publish.py``) owns persistence, ACL audience
grants, cache headers, and SSE broadcast.
"""

from __future__ import annotations

import json
from typing import Awaitable, Callable, Optional

from datasette.resources import DatabaseResource

from .html_render import Labels, render_doc
from .instance import materialize_doc_at
from .util import resolve_actor_profiles

# A permission-checked SQL runner: ``run_sql(db, sql) -> {columns, rows,
# truncated} | None`` (None when the db/sql is empty or the actor can't run it).
# Supplied by the route layer (it holds the datasette/actor context); ``None``
# means "publish all-live" (the pre-freeze path).
RunSql = Callable[[str, str], Awaitable[Optional[dict]]]
# A custom-embed precompute hook: ``embed_precompute(block) -> payload | None``
# (None = decline → fall back to live). Wired in T06.
EmbedPrecompute = Callable[[object], Awaitable[Optional[dict]]]

# Cap on baked frozen rows (keeps a published page bounded; the live path is
# already client-paginated). Matches the editor's default table embed feel.
FROZEN_ROW_CAP = 1000


def _collect_ref_ids(doc: dict) -> tuple[set, set]:
    """Walk a doc, returning ``(actor_ids, paper_doc_ids)`` referenced by
    ``mention`` / ``paper_link`` inline atoms (for label resolution)."""
    actor_ids: set = set()
    paper_ids: set = set()

    def walk(node):
        t = node.get("type")
        if t == "mention":
            aid = (node.get("attrs") or {}).get("actorId")
            if aid:
                actor_ids.add(str(aid))
        elif t == "paper_link":
            did = (node.get("attrs") or {}).get("docId")
            if did is not None:
                paper_ids.add(int(did))
        for child in node.get("content") or []:
            walk(child)

    walk(doc)
    return actor_ids, paper_ids


async def resolve_labels(datasette, db, doc: dict) -> Labels:
    """Resolve mention names + paper-link titles for a doc, server-side.

    Inline-embed labels are left to the client hydrator (they're per-viewer
    permission-sensitive), so :class:`Labels` falls back to the raw ref for
    those.
    """
    actor_ids, paper_ids = _collect_ref_ids(doc)

    profiles = await resolve_actor_profiles(datasette, actor_ids) if actor_ids else {}
    actor_names = {aid: (p or {}).get("name") for aid, p in profiles.items()}

    paper_info: dict[int, dict] = {}
    for did in paper_ids:
        row = await db.select_doc_by_id(did)
        if row is None:
            paper_info[did] = {
                "title": f"Paper {did}",
                "href": f"/-/paper/doc/{did}",
                "state": "missing",
            }
        else:
            paper_info[did] = {
                "title": row.name or f"Paper {did}",
                "href": f"/-/paper/doc/{did}",
                "state": row.state,
            }

    return Labels(
        actor=lambda aid: actor_names.get(str(aid)),
        paper=lambda did: paper_info.get(int(did)),
    )


async def build_publication(
    datasette,
    db,
    *,
    doc_id: int,
    version: int,
    data_mode_default: str = "live",
    block_overrides: Optional[dict] = None,
    published_by: Optional[str] = None,
    run_sql: Optional[RunSql] = None,
    embed_precompute: Optional[EmbedPrecompute] = None,
    computed_at: Optional[str] = None,
) -> dict:
    """Materialize doc@version and render it to a publication payload.

    Returns ``{html, doc_json, has_live_blocks, config_json, frozen_data,
    warnings, blocks}`` ready for ``PaperDB.write_publication``. Two-pass:
    render once all-live to discover the data blocks + their ids, resolve each
    block's mode, compute frozen payloads (running each block's query once via
    ``run_sql``, as the publisher), then render again with the final modes +
    baked payloads.

    With ``run_sql=None`` (the pre-freeze path) every block stays live.
    """
    block_overrides = block_overrides or {}
    doc_json = await materialize_doc_at(db, doc_id, version)
    labels = await resolve_labels(datasette, db, doc_json)

    # Pass 1 — discover data blocks (ids assigned in document order).
    discovery = render_doc(doc_json, labels=labels)

    def requested_mode(block_id: str) -> str:
        return block_overrides.get(block_id, data_mode_default)

    # Sources by name, so a frozen ``value`` can resolve the first row of the
    # query it references. Each source query runs at most once (cached).
    sources_by_name = {
        b.name: b for b in discovery.blocks if b.kind == "source" and b.name
    }
    source_cache: dict[str, Optional[dict]] = {}

    async def resolve_source(name: str) -> Optional[dict]:
        if name in source_cache:
            return source_cache[name]
        src = sources_by_name.get(name)
        result = None
        if src is not None and run_sql is not None:
            result = await run_sql(src.config.get("db"), src.config.get("sql"))
        source_cache[name] = result
        return result

    async def freeze(block) -> Optional[dict]:
        """Compute one frozen block's payload, or None to fall back to live."""
        if block.kind in ("sql", "embed"):
            if block.kind == "embed":
                sql = _embed_sql(block.config)
                if sql is None:
                    # row/database embeds aren't bakeable as a table here.
                    return None
                payload = await run_sql(block.config.get("db"), sql)
            else:
                payload = await run_sql(block.config.get("db"), block.config.get("sql"))
            return payload  # None → fall back to live
        if block.kind == "source":
            # The source card shows only its definition; "frozen" just means
            # "don't hydrate" — its query result feeds values, resolved below.
            return {}
        if block.kind == "value":
            src = await resolve_source(block.config.get("source"))
            if src is None:
                return None
            columns = src.get("columns") or []
            rows = src.get("rows") or []
            row = rows[0] if rows else None
            col = block.config.get("column")
            cell = None
            if row is not None and col in columns:
                cell = row[columns.index(col)]
            return {"text": _format_value(cell, block.config.get("format"))}
        if block.kind == "inline_embed":
            # Identity-only; the label is already server-resolved. Freezing is a
            # no-op (just suppresses per-viewer re-resolution).
            return {}
        return None  # custom kinds → T06's embed_precompute, else live

    warnings: list[dict] = []
    payloads: dict[str, dict] = {}
    frozen_data: list[dict] = []
    final_mode: dict[str, str] = {}

    for block in discovery.blocks:
        want = requested_mode(block.block_id)
        if want == "frozen" and (run_sql is not None or embed_precompute is not None):
            payload = None
            if run_sql is not None:
                payload = await freeze(block)
            if payload is None and embed_precompute is not None:
                # Custom-embed precompute hook (T06).
                payload = await embed_precompute(block)
            if payload is None:
                warnings.append(
                    {"block_id": block.block_id, "reason": "could not precompute"}
                )
                final_mode[block.block_id] = "live"
            else:
                final_mode[block.block_id] = "frozen"
                if computed_at and "columns" in payload:
                    payload = {**payload, "computed_at": computed_at}
                payloads[block.block_id] = payload
                frozen_data.append(
                    {
                        "block_id": block.block_id,
                        "kind": block.kind,
                        "payload_json": json.dumps(payload),
                        "computed_by": published_by,
                    }
                )
        else:
            final_mode[block.block_id] = "live"

    # Pass 2 — render with resolved modes + baked payloads.
    result = render_doc(
        doc_json,
        labels=labels,
        mode_for=lambda bid: final_mode.get(bid, "live"),
        payloads=payloads,
    )

    config = {
        "data_mode_default": data_mode_default,
        "block_overrides": block_overrides,
    }
    return {
        "html": result.html,
        "doc_json": json.dumps(doc_json),
        "has_live_blocks": result.has_live_blocks,
        "config_json": json.dumps(config),
        "frozen_data": frozen_data,
        "warnings": warnings,
        "blocks": [
            {"block_id": b.block_id, "kind": b.kind, "mode": final_mode[b.block_id]}
            for b in discovery.blocks
        ],
    }


def _embed_sql(config: dict) -> Optional[str]:
    """The SQL that bakes a built-in `block_embed`, or None if it isn't a
    table/view embed (row/database embeds aren't a single results table)."""
    ref = (config or {}).get("ref") or ""
    segs = [s for s in ref.strip("/").split("/") if s]
    if len(segs) == 2:
        # /db/table → all rows (capped). The table name is quoted; db is passed
        # separately to run_sql so it isn't part of the SQL text.
        table = segs[1].replace('"', '""')
        return f'select * from "{table}" limit {FROZEN_ROW_CAP}'
    return None


def make_sql_runner(datasette, actor) -> RunSql:
    """A permission-checked SQL runner for frozen-mode publishing.

    Runs ``sql`` against the named database **as ``actor``** (the publisher):
    returns ``{columns, rows, truncated}`` on success, or ``None`` when the
    db/sql is empty or the actor lacks ``execute-sql`` (which ``also_requires``
    ``view-database``) on that db — in which case the block falls back to live.
    """

    async def run_sql(db: Optional[str], sql: Optional[str]) -> Optional[dict]:
        if not db or not sql or not sql.strip():
            return None
        allowed = await datasette.allowed(
            action="execute-sql",
            resource=DatabaseResource(database=db),
            actor=actor,
        )
        if not allowed:
            return None
        try:
            database = datasette.get_database(db)
        except KeyError:
            return None
        try:
            results = await database.execute(sql, truncate=True)
        except Exception:
            return None
        return {
            "columns": list(results.columns),
            "rows": [list(row) for row in results.rows],
            "truncated": bool(results.truncated),
        }

    return run_sql


# --- minimal server-side port of frontend/src/lib/formatValue.ts -------------
# Frozen `value` atoms are formatted at publish time; keep these in step with
# the JS formatter so a frozen value reads the same as its live counterpart.

_DATE_STYLES = {"iso", "medium", "long"}


def _to_number(cell):
    if isinstance(cell, bool):
        return None
    if isinstance(cell, (int, float)):
        return cell
    if isinstance(cell, str) and cell.strip():
        try:
            return float(cell)
        except ValueError:
            return None
    return None


def _format_value(cell, fmt: Optional[dict]) -> str:
    fallback = (fmt or {}).get("fallback") or "—"
    if cell is None or cell == "":
        return fallback
    if not fmt:
        return str(cell)
    kind = fmt.get("kind")
    if kind == "text":
        return str(cell)
    if kind == "number":
        n = _to_number(cell)
        if n is None:
            return fallback
        thousands = fmt.get("thousands") is not False
        decimals = fmt.get("decimals")
        if decimals is not None:
            return f"{n:,.{int(decimals)}f}" if thousands else f"{n:.{int(decimals)}f}"
        if float(n).is_integer():
            return f"{int(n):,}" if thousands else str(int(n))
        return f"{n:,}" if thousands else str(n)
    if kind == "currency":
        n = _to_number(cell)
        if n is None:
            return fallback
        code = fmt.get("currency") or "USD"
        symbol = {"USD": "$", "EUR": "€", "GBP": "£"}.get(code, "")
        return f"{symbol}{n:,.2f}" if symbol else f"{n:,.2f} {code}"
    if kind == "percent":
        n = _to_number(cell)
        if n is None:
            return fallback
        decimals = fmt.get("decimals")
        d = int(decimals) if decimals is not None else 1
        return f"{n * 100:.{d}f}%"
    if kind == "date":
        return str(cell)
    return str(cell)
