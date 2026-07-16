/**
 * Command + fetch helpers for the `block_embed` node and the shared resource
 * picker. Mirrors `image.ts`: the NodeView (blockEmbedView.ts) renders,
 * this module owns the insert command and the network calls.
 *
 * The node stores only `ref` (a Datasette URL path) and `mode`; the rendered
 * table/row payload is fetched per viewer at mount time and never persisted —
 * the same id-only discipline mentions and wikilinks follow.
 *
 * **No custom backend.** These helpers hit Datasette's native browser JSON API
 * directly — `/<db>.json`, `/<db>/<table>.json`, `/<db>/<table>/<pk>.json` —
 * which already enforces the *requesting actor's* permissions via the
 * `ds_actor` cookie (same-origin GET, no CSRF). A `403` becomes `denied`, any
 * other non-ok becomes `not_found`, so a viewer never learns the existence or
 * contents of a resource they can't see. Search has no native cross-database
 * name endpoint, so it enumerates `/.json` + per-db `/<db>.json` and filters
 * client-side (1 + N requests — see todos/datasette-embeds/11). The internal
 * `EmbedPayload` / `SearchResult` / `DatasetteStatus` shapes are unchanged, so
 * the NodeViews that consume them are untouched.
 */
import { schema } from "./schema";
import type { Command } from "prosemirror-state";
import { iconMarkup } from "./icons";
import type { DatasetteStatus } from "./datasetteResolver";
import { filterQueryParams, type EmbedFilter, type EmbedSort } from "./embedFilters";

// `safeHref` moved to its own dependency-free module (shared with the schema
// render sink in schema.ts, which can't import from here without a cycle).
// Re-export so existing importers (blockEmbedView, inlineEmbedView) and the
// datasetteEmbed.test stay pointed here.
export { safeHref } from "./safeHref";

/** Default capped row count for a table embed when the caller gives none. */
export const DEFAULT_EMBED_LIMIT = 25;

/** A JSON-safe cell value: sqlite scalars, or a {$base64} envelope for blobs. */
export type CellValue = string | number | boolean | null | { $base64: true; encoded: string };

export type EmbedPayload =
  | {
      status: "ok";
      kind: "table" | "view";
      label: string;
      db: string;
      // The columns actually rendered, after any `config.columns` projection
      // (author order, PKs the author didn't pick dropped). Equals `allColumns`
      // when no column selection is active.
      columns: string[];
      // The full server-returned column set (pre-projection), so the column
      // picker can offer every column with the selected ones checked.
      allColumns: string[];
      // The table's primary-key column names (Datasette's `primary_keys`
      // extra). The column picker shows these as always-on (checked + disabled)
      // — projection happens client-side, but PKs are never hideable.
      primaryKeys: string[];
      rows: CellValue[][];
      count: number | null;
      // True when `count` hit Datasette's `count_limit` (the reported number is
      // `count_limit + 1`, so the real row total is *at least* that). Datasette
      // stops counting past the limit and returns limit+1 as a "there are more"
      // sentinel — see the `count_truncated` extra. The limit is configurable,
      // so the UI derives the threshold from `count` rather than hardcoding it.
      countTruncated: boolean;
      truncated: boolean;
      href: string;
    }
  | {
      status: "ok";
      kind: "row";
      label: string;
      db: string;
      table: string;
      pk: string;
      fields: { column: string; value: CellValue }[];
      href: string;
    }
  | {
      status: "ok";
      kind: "database";
      label: string;
      db: string;
      tables: {
        name: string;
        kind: "table" | "view";
        ref: string;
        href: string;
        count?: number | null;
      }[];
      href: string;
    }
  | { status: "denied" }
  | { status: "not_found" }
  // A server-reported fetch failure with a human-readable reason — e.g. a
  // filtered table fetch 400ing on a stale `_sort`/filter column. `message`
  // is Datasette's `error` string, rendered as a TEXT NODE by the NodeView.
  | { status: "error"; message: string };

export type SearchResult = {
  ref: string;
  kind: "table" | "view" | "database";
  label: string;
  db: string;
};

/** bootstrap-icon name to show for each resolved resource kind. */
export function kindIcon(kind: string | undefined): string {
  switch (kind) {
    case "database":
      return "database";
    case "view":
      return "eye";
    case "row":
      return "fileText";
    default:
      return "table";
  }
}

// Compatibility re-export for existing embed consumers; generic icon ownership
// lives in icons.ts.
export { iconMarkup } from "./icons";

/**
 * The icon `<svg>` markup to render for a resolved (ok) status. A third-party
 * provider may set `status.icon` to a raw inline-`<svg>` string, rendered as-is
 * in paper's header/pill chrome. This is intentionally NOT sanitized: a provider
 * bundle is trusted plugin JS that paper already `import()`s and runs (it owns
 * the whole block-card body via `mount`), so a raw icon SVG grants it nothing it
 * couldn't already do — see docs/EMBED_PROVIDERS.md. CSS clamps the rendered
 * size so an off-spec SVG can't blow out the chrome. Core refs leave `icon`
 * unset and get the kind's bundled icon.
 */
export function embedIconMarkup(
  status: Extract<DatasetteStatus, { status: "ok" }>,
): string {
  return status.icon ?? iconMarkup(kindIcon(status.kind));
}

/** Render a JSON-safe cell value as a display string (never HTML). */
export function cellText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "object") return "[binary]";
  return String(value);
}

/** A ProseMirror command that inserts a `block_embed` block at the selection. */
// @feat block-embed: insert command + native-JSON fetch helpers for block_embed
export function insertDatasetteEmbed(ref: string, mode = "table"): Command {
  return (state, dispatch) => {
    const node = schema.nodes.block_embed.create({ ref, mode });
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

// ---------------------------------------------------------------------------
// Native Datasette JSON helpers
// ---------------------------------------------------------------------------

/** Split a ref path into its segments: `/db/table/pk` → ["db","table","pk"]. */
export function refSegments(ref: string): string[] {
  return ref
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
}

// @feat embed-pk-links: Datasette tilde-encoding for row-page pk path segments
/**
 * Datasette's tilde-encoding for a row-PK path segment — a faithful port of
 * `datasette.utils.tilde_encode`. Encode the string as UTF-8; each byte in the
 * unreserved set `[A-Za-z0-9_-]` passes through, a space becomes `+`, and every
 * other byte becomes `~XX` (uppercase hex). So `/` → `~2F`, `.` → `~2E`, `~` →
 * `~7E`, `,` → `~2C`: this keeps a pk value disjoint from the `/`-delimited row
 * path and the `,` that joins the parts of a compound key. Datasette's route
 * resolver tilde-decodes the segment back, so a value containing any delimiter
 * round-trips unambiguously.
 */
export function tildeEncode(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    if (
      b === 0x2d || // -
      (b >= 0x30 && b <= 0x39) || // 0-9
      (b >= 0x41 && b <= 0x5a) || // A-Z
      b === 0x5f || // _
      (b >= 0x61 && b <= 0x7a) // a-z
    ) {
      out += String.fromCharCode(b);
    } else if (b === 0x20) {
      out += "+"; // space
    } else {
      out += "~" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** The native `.json` URL for a ref path (`/db/table` → `/db/table.json`). */
function jsonUrl(ref: string, query = ""): string {
  const path = "/" + refSegments(ref).join("/");
  return `${path}.json${query}`;
}

/** Map a non-ok native response to a leak-free embed/resolve status. */
function denialStatus(status: number | undefined): "denied" | "not_found" {
  return status === 403 ? "denied" : "not_found";
}

// @feat embed-filters: config.filters/sort → col__op / _sort params on the .json fetch
async function fetchTableEmbed(
  db: string,
  table: string,
  ref: string,
  limit: number,
  columns?: string[],
  filters?: EmbedFilter[],
  sort?: EmbedSort | null,
): Promise<EmbedPayload> {
  // `config.columns` (if any) is applied CLIENT-side only (the projection below)
  // — we deliberately do NOT send `?_col=`. Projecting on the server would make
  // the `columns` extra (→ `allColumns`) report just the selected columns, but
  // that field is contracted to be the table's *full* pre-projection schema: the
  // filter panel and the column picker both need every column, e.g. to render a
  // filter saved against a column the author has hidden (else its select shows a
  // blank "– column –"). The actor's cookie already grants full read on this
  // table, so fetching all columns and narrowing in the browser leaks nothing.
  const wanted = (columns ?? []).filter((c) => typeof c === "string" && c.length > 0);
  // `config.filters` / `config.sort` (sanitized by the caller) → the same
  // `column__op=value` / `_sort(_desc)` params Datasette's own table form
  // uses; URLSearchParams owns the encoding so crafted values stay one param.
  const filterPairs = filterQueryParams(filters ?? [], sort ?? null);
  const filterQs = new URLSearchParams(filterPairs).toString();
  const filterParams = filterQs ? `&${filterQs}` : "";
  // `_shape=arrays` (plural) returns the {columns, rows-as-arrays, count, next}
  // envelope; `_shape=array` (singular) would be a bare top-level array with
  // no columns/count. `_extra` adds count + columns + primary_keys + the
  // `count_truncated` flag (whether `count` hit the configurable count limit).
  // The filter/sort summary is rebuilt client-side from paper's own config, so
  // the server-phrased `human_description_en` extra isn't requested.
  const res = await fetch(
    jsonUrl(
      ref,
      `?_shape=arrays&_extra=count,count_truncated,columns,primary_keys&_size=${encodeURIComponent(String(limit))}${filterParams}`,
    ),
  );
  if (!res.ok) {
    // 403 stays the leak-free denied placeholder. Any other failure (a
    // filtered fetch can 400 on a stale filter/sort column, a type mismatch,
    // …) carries Datasette's `{ok: false, error}` body — surface that
    // message so an editor can fix the filter; unparseable body → not_found.
    if (res.status === 403) return { status: "denied" };
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error.length > 0) {
        return { status: "error", message: body.error };
      }
    } catch {
      /* non-JSON error body — fall through to the generic status */
    }
    return { status: "not_found" };
  }
  const j = (await res.json()) as {
    columns?: string[];
    rows?: CellValue[][];
    count?: number | null;
    count_truncated?: boolean;
    primary_keys?: string[];
    next?: string | null;
  };
  const allColumns = j.columns ?? [];
  const rows = j.rows ?? [];
  const count = typeof j.count === "number" ? j.count : null;
  const countTruncated = j.count_truncated === true;
  // Only the PKs that actually appear as columns (a defensive intersect — a
  // rowid table reports `[]`, and we never want to key a column that isn't shown).
  const primaryKeys = (Array.isArray(j.primary_keys) ? j.primary_keys : []).filter(
    (c): c is string => typeof c === "string" && allColumns.includes(c),
  );
  // Project to exactly the author's selection, in their order, dropping the
  // unselected columns (incl. PKs the author didn't pick) from the full
  // response. If every selected column has vanished from the schema, fall back
  // to the full response rather than rendering nothing.
  let outColumns = allColumns;
  let outRows = rows;
  if (wanted.length) {
    const keep = wanted.filter((c) => allColumns.includes(c));
    if (keep.length) {
      const idx = keep.map((c) => allColumns.indexOf(c));
      outColumns = keep;
      outRows = rows.map((row) => idx.map((i) => row[i]));
    }
  }
  return {
    status: "ok",
    kind: "table",
    label: table,
    db,
    columns: outColumns,
    allColumns,
    primaryKeys,
    rows: outRows,
    count,
    countTruncated,
    truncated: j.next != null || (count != null && count > rows.length),
    href: ref,
  };
}

async function fetchRowEmbed(
  db: string,
  table: string,
  pk: string,
  ref: string,
): Promise<EmbedPayload> {
  const res = await fetch(jsonUrl(ref, "?_shape=objects"));
  if (!res.ok) return { status: denialStatus(res.status) };
  const j = (await res.json()) as {
    rows?: Record<string, CellValue>[];
    columns?: string[];
  };
  const row = (j.rows ?? [])[0];
  if (!row) return { status: "not_found" };
  const columns = j.columns ?? Object.keys(row);
  return {
    status: "ok",
    kind: "row",
    label: pk,
    db,
    table,
    pk,
    fields: columns.map((column) => ({ column, value: row[column] ?? null })),
    href: ref,
  };
}

type NativeDbJson = {
  tables?: { name: string; count?: number | null; hidden?: boolean }[];
  views?: { name: string }[];
};

/** A table/view is plugin storage we never surface as an embeddable resource. */
function isPaperTable(name: string): boolean {
  return name.startsWith("_datasette_paper_");
}

async function fetchDatabaseEmbed(db: string, ref: string): Promise<EmbedPayload> {
  const res = await fetch(jsonUrl(ref));
  if (!res.ok) return { status: denialStatus(res.status) };
  const j = (await res.json()) as NativeDbJson;
  const tables: Extract<EmbedPayload, { kind: "database" }>["tables"] = [];
  for (const t of j.tables ?? []) {
    if (isPaperTable(t.name)) continue;
    tables.push({
      name: t.name,
      kind: "table",
      ref: `/${db}/${t.name}`,
      href: `/${db}/${t.name}`,
      count: typeof t.count === "number" ? t.count : null,
    });
  }
  for (const v of j.views ?? []) {
    if (isPaperTable(v.name)) continue;
    tables.push({
      name: v.name,
      kind: "view",
      ref: `/${db}/${v.name}`,
      href: `/${db}/${v.name}`,
    });
  }
  return { status: "ok", kind: "database", label: db, db, tables, href: ref };
}

/**
 * Fetch the read-only render payload for a ref. Network error → not_found.
 * `columns` (from a table/view embed's `config.columns`) restricts a
 * table/view to that column subset, in that order; `filters`/`sort` (the
 * sanitized `config.filters`/`config.sort`) restrict and order its rows.
 * All three are ignored for row/database refs.
 */
export async function fetchEmbed(
  ref: string,
  limit?: number,
  columns?: string[],
  filters?: EmbedFilter[],
  sort?: EmbedSort | null,
): Promise<EmbedPayload> {
  const seg = refSegments(ref);
  try {
    if (seg.length === 1) return await fetchDatabaseEmbed(seg[0], ref);
    if (seg.length === 2)
      return await fetchTableEmbed(
        seg[0],
        seg[1],
        ref,
        limit ?? DEFAULT_EMBED_LIMIT,
        columns,
        filters,
        sort,
      );
    if (seg.length === 3) return await fetchRowEmbed(seg[0], seg[1], seg[2], ref);
    return { status: "not_found" };
  } catch {
    return { status: "not_found" };
  }
}

/**
 * The two `/.json` `databases` shapes we tolerate: an array of `{name, …}`
 * objects (Datasette >=1.0a36) or an object keyed by name (pre-1.0a36).
 */
export type DatabasesShape = { name: string }[] | Record<string, unknown>;

/** Normalize either `/.json` `databases` shape to a flat list of names. */
export function databaseNames(databases?: DatabasesShape): string[] {
  if (!databases) return [];
  return Array.isArray(databases) ? databases.map((d) => d.name) : Object.keys(databases);
}

/**
 * Search visible databases / tables / views by name for the picker. No native
 * cross-database name search exists, so enumerate `/.json` (database names)
 * then each `/<db>.json` (its tables + views) and filter client-side. Prefix
 * matches sort first. 1 + N requests; fine for modestly-sized instances.
 */
export async function searchResources(q: string, limit = 20): Promise<SearchResult[]> {
  const ql = q.trim().toLowerCase();
  try {
    const top = await fetch("/.json");
    if (!top.ok) return [];
    // Datasette >=1.0a36 returns `databases` as an array of {name, …} objects;
    // pre-1.0a36 keyed them by name in an object. Accept both shapes.
    const tj = (await top.json()) as { databases?: DatabasesShape };
    // Datasette's internal databases are `_`-prefixed; never offer them.
    const dbNames = databaseNames(tj.databases).filter((n) => !n.startsWith("_"));

    const out: SearchResult[] = [];
    for (const db of dbNames) {
      if (!ql || db.toLowerCase().includes(ql)) {
        out.push({ ref: `/${db}`, kind: "database", label: db, db });
      }
    }

    const perDb = await Promise.all(
      dbNames.map(async (db): Promise<SearchResult[]> => {
        try {
          const res = await fetch(`/${db}.json`);
          if (!res.ok) return [];
          const j = (await res.json()) as NativeDbJson;
          const rows: SearchResult[] = [];
          for (const t of j.tables ?? []) {
            if (isPaperTable(t.name)) continue;
            if (ql && !t.name.toLowerCase().includes(ql)) continue;
            rows.push({ ref: `/${db}/${t.name}`, kind: "table", label: t.name, db });
          }
          for (const v of j.views ?? []) {
            if (isPaperTable(v.name)) continue;
            if (ql && !v.name.toLowerCase().includes(ql)) continue;
            rows.push({ ref: `/${db}/${v.name}`, kind: "view", label: v.name, db });
          }
          return rows;
        } catch {
          return [];
        }
      }),
    );
    for (const rows of perDb) out.push(...rows);

    out.sort(
      (a, b) =>
        Number(!a.label.toLowerCase().startsWith(ql)) -
          Number(!b.label.toLowerCase().startsWith(ql)) ||
        a.label.toLowerCase().localeCompare(b.label.toLowerCase()),
    );
    return out.slice(0, limit);
  } catch {
    return [];
  }
}
