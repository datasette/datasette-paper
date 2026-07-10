/**
 * Tests for the CM-on-focus hybrid inside the two SQL NodeViews (T06):
 *
 *  - the module-level result LRU (hit / miss / eviction / bypass) that spares a
 *    static↔CM rebuild a refetch;
 *  - codeFocusPlugin's per-type activation guards (a hidden `sql_block` is never
 *    a candidate; a collapsed `source` is a candidate that the NodeView
 *    declines);
 *  - the sql_block mode flip (focus → CM → back) not refetching, and Mod-Enter
 *    running the query; the CM-synced edit lighting the Run staleness cue.
 *
 * The real `@codemirror/*` packages run under jsdom (reached via the resolved
 * `core`, so the eslint chokepoint stays honest, as in codeBlockCm.test.ts).
 *
 * @feat sql-block: proves the (db, sql) result LRU, the hidden guard, the
 * static↔CM flip without a refetch, Mod-Enter=run, and the staleness cue
 * @feat source: proves a collapsed pill declines the CM mount while the plugin
 * still marks it a candidate, and expanding then focusing mounts CM
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import {
  SqlBlockView,
  cachedSqlResult,
  cacheSqlResult,
  clearSqlResultCache,
  SQL_RESULT_CACHE_CAP,
} from "../sqlBlockView";
import { SourceBlockView } from "../sourceBlockView";
import { SourceStore } from "../sourceStore";
import { codeFocusPlugin, codeFocusKey } from "../codeFocusPlugin";
import { codeHighlightPlugin } from "../codeHighlight";
import { loadCmCore } from "../cmCore";
import type { SqlResult } from "../sqlQuery";

// ── The (db, sql) result LRU (pure) ─────────────────────────────────────────

describe("SQL result cache (LRU)", () => {
  beforeEach(() => clearSqlResultCache());

  const ok = (n: number): SqlResult => ({ status: "ok", columns: ["n"], rows: [[n]] });

  it("misses an unseen (db, sql) and hits after a set", () => {
    expect(cachedSqlResult("data", "select 1")).toBeUndefined();
    cacheSqlResult("data", "select 1", ok(1));
    expect(cachedSqlResult("data", "select 1")).toEqual(ok(1));
  });

  it("keys on both db and sql (a different db or sql misses)", () => {
    cacheSqlResult("data", "select 1", ok(1));
    expect(cachedSqlResult("other", "select 1")).toBeUndefined();
    expect(cachedSqlResult("data", "select 2")).toBeUndefined();
  });

  it("evicts the oldest entry past the cap", () => {
    for (let i = 0; i < SQL_RESULT_CACHE_CAP; i++) cacheSqlResult("data", `q${i}`, ok(i));
    // Cache is full; the oldest is q0.
    cacheSqlResult("data", "overflow", ok(-1));
    expect(cachedSqlResult("data", "q0")).toBeUndefined();
    expect(cachedSqlResult("data", "q1")).toEqual(ok(1));
    expect(cachedSqlResult("data", "overflow")).toEqual(ok(-1));
  });

  it("a hit re-touches an entry so it isn't the next evicted (LRU order)", () => {
    for (let i = 0; i < SQL_RESULT_CACHE_CAP; i++) cacheSqlResult("data", `q${i}`, ok(i));
    // Touch q0 → it becomes most-recent, so q1 is now the oldest.
    expect(cachedSqlResult("data", "q0")).toEqual(ok(0));
    cacheSqlResult("data", "overflow", ok(-1));
    expect(cachedSqlResult("data", "q0")).toEqual(ok(0)); // survived
    expect(cachedSqlResult("data", "q1")).toBeUndefined(); // evicted instead
  });
});

// ── Mounted PM harness ──────────────────────────────────────────────────────

const mounted: EditorView[] = [];
let queryFetches = 0;

/** Stub fetch: `/.json` → a one-db list; `/{db}/-/query.json` → the result,
 * counting query round-trips so a cache hit can be asserted as "no refetch". */
function stubFetch(result: {
  columns?: string[];
  rows?: unknown[][];
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/.json")) {
        return { ok: true, status: 200, json: async () => ({ databases: [{ name: "data" }] }) };
      }
      queryFetches++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, columns: result.columns ?? [], rows: result.rows ?? [] }),
      };
    }),
  );
}

function sqlDoc(sql: string, attrs: { hidden?: boolean } = {}): PMNode {
  return schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("intro")]),
    schema.node(
      "sql_block",
      { db: "data", hidden: attrs.hidden ?? false },
      sql ? [schema.text(sql)] : [],
    ),
  ]);
}

function sourceDoc(sql: string): PMNode {
  return schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("intro")]),
    schema.node("source", { name: "revenue", db: "data" }, sql ? [schema.text(sql)] : []),
  ]);
}

function blockPos(view: EditorView, type: string): number {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === type) found = pos;
    return true;
  });
  return found;
}

function mount(doc: PMNode, type: string): EditorView {
  const store = new SourceStore();
  store.sync(doc);
  const state = EditorState.create({
    doc,
    plugins: [history(), codeFocusPlugin(), codeHighlightPlugin(), keymap(baseKeymap)],
  });
  const place = document.createElement("div");
  place.className = "editor-host";
  document.body.appendChild(place);
  const view = new EditorView(place, {
    state,
    nodeViews: {
      sql_block: (node, v, getPos) =>
        new SqlBlockView(node, v, getPos as () => number | undefined),
      source: (node, v, getPos) =>
        new SourceBlockView(node, v, getPos as () => number | undefined, store),
    },
  });
  void type;
  mounted.push(view);
  return view;
}

function selectInBlock(view: EditorView, type: string, offset: number): void {
  const start = blockPos(view, type) + 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + offset)));
}

function selectInParagraph(view: EditorView): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
}

async function waitForCm(view: EditorView): Promise<HTMLElement> {
  return (await vi.waitFor(() => {
    const el = view.dom.querySelector(".cm-editor");
    if (!el) throw new Error("no .cm-editor yet");
    return el;
  })) as HTMLElement;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  clearSqlResultCache();
  queryFetches = 0;
});

afterEach(() => {
  for (const v of mounted.splice(0)) v.destroy();
  document.querySelectorAll(".editor-host").forEach((n) => n.remove());
  vi.unstubAllGlobals();
});

describe("sql_block CM mode flip", () => {
  it("mounts CM on focus and returns to a static <pre> when the selection leaves", async () => {
    stubFetch({ columns: ["n"], rows: [[1]] });
    const view = mount(sqlDoc("select 1"), "sql_block");
    await vi.waitFor(() => {
      if (!view.dom.querySelector("table")) throw new Error("no results yet");
    });
    expect(view.dom.querySelector(".cm-editor")).toBeNull();
    selectInBlock(view, "sql_block", 3);
    await waitForCm(view);
    selectInParagraph(view);
    await vi.waitFor(() => {
      if (view.dom.querySelector(".cm-editor")) throw new Error("still mounted");
      if (!view.dom.querySelector(".pm-sql-block-code")) throw new Error("no static pre");
    });
  });

  it("does not refetch the query across the static↔CM rebuild (cache hit)", async () => {
    stubFetch({ columns: ["n"], rows: [[1]] });
    const view = mount(sqlDoc("select 1"), "sql_block");
    await vi.waitFor(() => {
      if (!view.dom.querySelector("table")) throw new Error("no results yet");
    });
    expect(queryFetches).toBe(1); // the auto-run
    selectInBlock(view, "sql_block", 3);
    await waitForCm(view);
    await settle();
    // The CM rebuild reconstructed the NodeView (auto-runs again) but the
    // (db, sql) cache served it — no second round-trip; results survive.
    expect(queryFetches).toBe(1);
    expect(view.dom.querySelector("table")).not.toBeNull();
  });

  it("disables spellcheck/autocorrect/autocapitalize on the mounted CM surface", async () => {
    stubFetch({ columns: ["n"], rows: [[1]] });
    const view = mount(sqlDoc("select 1"), "sql_block");
    await vi.waitFor(() => {
      if (!view.dom.querySelector("table")) throw new Error("no results yet");
    });
    selectInBlock(view, "sql_block", 3);
    const cmEl = await waitForCm(view);
    const core = await loadCmCore();
    const cm = core.EditorView.findFromDOM(cmEl)!;
    expect(cm.contentDOM.getAttribute("spellcheck")).toBe("false");
    expect(cm.contentDOM.getAttribute("autocorrect")).toBe("off");
    expect(cm.contentDOM.getAttribute("autocapitalize")).toBe("off");
  });

  it("Mod-Enter in the CM keymap runs the query, bypassing the cache", async () => {
    stubFetch({ columns: ["n"], rows: [[1]] });
    const view = mount(sqlDoc("select 1"), "sql_block");
    await vi.waitFor(() => {
      if (!view.dom.querySelector("table")) throw new Error("no results yet");
    });
    selectInBlock(view, "sql_block", 3);
    const cmEl = await waitForCm(view);
    const core = await loadCmCore();
    const cm = core.EditorView.findFromDOM(cmEl)!;
    expect(queryFetches).toBe(1);
    const mac = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
    cm.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        ctrlKey: !mac,
        metaKey: mac,
        bubbles: true,
        cancelable: true,
      }),
    );
    // Force refresh → a fresh round-trip despite the cache.
    await vi.waitFor(() => {
      if (queryFetches !== 2) throw new Error("Mod-Enter did not refetch");
    });
  });

  it("lights the Run staleness cue on a synced text edit", async () => {
    stubFetch({ columns: ["n"], rows: [[1]] });
    const view = mount(sqlDoc("select 1"), "sql_block");
    await vi.waitFor(() => {
      if (!view.dom.querySelector("table")) throw new Error("no results yet");
    });
    const run = () => view.dom.querySelector(".pm-sql-block-run")!;
    expect(run().classList.contains("pm-sql-block-run--stale")).toBe(false);
    // A synced text change (what a CM edit forwards) reaches the NodeView's
    // update() and marks the results stale.
    const start = blockPos(view, "sql_block") + 1;
    view.dispatch(view.state.tr.insertText("0", start + 8));
    expect(run().classList.contains("pm-sql-block-run--stale")).toBe(true);
  });
});

describe("codeFocusPlugin per-type guards", () => {
  it("never marks a hidden sql_block a candidate (no CM)", async () => {
    stubFetch({ columns: ["n"], rows: [[1]] });
    const view = mount(sqlDoc("select 1", { hidden: true }), "sql_block");
    await settle();
    selectInBlock(view, "sql_block", 3);
    await loadCmCore();
    await settle();
    expect(codeFocusKey.getState(view.state)?.active ?? null).toBeNull();
    expect(view.dom.querySelector(".cm-editor")).toBeNull();
  });

  it("marks a collapsed source a candidate, but the NodeView declines the mount", async () => {
    stubFetch({ columns: ["n"], rows: [[]] });
    const view = mount(sourceDoc("select 1"), "source");
    await settle();
    selectInBlock(view, "source", 3);
    // The plugin activates (it can't see the pill's collapsed state)…
    await vi.waitFor(() => {
      const active = codeFocusKey.getState(view.state)?.active ?? null;
      if (active !== blockPos(view, "source")) throw new Error("not active yet");
    });
    await settle();
    // …but the collapsed NodeView stays static.
    expect(view.dom.querySelector(".cm-editor")).toBeNull();
    expect(view.dom.querySelector(".pm-source-card-code")).not.toBeNull();
  });

  it("mounts CM once the source is expanded and focused", async () => {
    stubFetch({ columns: ["n"], rows: [[]] });
    const view = mount(sourceDoc("select 1"), "source");
    await settle();
    // Expand via the Show-SQL toggle, then click into the SQL.
    view.dom.querySelector<HTMLButtonElement>(".pm-source-card-toggle")!.click();
    selectInParagraph(view);
    selectInBlock(view, "source", 3);
    await waitForCm(view);
  });
});
