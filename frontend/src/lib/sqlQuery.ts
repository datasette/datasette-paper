/**
 * Client-side helpers for the SQL query block.
 *
 * Results are fetched directly from Datasette's native query JSON API
 * (`/{db}/-/query.json?sql=…`) with the viewer's cookie — Datasette enforces
 * their own `execute-sql` permission, so paper never executes SQL itself
 * (mirrors how `block_embed` hits `/{db}/{table}.json` directly). A 403 maps
 * to a leak-free `denied`; a SQL error maps to `error` with the message (safe
 * to show — it's the viewer's own query against a db they can reach).
 */
import { schema } from "./schema";
import type { Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { CellValue } from "./datasetteEmbed";

export interface SqlResult {
  status: "ok" | "denied" | "error" | "empty";
  columns?: string[];
  rows?: CellValue[][];
  truncated?: boolean;
  error?: string;
}

/** The Datasette HTML page for a query — used for the "open in Datasette" link. */
export function queryHref(db: string, sql: string): string {
  return `/${encodeURIComponent(db)}/-/query?sql=${encodeURIComponent(sql)}`;
}

/** Run a read-only query against a named Datasette database. */
export async function runSqlQuery(db: string, sql: string): Promise<SqlResult> {
  if (!db || !sql.trim()) return { status: "empty" };
  // `_extra=columns` is required — Datasette strips `columns` from query JSON
  // otherwise (renderer.py / datasette#2136), leaving the result headerless.
  const url = `/${encodeURIComponent(db)}/-/query.json?sql=${encodeURIComponent(
    sql,
  )}&_shape=arrays&_extra=columns`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 403) return { status: "denied" };
    const j = (await res.json().catch(() => null)) as {
      ok?: boolean;
      rows?: CellValue[][];
      columns?: string[];
      truncated?: boolean;
      error?: string;
    } | null;
    if (!res.ok || !j) {
      return { status: "error", error: (j && j.error) || `Query failed (${res.status})` };
    }
    if (j.error) return { status: "error", error: String(j.error) };
    return {
      status: "ok",
      columns: j.columns ?? [],
      rows: j.rows ?? [],
      truncated: !!j.truncated,
    };
  } catch {
    return { status: "error", error: "Could not reach the database" };
  }
}

/**
 * Enumerate queryable databases by name. No native cross-database listing
 * exists beyond `/.json`; filter out internal/paper databases (the `_`-prefix
 * convention `searchResources` uses).
 */
export async function listQueryableDatabases(): Promise<string[]> {
  try {
    const res = await fetch("/.json", { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const j = (await res.json()) as { databases?: Record<string, unknown> };
    return Object.keys(j.databases ?? {}).filter((n) => !n.startsWith("_"));
  } catch {
    return [];
  }
}

// ── Result export (client-side, from the rows already fetched) ──────────────
// Datasette caps arbitrary-query results at `max_returned_rows` (default 1000)
// and even .csv doesn't paginate a raw query past it — so exporting the fetched
// rows is exactly as complete as a server round-trip would be. When the result
// is `truncated`, the caller surfaces a warning (the export is the first N rows).
//
// The serializers themselves live in `tableExport.ts` (shared with the table
// `block_embed`); re-exported here so existing SQL-block imports keep working.
export { rowsToCsv, rowsToJson } from "./tableExport";

/** A ProseMirror command that inserts an empty `sql_block` at the selection. */
export function insertSqlBlock(db: string | null = null): Command {
  return (state, dispatch) => {
    const node = schema.nodes.sql_block.create({ db, hidden: false });
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

/** Imperative variant for the slash menu (which hands us a view, not state). */
export function runInsertSqlBlock(view: EditorView, db: string | null = null): void {
  insertSqlBlock(db)(view.state, view.dispatch);
  view.focus();
}
