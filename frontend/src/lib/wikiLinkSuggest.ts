/**
 * `[[`-triggered wiki-link autocomplete — state + decorations only.
 *
 * This module owns the plugin state machine that detects a `[[query`
 * typed before the cursor, tracks the highlighted result index, and
 * paints a `.pm-wikilink-typing` inline decoration over the in-progress
 * `[[query` span. It deliberately ships NO popup DOM and NO fetch — a
 * later commit adds a `Plugin.view` popup + keymap that consume the
 * command helpers and `setWikiResults` exported here.
 *
 * Style mirrors `foldHeadings.ts`: one PluginKey, a `state.apply` that
 * handles `setMeta` first then recomputes from doc+selection, and a
 * `decorations` prop rebuilt fresh from the current plugin state.
 *
 * The state machine keys off the textblock text before the cursor; a
 * `cancel` remembers the dismissed `[[` start (`dismissedFrom`) so the
 * popup doesn't immediately re-open over the same span the user just
 * escaped out of. Committing replaces the `[[query` range with an
 * id-only `paper_link` atom (label-less; the NodeView resolves it).
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

export interface WikiResult {
  id: number;
  name: string;
  state: string;
  kind: string;
}

export interface WikiState {
  active: boolean;
  query: string; // text after `[[`
  from: number; // doc pos of the first `[` of the `[[`
  index: number; // highlighted result index
  results: WikiResult[];
  // Internal: the `from` of a span the user just cancelled out of, so the
  // SAME `[[query` span doesn't immediately re-open. Not part of the public
  // contract — cleared whenever a fresh, different `[[` starts.
  dismissedFrom?: number;
}

type WikiMeta =
  | { type: "setResults"; results: WikiResult[] }
  | { type: "move"; d: 1 | -1 }
  | { type: "cancel" }
  | { type: "commit" };

const INACTIVE: WikiState = {
  active: false,
  query: "",
  from: -1,
  index: 0,
  results: [],
};

export const wikiLinkKey = new PluginKey<WikiState>("wikiLinkSuggest");

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function clampIndex(index: number, len: number): number {
  return clamp(index, 0, Math.max(0, len - 1));
}

// The trigger: `[[` followed by any run of chars that are not brackets or a
// newline, anchored to the end of the text-before-cursor.
const TRIGGER = /\[\[([^[\]\n]*)$/;

/** Recompute state from the current doc + selection (no meta involved). */
function recompute(
  tr: Transaction,
  prev: WikiState,
  newState: EditorState,
): WikiState {
  const sel = newState.selection;
  // Only an empty (collapsed) text selection should drive the popup.
  if (!(sel instanceof TextSelection) || !sel.empty || !sel.$cursor) {
    return { ...INACTIVE, dismissedFrom: prev.dismissedFrom };
  }
  const $cursor = sel.$cursor;
  const textBefore = $cursor.parent.textBetween(
    0,
    $cursor.parentOffset,
    undefined,
    "￼",
  );
  const m = TRIGGER.exec(textBefore);
  if (!m) {
    // No trigger before the cursor — fully reset, including dismissedFrom.
    return INACTIVE;
  }
  const c = sel.from;
  const from = c - m[0].length; // doc pos of the first `[`.
  // If the user cancelled this exact span, keep it dismissed until they
  // either move away (no match) or start a new `[[` somewhere else.
  if (prev.dismissedFrom !== undefined && prev.dismissedFrom === from) {
    return { ...INACTIVE, dismissedFrom: prev.dismissedFrom };
  }
  const query = m[1];
  const sameQuery = prev.active && prev.from === from && prev.query === query;
  return {
    active: true,
    query,
    from,
    index: sameQuery ? prev.index : 0,
    results: sameQuery ? prev.results : [],
  };
}

export const wikiLinkSuggestPlugin = new Plugin<WikiState>({
  key: wikiLinkKey,
  state: {
    init() {
      return { ...INACTIVE };
    },
    apply(tr, prev, _oldState, newState) {
      const meta = tr.getMeta(wikiLinkKey) as WikiMeta | undefined;
      if (meta) {
        switch (meta.type) {
          case "setResults":
            return {
              ...prev,
              results: meta.results,
              index: clampIndex(prev.index, meta.results.length),
            };
          case "move":
            return {
              ...prev,
              index: clamp(
                prev.index + meta.d,
                0,
                Math.max(0, prev.results.length - 1),
              ),
            };
          case "cancel":
            // Remember the span we dismissed so it doesn't immediately
            // re-open while the same `[[query` still sits before the cursor.
            return { ...INACTIVE, dismissedFrom: prev.from };
          case "commit":
            // The doc replacement rides in the same tr (see
            // commitWikiSelection); just go inactive.
            return { ...INACTIVE };
        }
      }
      return recompute(tr, prev, newState);
    },
  },
  props: {
    decorations(state) {
      const ws = wikiLinkKey.getState(state);
      if (!ws || !ws.active) return DecorationSet.empty;
      const cursorTo = state.selection.from;
      return DecorationSet.create(state.doc, [
        Decoration.inline(ws.from, cursorTo, { class: "pm-wikilink-typing" }),
      ]);
    },
  },
});

type Command = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
) => boolean;

/** Move the highlighted result by `d`; falls through when inactive. */
export function moveWikiSelection(d: 1 | -1): Command {
  return (state, dispatch) => {
    const ws = wikiLinkKey.getState(state);
    if (!ws || !ws.active) return false;
    if (dispatch) {
      dispatch(state.tr.setMeta(wikiLinkKey, { type: "move", d }));
    }
    return true;
  };
}

/** Push fetched results into the plugin state (popup will call this). */
export function setWikiResults(view: EditorView, results: WikiResult[]): void {
  view.dispatch(
    view.state.tr.setMeta(wikiLinkKey, { type: "setResults", results }),
  );
}

/** Dismiss the popup; falls through when inactive. */
export function cancelWikiSuggest(): Command {
  return (state, dispatch) => {
    const ws = wikiLinkKey.getState(state);
    if (!ws || !ws.active) return false;
    if (dispatch) {
      dispatch(state.tr.setMeta(wikiLinkKey, { type: "cancel" }));
    }
    return true;
  };
}

/** Replace the `[[query` span with the highlighted result's paper_link. */
export function commitWikiSelection(): Command {
  return (state, dispatch) => {
    const ws = wikiLinkKey.getState(state);
    if (!ws || !ws.active || ws.results.length === 0) return false;
    const result = ws.results[ws.index];
    if (!result) return false;
    if (dispatch) {
      const to = state.selection.from;
      const node = schema.nodes.paper_link.create({ docId: result.id });
      dispatch(
        state.tr
          .replaceWith(ws.from, to, node)
          .setMeta(wikiLinkKey, { type: "commit" }),
      );
    }
    return true;
  };
}

/**
 * Keymap consumed while the `[[` popup is open. Each command returns
 * false when the popup is inactive, so normal editing keystrokes fall
 * through to the rest of the keymap chain. This MUST be registered
 * before `baseKeymap` so Enter/Arrow/Escape are intercepted while the
 * popup is up.
 */
export function wikiLinkKeymap(): Record<string, Command> {
  return {
    ArrowDown: moveWikiSelection(1),
    ArrowUp: moveWikiSelection(-1),
    Enter: commitWikiSelection(),
    Escape: cancelWikiSuggest(),
  };
}

const LINK_SEARCH_PATH = "/-/paper/api/link-search";
const FETCH_DEBOUNCE_MS = 150;

interface LinkSearchResponse {
  results: WikiResult[];
}

/**
 * Floating result list for the `[[` autocomplete. Mirrors the
 * `Plugin.view` structure of `linkTooltip.ts`: appends a div to the
 * `.editor-host` (the `view.dom.parentElement`, which is
 * `position: relative`), positions it via `view.coordsAtPos`, and
 * tears everything (timer, listeners, DOM) down in `destroy()`.
 *
 * The list is rendered purely from plugin state (`ws.results` /
 * `ws.index`) so the highlight stays in lock-step with the keymap's
 * move/commit commands. The fetch is debounced and guarded by a
 * monotonic request seq: a response is dropped if it isn't the latest
 * request, if the popup went inactive, or if the query moved on.
 */
class WikiLinkPopupView {
  private host: HTMLElement | null;
  private root: HTMLDivElement | null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFetchedQuery: string | null = null;
  private requestSeq = 0;

  constructor(private view: EditorView) {
    const host = view.dom.parentElement;
    if (!host) {
      // Detached EditorView — nothing to anchor to. destroy() is a no-op.
      this.host = null;
      this.root = null;
      return;
    }
    this.host = host;
    this.root = document.createElement("div");
    this.root.className = "pm-wikilink-popup";
    this.root.style.display = "none";
    host.appendChild(this.root);
    this.update(view);
  }

  update(view: EditorView): void {
    this.view = view;
    const root = this.root;
    const host = this.host;
    if (!root || !host) return;

    const ws = wikiLinkKey.getState(view.state);
    if (!ws || !ws.active) {
      root.style.display = "none";
      this.cancelDebounce();
      this.lastFetchedQuery = null;
      return;
    }

    this.position(view, ws.from);
    root.style.display = "block";

    // Kick off a (debounced) fetch when the query changed since the last
    // one we issued. Index-only changes (move) keep lastFetchedQuery, so
    // they don't refetch — they just re-render the highlight below.
    if (ws.query !== this.lastFetchedQuery) {
      this.scheduleFetch(ws.query);
    }

    this.renderResults(ws);
  }

  private position(view: EditorView, from: number): void {
    const root = this.root;
    const host = this.host;
    if (!root || !host) return;
    let coords: { left: number; bottom: number };
    try {
      coords = view.coordsAtPos(from);
    } catch {
      // coordsAtPos relies on getClientRects, which jsdom doesn't
      // implement — skip positioning under test. Visibility/state still
      // behave correctly.
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const top = coords.bottom - hostRect.top + 2;
    let left = coords.left - hostRect.left;
    const maxLeft = Math.max(0, host.clientWidth - root.offsetWidth);
    if (left > maxLeft) left = maxLeft;
    if (left < 0) left = 0;
    root.style.top = `${top}px`;
    root.style.left = `${left}px`;
  }

  private scheduleFetch(query: string): void {
    this.cancelDebounce();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runFetch(query);
    }, FETCH_DEBOUNCE_MS);
  }

  private async runFetch(query: string): Promise<void> {
    const seq = ++this.requestSeq;
    this.lastFetchedQuery = query;
    const url = `${LINK_SEARCH_PATH}?q=${encodeURIComponent(query)}&limit=20`;
    let results: WikiResult[] = [];
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const json = (await resp.json()) as LinkSearchResponse;
      results = json.results ?? [];
    } catch {
      // Network/parse error — leave the (possibly empty) list alone.
      return;
    }
    // Staleness guards: a newer request superseded us, the popup closed,
    // or the user typed past the query this response was for.
    if (seq !== this.requestSeq) return;
    const ws = wikiLinkKey.getState(this.view.state);
    if (!ws || !ws.active || ws.query !== query) return;
    setWikiResults(this.view, results);
  }

  private renderResults(ws: WikiState): void {
    const root = this.root;
    if (!root) return;
    root.textContent = "";
    if (ws.results.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pm-wikilink-empty";
      empty.textContent = "No matches";
      root.appendChild(empty);
      return;
    }
    ws.results.forEach((result, i) => {
      const item = document.createElement("div");
      item.className = "pm-wikilink-item";
      if (i === ws.index) item.classList.add("pm-wikilink-item--active");
      item.textContent = result.name;
      item.addEventListener("mousedown", (e) => {
        // Keep editor focus so the commit transaction applies cleanly.
        e.preventDefault();
        this.commitResult(result);
      });
      root.appendChild(item);
    });
  }

  private commitResult(result: WikiResult): void {
    const view = this.view;
    const ws = wikiLinkKey.getState(view.state);
    if (!ws || !ws.active) return;
    const node = schema.nodes.paper_link.create({ docId: result.id });
    view.dispatch(
      view.state.tr
        .replaceWith(ws.from, view.state.selection.from, node)
        .setMeta(wikiLinkKey, { type: "commit" }),
    );
    view.focus();
  }

  private cancelDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  destroy(): void {
    this.cancelDebounce();
    // Bump the seq so any in-flight fetch resolves into a no-op.
    this.requestSeq++;
    this.root?.remove();
    this.root = null;
  }
}

/** The `Plugin.view` popup that renders the `[[` autocomplete list. */
export function wikiLinkSuggestPopupPlugin(): Plugin {
  return new Plugin({
    view(view) {
      return new WikiLinkPopupView(view);
    },
  });
}
