"""Resolve / search / render references to Datasette resources.

A ``ref`` is a Datasette URL path string identifying a database, table,
view, or row — e.g. ``/fixtures``, ``/fixtures/facetable``,
``/fixtures/facetable/42``. The ``datasette_ref`` (inline) and
``datasette_embed`` (block) nodes store only this path; display labels and
rendered data are produced here at view time and never persisted.

**Per-viewer discipline.** Every helper permission-checks against the
*requesting actor*, not the doc owner — a Paper is shareable and viewers
have different Datasette permissions. ``denied`` / ``not_found`` responses
carry NO label or data, so we never leak the existence, name, or contents
of a resource the viewer can't see. This mirrors ``_resolve_map`` in
``routes/docs.py``.

**Provider-dispatch seam (forward-compat with ticket 06).** Resolution and
rendering go through ``_provider_for(...)``, which will eventually offer a
ref to any registered ``paper_resource_provider`` hook before falling back
to the built-in core-Datasette provider. Only the built-in provider ships
today; the seam keeps the door open without coupling callers to it.
"""

import base64

from datasette.resources import DatabaseResource, TableResource
from datasette.utils import escape_sqlite, tilde_encode
from datasette.utils.asgi import DatabaseNotFound, RowNotFound, TableNotFound

# Datasette's internal database (holds the plugin's own `_datasette_paper_*`
# tables); never offered as an embeddable resource.
INTERNAL_DB_NAME = "__INTERNAL__"

# Caps mirrored by the route layer.
MAX_RESOLVE_REFS = 100
DEFAULT_EMBED_LIMIT = 25
MAX_EMBED_LIMIT = 100

# A short per-table count budget so resolving a ref against a huge table never
# blocks; on timeout we return count=None and the UI omits the total.
_COUNT_TIME_LIMIT_MS = 200


class _RefRequest:
    """Minimal stand-in for an ASGI ``Request`` exposing only ``url_vars`` —
    all that Datasette's ``resolve_database`` / ``resolve_table`` /
    ``resolve_row`` read. Lets us reuse core's path resolution (tilde
    decoding, compound pks, rowid tables, view detection) instead of
    re-implementing it."""

    def __init__(self, url_vars):
        self.url_vars = url_vars


def json_safe(value):
    """Coerce a sqlite cell value into something ``json.dumps`` accepts.

    Mirrors Datasette's ``CustomJSONEncoder``: bytes decode as UTF-8 when
    possible, else become a ``{"$base64": ...}`` envelope. Everything sqlite
    otherwise yields (int / float / str / None) is already JSON-safe.
    """
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return {
                "$base64": True,
                "encoded": base64.b64encode(value).decode("latin1"),
            }
    return value


def _strip_base_url(datasette, ref):
    base = datasette.setting("base_url") or "/"
    if base != "/" and ref.startswith(base):
        ref = "/" + ref[len(base) :]
    return ref


def _split_ref(datasette, ref):
    """Split a ref path into its (still tilde-encoded) segments, or None.

    ``/fixtures`` → ``["fixtures"]`` (database)
    ``/fixtures/facetable`` → ``["fixtures", "facetable"]`` (table/view)
    ``/fixtures/facetable/42`` → ``["fixtures", "facetable", "42"]`` (row)
    """
    if not ref or not isinstance(ref, str):
        return None
    path = _strip_base_url(datasette, ref.strip()).strip("/")
    if not path:
        return None
    return path.split("/")


# ---------------------------------------------------------------------------
# Built-in core-Datasette provider
# ---------------------------------------------------------------------------


class _CoreDatasetteProvider:
    """Resolves/renders refs that point at core Datasette databases, tables,
    views, and rows. The default (and currently only) provider."""

    def claims(self, datasette, segments):
        # Core claims any well-formed db / table / row path. Future plugin
        # providers (ticket 06) get first refusal before this fallback.
        return 1 <= len(segments) <= 3

    async def resolve(self, datasette, actor, segments):
        if len(segments) == 1:
            return await self._resolve_database(datasette, actor, segments[0])
        if len(segments) == 2:
            return await self._resolve_table(datasette, actor, segments)
        if len(segments) == 3:
            return await self._resolve_row(datasette, actor, segments)
        return {"status": "not_found"}

    async def render(self, datasette, actor, segments, limit):
        if len(segments) == 1:
            return await self._render_database(datasette, actor, segments[0])
        if len(segments) == 2:
            return await self._render_table(datasette, actor, segments, limit)
        if len(segments) == 3:
            return await self._render_row(datasette, actor, segments)
        return {"status": "not_found"}

    # -- resolution -------------------------------------------------------

    async def _resolve_database(self, datasette, actor, db_seg):
        try:
            db = await datasette.resolve_database(_RefRequest({"database": db_seg}))
        except DatabaseNotFound:
            return {"status": "not_found"}
        if not await _can_view_database(datasette, actor, db.name):
            return {"status": "denied"}
        return {
            "status": "ok",
            "kind": "database",
            "label": db.name,
            "db": db.name,
            "href": datasette.urls.database(db.name),
        }

    async def _resolve_table(self, datasette, actor, segments):
        try:
            resolved = await datasette.resolve_table(
                _RefRequest({"database": segments[0], "table": segments[1]})
            )
        except (DatabaseNotFound, TableNotFound):
            return {"status": "not_found"}
        db, table, is_view = resolved.db, resolved.table, resolved.is_view
        if not await _can_view_table(datasette, actor, db.name, table):
            return {"status": "denied"}
        out = {
            "status": "ok",
            "kind": "view" if is_view else "table",
            "label": table,
            "db": db.name,
            "href": datasette.urls.table(db.name, table),
        }
        if not is_view:
            out["count"] = await _table_count(db, table)
        return out

    async def _resolve_row(self, datasette, actor, segments):
        db_seg, table_seg, pks_seg = segments
        # Permission is on the table; check it before fetching the row so a
        # denied viewer never triggers a query.
        try:
            resolved_table = await datasette.resolve_table(
                _RefRequest({"database": db_seg, "table": table_seg})
            )
        except (DatabaseNotFound, TableNotFound):
            return {"status": "not_found"}
        db, table = resolved_table.db, resolved_table.table
        if not await _can_view_table(datasette, actor, db.name, table):
            return {"status": "denied"}
        try:
            resolved = await datasette.resolve_row(
                _RefRequest({"database": db_seg, "table": table_seg, "pks": pks_seg})
            )
        except (DatabaseNotFound, TableNotFound, RowNotFound):
            return {"status": "not_found"}
        label = await _row_label(db, table, resolved.row, resolved.pk_values)
        return {
            "status": "ok",
            "kind": "row",
            "label": label,
            "db": db.name,
            "table": table,
            "pk": pks_seg,
            "href": datasette.urls.row(db.name, table, pks_seg),
        }

    # -- rendering --------------------------------------------------------

    async def _render_database(self, datasette, actor, db_seg):
        """List the tables/views in a database the actor can see, with a
        best-effort row count per table (the only metadata readily available
        without a per-table schema fetch). Mirrors the enumeration +
        permission filter in ``search_resources``."""
        try:
            db = await datasette.resolve_database(_RefRequest({"database": db_seg}))
        except DatabaseNotFound:
            return {"status": "not_found"}
        if not await _can_view_database(datasette, actor, db.name):
            return {"status": "denied"}
        views = set(await db.view_names())
        tables = []
        for name in (await db.table_names()) + sorted(views):
            if name.startswith("_datasette_paper_"):
                continue
            if not await _can_view_table(datasette, actor, db.name, name):
                continue
            is_view = name in views
            entry = {
                "name": name,
                "kind": "view" if is_view else "table",
                "ref": "/" + tilde_encode(db.name) + "/" + tilde_encode(name),
                "href": datasette.urls.table(db.name, name),
            }
            if not is_view:
                entry["count"] = await _table_count(db, name)
            tables.append(entry)
        return {
            "status": "ok",
            "kind": "database",
            "label": db.name,
            "db": db.name,
            "tables": tables,
            "href": datasette.urls.database(db.name),
        }

    async def _render_table(self, datasette, actor, segments, limit):
        try:
            resolved = await datasette.resolve_table(
                _RefRequest({"database": segments[0], "table": segments[1]})
            )
        except (DatabaseNotFound, TableNotFound):
            return {"status": "not_found"}
        db, table, is_view = resolved.db, resolved.table, resolved.is_view
        if not await _can_view_table(datasette, actor, db.name, table):
            return {"status": "denied"}
        # Fetch one extra row to detect truncation without trusting count.
        results = await db.execute(
            f"select * from {escape_sqlite(table)} limit {int(limit) + 1}"
        )
        rows = list(results.rows)
        truncated = len(rows) > limit
        rows = rows[:limit]
        count = None if is_view else await _table_count(db, table)
        return {
            "status": "ok",
            "kind": "view" if is_view else "table",
            "label": table,
            "db": db.name,
            "columns": results.columns,
            "rows": [[json_safe(v) for v in row] for row in rows],
            "count": count,
            "truncated": truncated,
            "href": datasette.urls.table(db.name, table),
        }

    async def _render_row(self, datasette, actor, segments):
        db_seg, table_seg, pks_seg = segments
        try:
            resolved_table = await datasette.resolve_table(
                _RefRequest({"database": db_seg, "table": table_seg})
            )
        except (DatabaseNotFound, TableNotFound):
            return {"status": "not_found"}
        db, table = resolved_table.db, resolved_table.table
        if not await _can_view_table(datasette, actor, db.name, table):
            return {"status": "denied"}
        try:
            resolved = await datasette.resolve_row(
                _RefRequest({"database": db_seg, "table": table_seg, "pks": pks_seg})
            )
        except (DatabaseNotFound, TableNotFound, RowNotFound):
            return {"status": "not_found"}
        row = resolved.row
        label = await _row_label(db, table, row, resolved.pk_values)
        fields = [{"column": col, "value": json_safe(row[col])} for col in row.keys()]
        return {
            "status": "ok",
            "kind": "row",
            "label": label,
            "db": db.name,
            "table": table,
            "pk": pks_seg,
            "fields": fields,
            "href": datasette.urls.row(db.name, table, pks_seg),
        }


_CORE_PROVIDER = _CoreDatasetteProvider()

# Future: populated from the `paper_resource_provider` hook (ticket 06).
_PROVIDERS = []


def _provider_for(datasette, segments):
    for provider in _PROVIDERS:
        if provider.claims(datasette, segments):
            return provider
    return _CORE_PROVIDER


# ---------------------------------------------------------------------------
# Permission + label + count helpers
# ---------------------------------------------------------------------------


async def _can_view_database(datasette, actor, db_name):
    return await datasette.allowed(
        action="view-database",
        resource=DatabaseResource(database=db_name),
        actor=actor,
    )


async def _can_view_table(datasette, actor, db_name, table):
    return await datasette.allowed(
        action="view-table",
        resource=TableResource(database=db_name, table=table),
        actor=actor,
    )


async def _table_count(db, table):
    """Best-effort row count, bounded by a short time limit (None on timeout
    or error so a huge table never stalls resolution)."""
    try:
        results = await db.execute(
            f"select count(*) from {escape_sqlite(table)}",
            custom_time_limit=_COUNT_TIME_LIMIT_MS,
        )
        return results.first()[0]
    except Exception:
        return None


async def _row_label(db, table, row, pk_values):
    """A display label for a row: the table's label column if it has one,
    else the (compound) primary key joined."""
    try:
        label_column = await db.label_column_for_table(table)
    except Exception:
        label_column = None
    if label_column and label_column in row.keys():
        value = row[label_column]
        if value is not None:
            return str(value)
    return ", ".join(str(v) for v in pk_values)


# ---------------------------------------------------------------------------
# Public entry points (called by routes/datasette.py)
# ---------------------------------------------------------------------------


async def resolve_ref(datasette, actor, ref):
    """Resolve a single ref to ``{status, kind, label, ...}`` for the actor."""
    segments = _split_ref(datasette, ref)
    if segments is None:
        return {"status": "not_found"}
    return await _provider_for(datasette, segments).resolve(datasette, actor, segments)


async def resolve_refs(datasette, actor, refs):
    """Batch ``resolve_ref`` — returns ``{ref: result}`` for each input ref."""
    out = {}
    for ref in refs:
        out[ref] = await resolve_ref(datasette, actor, ref)
    return out


async def render_ref(datasette, actor, ref, limit=DEFAULT_EMBED_LIMIT):
    """Render a ref to an embed payload (table rows / row fields) for the
    actor. ``denied`` / ``not_found`` carry no data."""
    segments = _split_ref(datasette, ref)
    if segments is None:
        return {"status": "not_found"}
    return await _provider_for(datasette, segments).render(
        datasette, actor, segments, limit
    )


async def search_resources(datasette, actor, q, limit=20):
    """Databases / tables / views the actor can see whose name matches ``q``
    (prefix matches first). Excludes the internal DB and Paper's own tables."""
    q_low = (q or "").lower()
    results = []
    for db_name, db in datasette.databases.items():
        if db_name == INTERNAL_DB_NAME:
            continue
        if not await _can_view_database(datasette, actor, db.name):
            continue
        # The database itself is selectable (renders as a table listing).
        if not q_low or q_low in db.name.lower():
            results.append(
                {
                    "ref": "/" + tilde_encode(db.name),
                    "kind": "database",
                    "label": db.name,
                    "db": db.name,
                }
            )
        views = set(await db.view_names())
        for name in (await db.table_names()) + list(views):
            if name.startswith("_datasette_paper_"):
                continue
            if q_low and q_low not in name.lower():
                continue
            if not await _can_view_table(datasette, actor, db.name, name):
                continue
            results.append(
                {
                    "ref": "/" + tilde_encode(db.name) + "/" + tilde_encode(name),
                    "kind": "view" if name in views else "table",
                    "label": name,
                    "db": db.name,
                }
            )
    results.sort(
        key=lambda r: (not r["label"].lower().startswith(q_low), r["label"].lower())
    )
    return results[:limit]
