/**
 * `#`-triggered tag autocomplete — state + decorations + popup.
 *
 * Mirrors `mentionSuggest.ts` (which mirrors `wikiLinkSuggest.ts`): one
 * PluginKey, a `state.apply` that handles `setMeta` first then recomputes from
 * doc+selection, and a `decorations` prop painting a `.pm-tag-typing` inline
 * decoration over the in-progress `#query` span. A `Plugin.view` popup renders
 * the floating suggestion list.
 *
 * Differences from `@` mentions: a tag is its own value (no id→name resolve),
 * so there's no avatar/openAudience and committing stores the slug directly.
 * Suggestions come from the instance-wide tag vocabulary
 * (`GET /-/paper/api/tags`, ACL-filtered), fetched once and filtered
 * client-side; a non-matching query is still committable as a brand-new tag
 * (the Obsidian "type #anything" behaviour).
 *
 * Like `@`, `#` can appear mid-word, so the trigger requires start-of-textblock
 * or a whitespace char before the `#`. A `cancel` remembers the dismissed `#`
 * start so the popup doesn't immediately re-open over the same span.
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

export interface TagResult {
  tag: string;
}

export interface TagState {
  active: boolean;
  query: string; // text after `#`
  from: number; // doc pos of the `#`
  index: number; // highlighted result index
  results: TagResult[];
  // Internal: the `from` of a span the user just cancelled out of, so the
  // SAME `#query` span doesn't immediately re-open. Cleared when a fresh,
  // different `#` starts.
  dismissedFrom?: number;
}

type TagMeta =
  | { type: "setResults"; results: TagResult[] }
  | { type: "move"; d: 1 | -1 }
  | { type: "cancel" }
  | { type: "commit" };

const INACTIVE: TagState = {
  active: false,
  query: "",
  from: -1,
  index: 0,
  results: [],
};

export const tagKey = new PluginKey<TagState>("tagSuggest");

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function clampIndex(index: number, len: number): number {
  return clamp(index, 0, Math.max(0, len - 1));
}

// `#` at a word boundary (start of textblock or after whitespace), followed by
// a run of tag-ish chars (word chars, `/`, `-`) anchored to the cursor. The
// leading `(?:^|\s)` may consume one whitespace char, so `from` is measured
// from the `#query` length, not `m[0].length`.
const TRIGGER = /(?:^|\s)#([\w/-]*)$/;

/** Recompute state from the current doc + selection (no meta involved). */
function recompute(
  _tr: Transaction,
  prev: TagState,
  newState: EditorState,
): TagState {
  const sel = newState.selection;
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
    return INACTIVE;
  }
  const c = sel.from;
  const at = m[0].lastIndexOf("#"); // offset of `#` within the match
  const matchLen = m[0].length - at; // length of `#query`
  const from = c - matchLen; // doc pos of the `#`
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

// @feat tag: #-trigger autocomplete state machine + atom insertion
export const tagSuggestPlugin = new Plugin<TagState>({
  key: tagKey,
  state: {
    init() {
      return { ...INACTIVE };
    },
    apply(tr, prev, _oldState, newState) {
      const meta = tr.getMeta(tagKey) as TagMeta | undefined;
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
      const ts = tagKey.getState(state);
      if (!ts || !ts.active) return DecorationSet.empty;
      const cursorTo = state.selection.from;
      return DecorationSet.create(state.doc, [
        Decoration.inline(ts.from, cursorTo, { class: "pm-tag-typing" }),
      ]);
    },
  },
});

type Command = (
  state: EditorState,
  dispatch?: (tr: Transaction) => void,
) => boolean;

/** Move the highlighted result by `d`; falls through when inactive. */
export function moveTagSelection(d: 1 | -1): Command {
  return (state, dispatch) => {
    const ts = tagKey.getState(state);
    if (!ts || !ts.active) return false;
    if (dispatch) {
      dispatch(state.tr.setMeta(tagKey, { type: "move", d }));
    }
    return true;
  };
}

/** Push fetched results into the plugin state (popup calls this). */
export function setTagResults(view: EditorView, results: TagResult[]): void {
  view.dispatch(view.state.tr.setMeta(tagKey, { type: "setResults", results }));
}

/** Dismiss the popup; falls through when inactive. */
export function cancelTagSuggest(): Command {
  return (state, dispatch) => {
    const ts = tagKey.getState(state);
    if (!ts || !ts.active) return false;
    if (dispatch) {
      dispatch(state.tr.setMeta(tagKey, { type: "cancel" }));
    }
    return true;
  };
}

/** Normalize a typed query into a stored slug (mirrors the server rule
 * loosely — the trigger already excludes whitespace, so just lowercase). */
function slugify(query: string): string {
  return query.toLowerCase();
}

/** The slug to commit: the highlighted suggestion, else the typed query as a
 * brand-new tag. Returns null only when there's nothing to commit. */
function commitTarget(ts: TagState): string | null {
  const picked = ts.results[ts.index];
  if (picked) return picked.tag;
  const slug = slugify(ts.query);
  return slug ? slug : null;
}

/** Replace the `#query` span with a tag node (highlighted result or the typed
 * query as a new tag). */
export function commitTagSelection(): Command {
  return (state, dispatch) => {
    const ts = tagKey.getState(state);
    if (!ts || !ts.active) return false;
    const slug = commitTarget(ts);
    if (slug === null) return false;
    if (dispatch) {
      const to = state.selection.from;
      const node = schema.nodes.tag.create({ tag: slug });
      dispatch(
        state.tr.replaceWith(ts.from, to, node).setMeta(tagKey, { type: "commit" }),
      );
    }
    return true;
  };
}

/**
 * Keymap consumed while the `#` popup is open. Each command returns false when
 * inactive so normal keystrokes fall through. MUST be registered before
 * `baseKeymap` so Enter/Arrow/Escape are intercepted while the popup is up.
 */
export function tagKeymap(): Record<string, Command> {
  return {
    ArrowDown: moveTagSelection(1),
    ArrowUp: moveTagSelection(-1),
    Enter: commitTagSelection(),
    Escape: cancelTagSuggest(),
  };
}

interface TagsResponse {
  tags: { tag: string; count: number }[];
}

const MAX_SUGGESTIONS = 12;

/**
 * Floating suggestion list for the `#` autocomplete. Mirrors the
 * `MentionPopupView` structure but sources its candidates from the
 * instance-wide vocabulary (`GET /-/paper/api/tags`), fetched once on first
 * open and filtered client-side. A non-matching query still gets a
 * "Create #query" affordance so new tags can be authored inline.
 */
class TagPopupView {
  private host: HTMLElement | null;
  private root: HTMLDivElement | null;
  private vocab: string[] | null = null;
  private vocabLoading = false;
  private lastQuery: string | null = null;

  constructor(private view: EditorView) {
    const host = view.dom.parentElement;
    if (!host) {
      this.host = null;
      this.root = null;
      return;
    }
    this.host = host;
    this.root = document.createElement("div");
    this.root.className = "pm-tag-popup";
    this.root.style.display = "none";
    host.appendChild(this.root);
    this.update(view);
  }

  update(view: EditorView): void {
    this.view = view;
    const root = this.root;
    const host = this.host;
    if (!root || !host) return;

    const ts = tagKey.getState(view.state);
    if (!ts || !ts.active) {
      root.style.display = "none";
      this.lastQuery = null;
      return;
    }

    this.position(view, ts.from);
    root.style.display = "block";

    void this.ensureVocab();
    if (ts.query !== this.lastQuery) {
      this.lastQuery = ts.query;
      this.recomputeResults(ts.query);
    }
    this.renderResults(ts);
  }

  private position(view: EditorView, from: number): void {
    const root = this.root;
    const host = this.host;
    if (!root || !host) return;
    let coords: { left: number; bottom: number };
    try {
      coords = view.coordsAtPos(from);
    } catch {
      // jsdom has no getClientRects — skip positioning under test.
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

  private async ensureVocab(): Promise<void> {
    if (this.vocab !== null || this.vocabLoading) return;
    this.vocabLoading = true;
    try {
      const resp = await fetch("/-/paper/api/tags");
      if (resp.ok) {
        const json = (await resp.json()) as TagsResponse;
        this.vocab = (json.tags ?? []).map((t) => t.tag);
      } else {
        this.vocab = [];
      }
    } catch {
      this.vocab = [];
    } finally {
      this.vocabLoading = false;
    }
    // Re-filter against the now-loaded vocab for the current query.
    const ts = tagKey.getState(this.view.state);
    if (ts && ts.active) {
      this.lastQuery = ts.query;
      this.recomputeResults(ts.query);
    }
  }

  private recomputeResults(query: string): void {
    const q = query.toLowerCase();
    const vocab = this.vocab ?? [];
    const matches = vocab
      .filter((t) => q === "" || t.includes(q))
      .sort((a, b) => {
        const ap = a.startsWith(q) ? 0 : 1;
        const bp = b.startsWith(q) ? 0 : 1;
        return ap - bp || a.localeCompare(b);
      })
      .slice(0, MAX_SUGGESTIONS)
      .map((tag) => ({ tag }));
    setTagResults(this.view, matches);
  }

  private renderResults(ts: TagState): void {
    const root = this.root;
    if (!root) return;
    root.textContent = "";

    const exact = ts.results.some((r) => r.tag === ts.query.toLowerCase());
    // "Create" affordance when the typed query isn't already an exact match.
    const showCreate = ts.query !== "" && !exact;

    if (ts.results.length === 0 && !showCreate) {
      const empty = document.createElement("div");
      empty.className = "pm-tag-empty";
      empty.textContent = "Type a tag…";
      root.appendChild(empty);
      return;
    }

    ts.results.forEach((result, i) => {
      const item = document.createElement("div");
      item.className = "pm-tag-item";
      if (i === ts.index) item.classList.add("pm-tag-item--active");
      item.appendChild(document.createTextNode(`#${result.tag}`));
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.commitSlug(result.tag);
      });
      root.appendChild(item);
    });

    if (showCreate) {
      const slug = ts.query.toLowerCase();
      const item = document.createElement("div");
      item.className = "pm-tag-item pm-tag-create";
      item.appendChild(document.createTextNode(`Create #${slug}`));
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.commitSlug(slug);
      });
      root.appendChild(item);
    }
  }

  private commitSlug(slug: string): void {
    const view = this.view;
    const ts = tagKey.getState(view.state);
    if (!ts || !ts.active) return;
    const node = schema.nodes.tag.create({ tag: slug });
    view.dispatch(
      view.state.tr
        .replaceWith(ts.from, view.state.selection.from, node)
        .setMeta(tagKey, { type: "commit" }),
    );
    view.focus();
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
  }
}

/** The `Plugin.view` popup that renders the `#` autocomplete list. The
 * vocabulary endpoint is global, so this takes no doc id. */
export function tagSuggestPopupPlugin(): Plugin {
  return new Plugin({
    view(view) {
      return new TagPopupView(view);
    },
  });
}
