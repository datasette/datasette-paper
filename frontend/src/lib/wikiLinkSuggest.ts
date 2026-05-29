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
