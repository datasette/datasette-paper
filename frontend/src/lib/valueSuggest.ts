/**
 * `${{`-triggered inline-value autocomplete — state + decorations + popup.
 *
 * Clones `tagSuggest.ts` (PluginKey + `state.apply` + a `.pm-value-typing`
 * decoration + a `Plugin.view` popup), with two differences:
 *
 *  1. Trigger is `${{` (the leading `$` keeps it disjoint from `placeholder`'s
 *     bare `{{key}}`), and it can appear anywhere — no word-boundary needed.
 *  2. Vocabulary is LOCAL and TWO-STAGE: stage A lists the doc's `source` node
 *     names; once the query contains a `.`, stage B lists that source's columns
 *     (from the SourceStore probe). Picking a source in stage A *advances* the
 *     text to `${{name.` (keeping the popup open); picking a column commits a
 *     `value` node.
 */
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { schema } from "./schema";
import type { Node as PMNode } from "prosemirror-model";
import type { SourceStore } from "./sourceStore";

export interface ValueState {
  active: boolean;
  query: string; // text after `${{`, e.g. "rev" or "revenue.tot"
  from: number; // doc pos of the `$`
  index: number; // highlighted result index
  results: string[]; // stage A: source names · stage B: column names
  dismissedFrom?: number;
}

type ValueMeta =
  | { type: "setResults"; results: string[] }
  | { type: "move"; d: 1 | -1 }
  | { type: "cancel" }
  | { type: "commit" };

const INACTIVE: ValueState = { active: false, query: "", from: -1, index: 0, results: [] };

export const valueKey = new PluginKey<ValueState>("valueSuggest");

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function clampIndex(index: number, len: number): number {
  return clamp(index, 0, Math.max(0, len - 1));
}

/** `${{` followed by a run of word chars / dots, anchored to the cursor. */
const TRIGGER = /\$\{\{([\w.]*)$/;

/** All `source` node names present in the doc (for stage-A suggestions). */
export function sourceNamesIn(doc: PMNode): string[] {
  const names: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "source" && node.attrs.name) {
      const n = String(node.attrs.name);
      if (!names.includes(n)) names.push(n);
      return false;
    }
    return true;
  });
  return names;
}

function recompute(_tr: Transaction, prev: ValueState, newState: EditorState): ValueState {
  const sel = newState.selection;
  if (!(sel instanceof TextSelection) || !sel.empty || !sel.$cursor) {
    return { ...INACTIVE, dismissedFrom: prev.dismissedFrom };
  }
  const $cursor = sel.$cursor;
  const textBefore = $cursor.parent.textBetween(0, $cursor.parentOffset, undefined, "￼");
  const m = TRIGGER.exec(textBefore);
  if (!m) return INACTIVE;
  const from = sel.from - m[0].length; // m[0] = "${{" + query
  if (prev.dismissedFrom !== undefined && prev.dismissedFrom === from) {
    return { ...INACTIVE, dismissedFrom: prev.dismissedFrom };
  }
  const query = m[1];
  const same = prev.active && prev.from === from && prev.query === query;
  return {
    active: true,
    query,
    from,
    index: same ? prev.index : 0,
    results: same ? prev.results : [],
  };
}

// @feat value: ${{-triggered two-stage source/column autocomplete
export const valueSuggestPlugin = new Plugin<ValueState>({
  key: valueKey,
  state: {
    init() {
      return { ...INACTIVE };
    },
    apply(tr, prev, _oldState, newState) {
      const meta = tr.getMeta(valueKey) as ValueMeta | undefined;
      if (meta) {
        switch (meta.type) {
          case "setResults":
            return { ...prev, results: meta.results, index: clampIndex(prev.index, meta.results.length) };
          case "move":
            return { ...prev, index: clamp(prev.index + meta.d, 0, Math.max(0, prev.results.length - 1)) };
          case "cancel":
            return { ...INACTIVE, dismissedFrom: prev.from };
          case "commit":
            return { ...INACTIVE };
        }
      }
      return recompute(tr, prev, newState);
    },
  },
  props: {
    decorations(state) {
      const vs = valueKey.getState(state);
      if (!vs || !vs.active) return DecorationSet.empty;
      return DecorationSet.create(state.doc, [
        Decoration.inline(vs.from, state.selection.from, { class: "pm-value-typing" }),
      ]);
    },
  },
});

type Command = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;

export function moveValueSelection(d: 1 | -1): Command {
  return (state, dispatch) => {
    const vs = valueKey.getState(state);
    if (!vs || !vs.active) return false;
    if (dispatch) dispatch(state.tr.setMeta(valueKey, { type: "move", d }));
    return true;
  };
}

export function setValueResults(view: EditorView, results: string[]): void {
  view.dispatch(view.state.tr.setMeta(valueKey, { type: "setResults", results }));
}

export function cancelValueSuggest(): Command {
  return (state, dispatch) => {
    const vs = valueKey.getState(state);
    if (!vs || !vs.active) return false;
    if (dispatch) dispatch(state.tr.setMeta(valueKey, { type: "cancel" }));
    return true;
  };
}

/** Insert a `value` node spanning [from, to). */
function commitValue(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  from: number,
  to: number,
  source: string,
  column: string,
): void {
  const node = schema.nodes.value.create({ source, column, format: null });
  dispatch(state.tr.replaceWith(from, to, node).setMeta(valueKey, { type: "commit" }));
}

/** Advance the `${{src` text to `${{src.` so the popup moves to column stage. */
function advanceToColumn(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  from: number,
  to: number,
  source: string,
): void {
  dispatch(state.tr.insertText(`\${{${source}.`, from, to));
}

/** Enter handler: stage A advances to the column stage; stage B commits. */
export function commitValueSelection(): Command {
  return (state, dispatch) => {
    const vs = valueKey.getState(state);
    if (!vs || !vs.active) return false;
    const to = state.selection.from;
    const dot = vs.query.indexOf(".");
    if (dot < 0) {
      // Stage A — pick a source (highlighted, else the typed text).
      const source = vs.results[vs.index] ?? vs.query;
      if (!source) return false;
      if (dispatch) advanceToColumn(state, dispatch, vs.from, to, source);
      return true;
    }
    // Stage B — pick a column and commit.
    const source = vs.query.slice(0, dot);
    const typed = vs.query.slice(dot + 1);
    const column = vs.results[vs.index] ?? typed;
    if (!source || !column) return false;
    if (dispatch) commitValue(state, dispatch, vs.from, to, source, column);
    return true;
  };
}

export function valueKeymap(): Record<string, Command> {
  return {
    ArrowDown: moveValueSelection(1),
    ArrowUp: moveValueSelection(-1),
    Enter: commitValueSelection(),
    Escape: cancelValueSuggest(),
  };
}

const MAX_SUGGESTIONS = 12;

/**
 * Floating suggestion list for the `${{` autocomplete. Stage A reads source
 * names from the doc; stage B reads the chosen source's columns from the
 * SourceStore probe (subscribing so late-arriving columns refresh the list).
 */
class ValuePopupView {
  private host: HTMLElement | null;
  private root: HTMLDivElement | null;
  private lastQuery: string | null = null;
  private columnUnsub: (() => void) | null = null;
  private subscribedSource: string | null = null;

  constructor(
    private view: EditorView,
    private store: SourceStore,
  ) {
    const host = view.dom.parentElement;
    this.host = host ?? null;
    this.root = null;
    if (host) {
      this.root = document.createElement("div");
      this.root.className = "pm-value-popup";
      this.root.style.display = "none";
      host.appendChild(this.root);
      this.update(view);
    }
  }

  update(view: EditorView): void {
    this.view = view;
    const root = this.root;
    const host = this.host;
    if (!root || !host) return;
    const vs = valueKey.getState(view.state);
    if (!vs || !vs.active) {
      root.style.display = "none";
      this.lastQuery = null;
      this.clearColumnSub();
      return;
    }
    this.position(view, vs.from);
    root.style.display = "block";
    if (vs.query !== this.lastQuery) {
      this.lastQuery = vs.query;
      this.recomputeResults(vs.query);
    }
    this.renderResults(vs);
  }

  private position(view: EditorView, from: number): void {
    const root = this.root;
    const host = this.host;
    if (!root || !host) return;
    let coords: { left: number; bottom: number };
    try {
      coords = view.coordsAtPos(from);
    } catch {
      return; // jsdom — skip positioning
    }
    const hostRect = host.getBoundingClientRect();
    const top = coords.bottom - hostRect.top + 2;
    let left = coords.left - hostRect.left;
    const maxLeft = Math.max(0, host.clientWidth - root.offsetWidth);
    left = clamp(left, 0, maxLeft);
    root.style.top = `${top}px`;
    root.style.left = `${left}px`;
  }

  private recomputeResults(query: string): void {
    const dot = query.indexOf(".");
    if (dot < 0) {
      this.clearColumnSub();
      const q = query.toLowerCase();
      const names = sourceNamesIn(this.view.state.doc)
        .filter((n) => q === "" || n.toLowerCase().includes(q))
        .slice(0, MAX_SUGGESTIONS);
      setValueResults(this.view, names);
      return;
    }
    // Stage B — columns of the chosen source.
    const source = query.slice(0, dot);
    const colQ = query.slice(dot + 1).toLowerCase();
    this.ensureColumnSub(source);
    const state = this.store.getState(source);
    const cols = state.status === "ok" ? state.columns : [];
    const matches = cols
      .filter((c) => colQ === "" || c.toLowerCase().includes(colQ))
      .slice(0, MAX_SUGGESTIONS);
    setValueResults(this.view, matches);
  }

  // Re-filter when the store resolves columns for the active source.
  private ensureColumnSub(source: string): void {
    if (this.subscribedSource === source) return;
    this.clearColumnSub();
    this.subscribedSource = source;
    this.columnUnsub = this.store.subscribe(source, () => {
      const vs = valueKey.getState(this.view.state);
      if (vs && vs.active) {
        this.lastQuery = null; // force a recompute on next update
        this.update(this.view);
      }
    });
  }

  private clearColumnSub(): void {
    this.columnUnsub?.();
    this.columnUnsub = null;
    this.subscribedSource = null;
  }

  private renderResults(vs: ValueState): void {
    const root = this.root;
    if (!root) return;
    root.textContent = "";
    const dot = vs.query.indexOf(".");
    const stageColumn = dot >= 0;

    if (vs.results.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pm-value-empty";
      empty.textContent = stageColumn
        ? "No matching columns"
        : sourceNamesIn(this.view.state.doc).length
          ? "No matching sources"
          : "No sources yet — add one in the Sources panel";
      root.appendChild(empty);
      return;
    }

    vs.results.forEach((result, i) => {
      const item = document.createElement("div");
      item.className = "pm-value-item";
      if (i === vs.index) item.classList.add("pm-value-item--active");
      item.appendChild(document.createTextNode(stageColumn ? result : `\${{${result}}}`));
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.pick(result);
      });
      root.appendChild(item);
    });
  }

  private pick(result: string): void {
    const view = this.view;
    const vs = valueKey.getState(view.state);
    if (!vs || !vs.active) return;
    const to = view.state.selection.from;
    const dot = vs.query.indexOf(".");
    if (dot < 0) {
      advanceToColumn(view.state, view.dispatch, vs.from, to, result);
    } else {
      const source = vs.query.slice(0, dot);
      commitValue(view.state, view.dispatch, vs.from, to, source, result);
    }
    view.focus();
  }

  destroy(): void {
    this.clearColumnSub();
    this.root?.remove();
    this.root = null;
  }
}

export function valueSuggestPopupPlugin(store: SourceStore): Plugin {
  return new Plugin({
    view(view) {
      return new ValuePopupView(view, store);
    },
  });
}
