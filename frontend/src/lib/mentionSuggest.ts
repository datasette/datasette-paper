/**
 * `@`-triggered mention autocomplete — state + decorations + popup.
 *
 * This module owns the plugin state machine that detects an `@query` typed
 * before the cursor (at a word boundary), tracks the highlighted result
 * index, and paints a `.pm-mention-typing` inline decoration over the
 * in-progress `@query` span. A `Plugin.view` popup (doc-scoped) runs the
 * debounced `mention-search` fetch and renders the floating result list.
 *
 * Style mirrors `wikiLinkSuggest.ts`: one PluginKey, a `state.apply` that
 * handles `setMeta` first then recomputes from doc+selection, and a
 * `decorations` prop rebuilt fresh from the current plugin state.
 *
 * Unlike `[[`, `@` appears inside emails, so the trigger requires
 * start-of-textblock or a whitespace char before the `@`. A `cancel`
 * remembers the dismissed `@` start (`dismissedFrom`) so the popup doesn't
 * immediately re-open over the same span the user just escaped out of.
 * Committing replaces the `@query` range with an id-only `mention` atom
 * (the NodeView resolves the live display name).
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

export interface MentionResult {
  id: string; // STRING actor id (the `[[` WikiResult.id was a number)
  name: string;
  avatarUrl?: string | null;
}

export interface MentionState {
  active: boolean;
  query: string; // text after `@`
  from: number; // doc pos of the `@`
  index: number; // highlighted result index
  results: MentionResult[];
  openAudience: boolean;
  // Internal: the `from` of a span the user just cancelled out of, so the
  // SAME `@query` span doesn't immediately re-open. Not part of the public
  // contract — cleared whenever a fresh, different `@` starts.
  dismissedFrom?: number;
}

type MentionMeta =
  | { type: "setResults"; results: MentionResult[]; openAudience: boolean }
  | { type: "move"; d: 1 | -1 }
  | { type: "cancel" }
  | { type: "commit" };

const INACTIVE: MentionState = {
  active: false,
  query: "",
  from: -1,
  index: 0,
  results: [],
  openAudience: false,
};

export const mentionKey = new PluginKey<MentionState>("mentionSuggest");

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function clampIndex(index: number, len: number): number {
  return clamp(index, 0, Math.max(0, len - 1));
}

// The trigger: `@` at a word boundary (start of textblock or after a
// whitespace char), followed by a run with no whitespace or `@`, anchored to
// the end of the text-before-cursor. The leading `(?:^|\s)` may consume one
// whitespace char, so `from` is computed from the `@query` length, NOT
// `m[0].length` (see recompute).
const TRIGGER = /(?:^|\s)@([^@\s]*)$/;

/** Recompute state from the current doc + selection (no meta involved). */
function recompute(
  tr: Transaction,
  prev: MentionState,
  newState: EditorState,
): MentionState {
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
  // The match may start with a leading whitespace char the regex consumed;
  // anchor `from` at the `@` itself by measuring the `@query` length.
  const at = m[0].lastIndexOf("@"); // offset of `@` within the match
  const matchLen = m[0].length - at; // length of `@query`
  const from = c - matchLen; // doc pos of the `@`
  // If the user cancelled this exact span, keep it dismissed until they
  // either move away (no match) or start a new `@` somewhere else.
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
    openAudience: sameQuery ? prev.openAudience : false,
  };
}

export const mentionSuggestPlugin = new Plugin<MentionState>({
  key: mentionKey,
  state: {
    init() {
      return { ...INACTIVE };
    },
    apply(tr, prev, _oldState, newState) {
      const meta = tr.getMeta(mentionKey) as MentionMeta | undefined;
      if (meta) {
        switch (meta.type) {
          case "setResults":
            return {
              ...prev,
              results: meta.results,
              openAudience: meta.openAudience,
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
            // re-open while the same `@query` still sits before the cursor.
            return { ...INACTIVE, dismissedFrom: prev.from };
          case "commit":
            // The doc replacement rides in the same tr (see
            // commitMentionSelection); just go inactive.
            return { ...INACTIVE };
        }
      }
      return recompute(tr, prev, newState);
    },
  },
  props: {
    decorations(state) {
      const ms = mentionKey.getState(state);
      if (!ms || !ms.active) return DecorationSet.empty;
      const cursorTo = state.selection.from;
      return DecorationSet.create(state.doc, [
        Decoration.inline(ms.from, cursorTo, { class: "pm-mention-typing" }),
      ]);
    },
  },
});

type Command = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
) => boolean;

/** Move the highlighted result by `d`; falls through when inactive. */
export function moveMentionSelection(d: 1 | -1): Command {
  return (state, dispatch) => {
    const ms = mentionKey.getState(state);
    if (!ms || !ms.active) return false;
    if (dispatch) {
      dispatch(state.tr.setMeta(mentionKey, { type: "move", d }));
    }
    return true;
  };
}

/** Push fetched results into the plugin state (popup will call this). */
export function setMentionResults(
  view: EditorView,
  results: MentionResult[],
  openAudience: boolean,
): void {
  view.dispatch(
    view.state.tr.setMeta(mentionKey, {
      type: "setResults",
      results,
      openAudience,
    }),
  );
}

/** Dismiss the popup; falls through when inactive. */
export function cancelMentionSuggest(): Command {
  return (state, dispatch) => {
    const ms = mentionKey.getState(state);
    if (!ms || !ms.active) return false;
    if (dispatch) {
      dispatch(state.tr.setMeta(mentionKey, { type: "cancel" }));
    }
    return true;
  };
}

/** Replace the `@query` span with the highlighted result's mention node. */
export function commitMentionSelection(): Command {
  return (state, dispatch) => {
    const ms = mentionKey.getState(state);
    if (!ms || !ms.active || ms.results.length === 0) return false;
    const result = ms.results[ms.index];
    if (!result) return false;
    if (dispatch) {
      const to = state.selection.from;
      const node = schema.nodes.mention.create({ actorId: result.id });
      dispatch(
        state.tr
          .replaceWith(ms.from, to, node)
          .setMeta(mentionKey, { type: "commit" }),
      );
    }
    return true;
  };
}

/**
 * Keymap consumed while the `@` popup is open. Each command returns false
 * when the popup is inactive, so normal editing keystrokes fall through to
 * the rest of the keymap chain. This MUST be registered before `baseKeymap`
 * so Enter/Arrow/Escape are intercepted while the popup is up.
 */
export function mentionKeymap(): Record<string, Command> {
  return {
    ArrowDown: moveMentionSelection(1),
    ArrowUp: moveMentionSelection(-1),
    Enter: commitMentionSelection(),
    Escape: cancelMentionSuggest(),
  };
}

const FETCH_DEBOUNCE_MS = 150;

interface MentionSearchResponse {
  results: MentionResult[];
  open_audience: boolean;
}

/**
 * Floating result list for the `@` autocomplete. Mirrors the `Plugin.view`
 * structure of `wikiLinkSuggest.ts`'s popup: appends a div to the
 * `.editor-host` (the `view.dom.parentElement`, which is
 * `position: relative`), positions it via `view.coordsAtPos`, and tears
 * everything (timer, listeners, DOM) down in `destroy()`.
 *
 * The list is rendered purely from plugin state (`ms.results` / `ms.index`)
 * so the highlight stays in lock-step with the keymap's move/commit commands.
 * The fetch is doc-scoped (`/-/paper/api/docs/${docId}/mention-search`),
 * debounced, and guarded by a monotonic request seq: a response is dropped if
 * it isn't the latest request, if the popup went inactive, or if the query
 * moved on.
 */
class MentionPopupView {
  private host: HTMLElement | null;
  private root: HTMLDivElement | null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFetchedQuery: string | null = null;
  private requestSeq = 0;

  constructor(
    private view: EditorView,
    private docId: number | string,
  ) {
    const host = view.dom.parentElement;
    if (!host) {
      // Detached EditorView — nothing to anchor to. destroy() is a no-op.
      this.host = null;
      this.root = null;
      return;
    }
    this.host = host;
    this.root = document.createElement("div");
    this.root.className = "pm-mention-popup";
    this.root.style.display = "none";
    host.appendChild(this.root);
    this.update(view);
  }

  update(view: EditorView): void {
    this.view = view;
    const root = this.root;
    const host = this.host;
    if (!root || !host) return;

    const ms = mentionKey.getState(view.state);
    if (!ms || !ms.active) {
      root.style.display = "none";
      this.cancelDebounce();
      this.lastFetchedQuery = null;
      return;
    }

    this.position(view, ms.from);
    root.style.display = "block";

    // Kick off a (debounced) fetch when the query changed since the last one
    // we issued. Index-only changes (move) keep lastFetchedQuery, so they
    // don't refetch — they just re-render the highlight below.
    if (ms.query !== this.lastFetchedQuery) {
      this.scheduleFetch(ms.query);
    }

    this.renderResults(ms);
  }

  private position(view: EditorView, from: number): void {
    const root = this.root;
    const host = this.host;
    if (!root || !host) return;
    let coords: { left: number; bottom: number };
    try {
      coords = view.coordsAtPos(from);
    } catch {
      // coordsAtPos relies on getClientRects, which jsdom doesn't implement —
      // skip positioning under test. Visibility/state still behave correctly.
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
    const url = `/-/paper/api/docs/${this.docId}/mention-search?q=${encodeURIComponent(query)}&limit=20`;
    let results: MentionResult[] = [];
    let openAudience = false;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return;
      const json = (await resp.json()) as MentionSearchResponse;
      results = json.results ?? [];
      openAudience = json.open_audience ?? false;
    } catch {
      // Network/parse error — leave the (possibly empty) list alone.
      return;
    }
    // Staleness guards: a newer request superseded us, the popup closed, or
    // the user typed past the query this response was for.
    if (seq !== this.requestSeq) return;
    const ms = mentionKey.getState(this.view.state);
    if (!ms || !ms.active || ms.query !== query) return;
    setMentionResults(this.view, results, openAudience);
  }

  private renderResults(ms: MentionState): void {
    const root = this.root;
    if (!root) return;
    root.textContent = "";
    if (ms.results.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pm-mention-empty";
      empty.textContent = "No matches";
      root.appendChild(empty);
      return;
    }
    ms.results.forEach((result, i) => {
      const item = document.createElement("div");
      item.className = "pm-mention-item";
      if (i === ms.index) item.classList.add("pm-mention-item--active");
      if (result.avatarUrl) {
        const img = document.createElement("img");
        img.className = "pm-mention-avatar";
        img.src = result.avatarUrl;
        img.alt = "";
        img.setAttribute("aria-hidden", "true");
        item.appendChild(img);
      }
      item.appendChild(document.createTextNode(result.name));
      item.addEventListener("mousedown", (e) => {
        // Keep editor focus so the commit transaction applies cleanly.
        e.preventDefault();
        this.commitResult(result);
      });
      root.appendChild(item);
    });
    // When the doc audience can't be fully enumerated, hint (non-selectable)
    // that link-share viewers can also see the mention.
    if (ms.openAudience) {
      const hint = document.createElement("div");
      hint.className = "pm-mention-typing-hint";
      hint.textContent = "Anyone with the link can also view";
      root.appendChild(hint);
    }
  }

  private commitResult(result: MentionResult): void {
    const view = this.view;
    const ms = mentionKey.getState(view.state);
    if (!ms || !ms.active) return;
    const node = schema.nodes.mention.create({ actorId: result.id });
    view.dispatch(
      view.state.tr
        .replaceWith(ms.from, view.state.selection.from, node)
        .setMeta(mentionKey, { type: "commit" }),
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

/**
 * The `Plugin.view` popup that renders the `@` autocomplete list. Doc-scoped:
 * the candidate endpoint is `…/docs/{docId}/mention-search`, so the popup
 * takes the doc id (the `[[` popup hit a global path and took no arg).
 */
export function mentionSuggestPopupPlugin(docId: number | string): Plugin {
  return new Plugin({
    view(view) {
      return new MentionPopupView(view, docId);
    },
  });
}
