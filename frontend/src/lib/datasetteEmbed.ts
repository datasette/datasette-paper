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
import { TOOLBAR_ICONS } from "./icons";
import type { DatasetteStatus } from "./datasetteResolver";

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
      columns: string[];
      rows: CellValue[][];
      count: number | null;
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
  | { status: "not_found" };

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

/** Paper's standard 14px inline-SVG envelope (currentColor, 16-unit viewBox). */
const ICON_SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">';

/** Full `<svg>` markup for a bundled icon name (its inner paths, wrapped). */
export function iconMarkup(name: string): string {
  return `${ICON_SVG_OPEN}${TOOLBAR_ICONS[name as keyof typeof TOOLBAR_ICONS] ?? ""}</svg>`;
}

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

/**
 * Sanitize an href before it touches the DOM. Allows only same-origin
 * relative paths and absolute `http(s)` URLs; everything else (notably
 * `javascript:` / `data:`) collapses to "#". Core refs are always relative
 * paths, but a third-party provider's `resolve` could supply an arbitrary
 * `href`, so guard at every assignment site.
 */
export function safeHref(href: string | undefined): string {
  if (!href) return "#";
  if (href.startsWith("/") && !href.startsWith("//")) return href; // relative path
  try {
    const u = new URL(href, window.location.origin);
    return u.protocol === "http:" || u.protocol === "https:" ? href : "#";
  } catch {
    return "#";
  }
}

/** Render a JSON-safe cell value as a display string (never HTML). */
export function cellText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "object") return "[binary]";
  return String(value);
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

/** The native `.json` URL for a ref path (`/db/table` → `/db/table.json`). */
function jsonUrl(ref: string, query = ""): string {
  const path = "/" + refSegments(ref).join("/");
  return `${path}.json${query}`;
}

/** Map a non-ok native response to a leak-free embed/resolve status. */
function denialStatus(status: number | undefined): "denied" | "not_found" {
  return status === 403 ? "denied" : "not_found";
}

async function fetchTableEmbed(
  db: string,
  table: string,
  ref: string,
  limit: number,
): Promise<EmbedPayload> {
  // `_shape=arrays` (plural) returns the {columns, rows-as-arrays, count, next}
  // envelope; `_shape=array` (singular) would be a bare top-level array with
  // no columns/count. `_extra` adds count + columns to the envelope.
  const res = await fetch(
    jsonUrl(ref, `?_shape=arrays&_extra=count,columns&_size=${encodeURIComponent(String(limit))}`),
  );
  if (!res.ok) return { status: denialStatus(res.status) };
  const j = (await res.json()) as {
    columns?: string[];
    rows?: CellValue[][];
    count?: number | null;
    next?: string | null;
  };
  const rows = j.rows ?? [];
  const count = typeof j.count === "number" ? j.count : null;
  return {
    status: "ok",
    kind: "table",
    label: table,
    db,
    columns: j.columns ?? [],
    rows,
    count,
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

/** Fetch the read-only render payload for a ref. Network error → not_found. */
export async function fetchEmbed(ref: string, limit?: number): Promise<EmbedPayload> {
  const seg = refSegments(ref);
  try {
    if (seg.length === 1) return await fetchDatabaseEmbed(seg[0], ref);
    if (seg.length === 2) return await fetchTableEmbed(seg[0], seg[1], ref, limit ?? DEFAULT_EMBED_LIMIT);
    if (seg.length === 3) return await fetchRowEmbed(seg[0], seg[1], seg[2], ref);
    return { status: "not_found" };
  } catch {
    return { status: "not_found" };
  }
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
    const tj = (await top.json()) as { databases?: Record<string, unknown> };
    // Datasette's internal databases are `_`-prefixed; never offer them.
    const dbNames = Object.keys(tj.databases ?? {}).filter((n) => !n.startsWith("_"));

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
