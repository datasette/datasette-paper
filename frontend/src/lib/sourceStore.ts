/**
 * Live runtime for inline SQL values.
 *
 * The doc holds `source` nodes (named queries) and `value` inline atoms that
 * reference them as `${{source.column}}`. This store is the bridge: on every
 * doc change it scans for `source` nodes, runs each *distinct* source's query
 * **once** (reusing `runSqlQuery`, so Datasette enforces the viewer's own
 * `execute-sql` per database), caches the first row, and fans the result out to
 * every `value` NodeView subscribed by source name.
 *
 * Properties this guarantees:
 *  - **Dedup**: N `${{revenue.*}}` chips share one fetch of `revenue`.
 *  - **No needless refetch**: a source is re-run only when its `(db, sql)`
 *    actually changes — keystroke-level collab steps that don't touch a source
 *    don't hammer Datasette.
 *  - **Per-viewer / ephemeral**: results live here in instance state only, never
 *    in node attrs / steps / snapshots; re-fetched on mount.
 *
 * Decoupled from `EditorView` on purpose (it takes the doc via `sync(doc)`),
 * which keeps it trivially unit-testable. `collab.ts` calls `sync` whenever the
 * doc changes; NodeViews call `subscribe`.
 */
import { runSqlQuery } from "./sqlQuery";
import type { Node as PMNode } from "prosemirror-model";
import type { CellValue } from "./datasetteEmbed";

export type SourceState =
  | { status: "loading" }
  | { status: "ok"; columns: string[]; row: CellValue[] | null }
  | { status: "denied" }
  | { status: "error"; error: string }
  | { status: "missing" }; // no `source` node with that name in the doc

type Subscriber = (state: SourceState) => void;

type Def = { db: string | null; sql: string; token: number };

/** Walk the doc for `source` nodes → name → {db, sql}. Last write wins on a
 *  duplicate name (the Sources panel surfaces duplicates separately). */
function scanSources(doc: PMNode): Map<string, { db: string | null; sql: string }> {
  const found = new Map<string, { db: string | null; sql: string }>();
  doc.descendants((node) => {
    if (node.type.name === "source" && node.attrs.name) {
      found.set(String(node.attrs.name), {
        db: (node.attrs.db as string | null) ?? null,
        sql: node.textContent,
      });
    }
    // sources are top-level blocks; no need to descend into them
    return node.type.name !== "source";
  });
  return found;
}

// @feat source: scan source nodes, run each query once, fan rows to value views
export class SourceStore {
  private defs = new Map<string, Def>();
  private states = new Map<string, SourceState>();
  private subs = new Map<string, Set<Subscriber>>();

  /** Re-scan the doc; (re)run sources whose (db, sql) changed; notify subs. */
  sync(doc: PMNode): void {
    const found = scanSources(doc);

    // Sources that vanished → mark their subscribers as missing.
    for (const name of [...this.defs.keys()]) {
      if (!found.has(name)) {
        this.defs.delete(name);
        this.setState(name, { status: "missing" });
      }
    }

    // New or changed sources → run; unchanged → leave as-is (the dedup +
    // no-refetch guarantee).
    for (const [name, { db, sql }] of found) {
      const prev = this.defs.get(name);
      if (prev && prev.db === db && prev.sql === sql) continue;
      const token = (prev?.token ?? 0) + 1;
      this.defs.set(name, { db, sql, token });
      void this.run(name);
    }
  }

  /** Subscribe to a source's state by name. Fires immediately with the current
   *  state, then on every change. Returns an unsubscribe function. */
  subscribe(name: string, cb: Subscriber): () => void {
    let set = this.subs.get(name);
    if (!set) {
      set = new Set();
      this.subs.set(name, set);
    }
    set.add(cb);
    cb(this.getState(name));
    return () => {
      const s = this.subs.get(name);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.subs.delete(name);
    };
  }

  getState(name: string): SourceState {
    const s = this.states.get(name);
    if (s) return s;
    return this.defs.has(name) ? { status: "loading" } : { status: "missing" };
  }

  private async run(name: string): Promise<void> {
    const def = this.defs.get(name);
    if (!def) return;
    const { db, sql, token } = def;
    this.setState(name, { status: "loading" });
    const result = await runSqlQuery(db ?? "", sql);
    // Superseded by a newer (db, sql) while this was in flight → drop it.
    if (this.defs.get(name)?.token !== token) return;
    if (result.status === "ok") {
      const rows = result.rows ?? [];
      this.setState(name, {
        status: "ok",
        columns: result.columns ?? [],
        row: rows.length ? rows[0] : null,
      });
    } else if (result.status === "denied") {
      this.setState(name, { status: "denied" });
    } else if (result.status === "empty") {
      // No db or blank SQL — treat as an empty (column-less) ok so chips show
      // their null fallback rather than an error.
      this.setState(name, { status: "ok", columns: [], row: null });
    } else {
      this.setState(name, { status: "error", error: result.error ?? "Query failed" });
    }
  }

  private setState(name: string, state: SourceState): void {
    this.states.set(name, state);
    const set = this.subs.get(name);
    if (set) for (const cb of set) cb(state);
  }
}

/** Resolve a single column from a source's `ok` state. Returns the raw cell, or
 *  `undefined` when the column isn't present (caller renders an error chip). */
export function cellFor(
  state: Extract<SourceState, { status: "ok" }>,
  column: string,
): CellValue | undefined {
  const idx = state.columns.indexOf(column);
  if (idx < 0) return undefined;
  return state.row ? state.row[idx] : null;
}
