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

**Provider-dispatch seam.** Resolution and rendering go through
``_provider_for(...)``, which offers a (normalized) ref to each provider
returned by the ``paper_resource_provider`` hook before falling back to the
built-in core-Datasette provider. External providers (e.g. datasette-places)
claim their own URL namespace, supply labels + render payloads, and enforce
their own permissions. See ``hookspecs.py`` for the provider interface.
"""

import base64
import logging

from datasette.resources import DatabaseResource, TableResource
from datasette.utils import escape_sqlite, tilde_encode
from datasette.utils.asgi import DatabaseNotFound, RowNotFound, TableNotFound

logger = logging.getLogger(__name__)

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


def _normalize_ref(datasette, ref):
    """Normalize a ref to a base_url-relative path with a single leading slash
    (e.g. ``/fixtures/facetable`` or ``/-/places/list/5``), or None. Providers
    claim and resolve against this normalized form — base_url is stripped once,
    centrally, so providers don't each re-handle it."""
    if not ref or not isinstance(ref, str):
        return None
    path = _strip_base_url(datasette, ref.strip())
    if not path.startswith("/"):
        path = "/" + path
    if len(path) > 1:
        path = path.rstrip("/")
    return path or None


def _segments(ref):
    """The (still tilde-encoded) path segments of a normalized ref.

    ``/fixtures`` → ``["fixtures"]`` (database)
    ``/fixtures/facetable`` → ``["fixtures", "facetable"]`` (table/view)
    ``/fixtures/facetable/42`` → ``["fixtures", "facetable", "42"]`` (row)
    """
    return [s for s in (ref or "").strip("/").split("/") if s]


# ---------------------------------------------------------------------------
# Built-in core-Datasette provider
# ---------------------------------------------------------------------------


class _CoreDatasetteProvider:
    """Resolves/renders refs that point at core Datasette databases, tables,
    views, and rows — the built-in fallback provider behind the
    ``paper_resource_provider`` dispatch seam. Operates on a base_url-relative
    ref string (the dispatcher normalizes before claiming)."""

    def claims(self, ref):
        # Core claims any well-formed db / table / row path. External plugin
        # providers get first refusal before this fallback; Datasette tooling
        # / static / plugin paths (leading "-" or "_") are not core resources.
        segments = _segments(ref)
        return bool(
            segments
            and 1 <= len(segments) <= 3
            and not segments[0].startswith(("-", "_"))
        )

    async def resolve(self, datasette, actor, ref):
        segments = _segments(ref)
        if len(segments) == 1:
            return await self._resolve_database(datasette, actor, segments[0])
        if len(segments) == 2:
            return await self._resolve_table(datasette, actor, segments)
        if len(segments) == 3:
            return await self._resolve_row(datasette, actor, segments)
        return {"status": "not_found"}

    async def render(self, datasette, actor, ref, mode, limit):
        segments = _segments(ref)
        if len(segments) == 1:
            return await self._render_database(datasette, actor, segments[0])
        if len(segments) == 2:
            return await self._render_table(datasette, actor, segments, limit)
        if len(segments) == 3:
            return await self._render_row(datasette, actor, segments)
        return {"status": "not_found"}

    def frontend_assets(self, datasette):
        return {"js": [], "css": []}

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


def _external_providers(datasette):
    """Providers contributed by sibling plugins via `paper_resource_provider`.
    Each hookimpl may return one provider or a list; flatten and drop Nones."""
    from datasette.plugins import pm

    providers = []
    hook = getattr(pm.hook, "paper_resource_provider", None)
    if hook is None:
        return providers
    for result in hook(datasette=datasette) or []:
        if result is None:
            continue
        if isinstance(result, (list, tuple)):
            providers.extend(p for p in result if p is not None)
        else:
            providers.append(result)
    return providers


def _provider_for(datasette, ref):
    """The first external provider claiming `ref`, else the built-in core
    provider. `ref` is already normalized (see `_normalize_ref`)."""
    for provider in _external_providers(datasette):
        try:
            if provider.claims(ref):
                return provider
        except Exception:
            logger.exception("paper_resource_provider.claims raised for %r", ref)
    return _CORE_PROVIDER


# Identifier for the built-in core-Datasette picker source. Reserved so an
# external provider can't shadow it.
CORE_SOURCE_ID = "datasette"


def pickable_sources(datasette):
    """Browsable insert "sources" contributed by external providers — the
    optional `picker()` method on a provider returns ``{id, label, icon,
    mode?}`` to opt in (e.g. datasette-places → "Places map"). The built-in
    core-Datasette source is offered by the frontend directly and is NOT
    listed here. Returns a deduped list (first declaration of an id wins;
    `CORE_SOURCE_ID` is reserved)."""
    sources = []
    seen = {CORE_SOURCE_ID}
    for provider in _external_providers(datasette):
        getter = getattr(provider, "picker", None)
        if getter is None:
            continue
        try:
            spec = getter() or None
        except Exception:
            logger.exception("paper_resource_provider.picker raised")
            continue
        if not isinstance(spec, dict):
            continue
        source_id = spec.get("id")
        if not source_id or source_id in seen:
            continue
        seen.add(source_id)
        sources.append(
            {
                "id": source_id,
                "label": spec.get("label") or source_id,
                "icon": spec.get("icon") or "database",
                "mode": spec.get("mode") or "block",
            }
        )
    return sources


def _provider_by_source_id(datasette, source_id):
    """The external provider whose `picker()` declares `source_id`, or None."""
    for provider in _external_providers(datasette):
        getter = getattr(provider, "picker", None)
        if getter is None:
            continue
        try:
            spec = getter() or {}
        except Exception:
            logger.exception("paper_resource_provider.picker raised")
            continue
        if isinstance(spec, dict) and spec.get("id") == source_id:
            return provider
    return None


def provider_frontend_assets(datasette):
    """Dedup'd JS/CSS asset URLs declared by all registered providers, for
    injection into the paper editor page (see `extra_js_urls` in __init__)."""
    js, css = [], []
    for provider in _external_providers(datasette):
        getter = getattr(provider, "frontend_assets", None)
        if getter is None:
            continue
        try:
            assets = getter(datasette) or {}
        except Exception:
            logger.exception("paper_resource_provider.frontend_assets raised")
            continue
        for url in assets.get("js", []) or []:
            if url not in js:
                js.append(url)
        for url in assets.get("css", []) or []:
            if url not in css:
                css.append(url)
    return {"js": js, "css": css}


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
    """Resolve a single ref to ``{status, kind, label, ...}`` for the actor,
    dispatching to a `paper_resource_provider` that claims it, else core."""
    norm = _normalize_ref(datasette, ref)
    if norm is None:
        return {"status": "not_found"}
    return await _provider_for(datasette, norm).resolve(datasette, actor, norm)


async def resolve_refs(datasette, actor, refs):
    """Batch ``resolve_ref`` — returns ``{ref: result}`` for each input ref
    (keyed by the original, un-normalized ref the client sent)."""
    out = {}
    for ref in refs:
        out[ref] = await resolve_ref(datasette, actor, ref)
    return out


async def render_ref(datasette, actor, ref, mode="table", limit=DEFAULT_EMBED_LIMIT):
    """Render a ref to an embed payload for the actor, dispatching like
    ``resolve_ref``. ``denied`` / ``not_found`` carry no data."""
    norm = _normalize_ref(datasette, ref)
    if norm is None:
        return {"status": "not_found"}
    return await _provider_for(datasette, norm).render(
        datasette, actor, norm, mode, limit
    )


async def search_resources(datasette, actor, q, limit=20, source=None):
    """Resources the actor can see whose name matches ``q`` (prefix first).

    With no ``source`` (or the reserved ``CORE_SOURCE_ID``) this searches core
    Datasette databases / tables / views — excluding the internal DB and
    Paper's own tables. With a provider ``source`` id it dispatches to that
    provider's optional ``search(datasette, actor, q, limit)`` method (e.g.
    datasette-places searching the actor's place lists). An unknown source, or
    a provider without ``search``, yields ``[]`` — permission filtering and
    leak discipline are the provider's responsibility, same as ``resolve``.
    """
    if source and source != CORE_SOURCE_ID:
        provider = _provider_by_source_id(datasette, source)
        searcher = getattr(provider, "search", None) if provider else None
        if searcher is None:
            return []
        try:
            results = await searcher(datasette, actor, q or "", limit)
        except Exception:
            logger.exception("paper_resource_provider.search raised for %r", source)
            return []
        return list(results or [])[:limit]
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


async def resource_access_gap(datasette, doc_id, ref):
    """Which named viewers of ``doc_id`` can't see the resource ``ref``.

    The embed analogue of ``link_access_check`` (06 §#8): a best-effort
    authoring aid, never a security control. For each named paper-view
    collaborator we ``resolve`` the ref *as that actor* through the same
    provider dispatch the embed render uses — a non-``ok`` status means they
    can't see it. ``open_audience`` mirrors ``named_viewers``: the doc's
    audience can't be fully enumerated, so the answer is necessarily partial.

    Returns ``{"gap": bool, "missing": [actor_id…], "open_audience": bool}``.
    """
    from .permissions import named_viewers

    named, open_audience = await named_viewers(datasette, doc_id)
    missing = []
    for actor_id in named:
        result = await resolve_ref(datasette, {"id": actor_id}, ref)
        if (result or {}).get("status") != "ok":
            missing.append(actor_id)
    return {
        "gap": bool(missing),
        "missing": sorted(missing),
        "open_audience": open_audience,
    }
