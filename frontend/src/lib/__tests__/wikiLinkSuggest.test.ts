import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { buildKeymap } from "prosemirror-example-setup";
import { splitListItem } from "prosemirror-schema-list";
import { schema } from "../schema";
import {
  wikiLinkKey,
  wikiLinkSuggestPlugin,
  wikiLinkSuggestPopupPlugin,
  wikiLinkKeymap,
  moveWikiSelection,
  setWikiResults,
  cancelWikiSuggest,
  commitWikiSelection,
  type WikiResult,
  type WikiState,
} from "../wikiLinkSuggest";

function freshState(): EditorState {
  return EditorState.create({
    schema,
    plugins: [wikiLinkSuggestPlugin()],
  });
}

function ws(state: EditorState): WikiState {
  return wikiLinkKey.getState(state)!;
}

/** Type text at the current selection, returning the new state. */
function type(state: EditorState, text: string): EditorState {
  return state.apply(state.tr.insertText(text));
}

/** Delete `n` chars immediately before the cursor. */
function backspace(state: EditorState, n = 1): EditorState {
  const pos = state.selection.from;
  return state.apply(state.tr.delete(pos - n, pos));
}

const RESULTS: WikiResult[] = [
  { id: 10, name: "Alpha", state: "active", kind: "doc" },
  { id: 20, name: "Beta", state: "active", kind: "doc" },
  { id: 30, name: "Gamma", state: "active", kind: "doc" },
];

describe("wikiLinkSuggest plugin state", () => {
  it("activates on `[[fo` with the right query and from", () => {
    let state = freshState();
    state = type(state, "[[fo");
    const w = ws(state);
    expect(w.active).toBe(true);
    expect(w.query).toBe("fo");
    // `from` points at the first `[`: cursor pos minus the 4 chars `[[fo`.
    expect(w.from).toBe(state.selection.from - 4);
  });

  it("extends and shrinks the query as you type and backspace", () => {
    let state = freshState();
    state = type(state, "[[fo");
    expect(ws(state).query).toBe("fo");
    state = type(state, "o");
    expect(ws(state).query).toBe("foo");
    state = backspace(state);
    expect(ws(state).query).toBe("fo");
    expect(ws(state).active).toBe(true);
  });

  it("deactivates when a bracket of the `[[` is broken", () => {
    let state = freshState();
    state = type(state, "[[fo");
    expect(ws(state).active).toBe(true);
    // Delete the char right before the cursor down to one `[` left of the
    // query — removing a bracket breaks the trigger.
    // Cursor is after `[[fo`; delete `fo` then one `[`.
    state = backspace(state, 3); // removes `o`, `f`, and one `[`
    expect(ws(state).active).toBe(false);
  });

  it("setWikiResults + moveWikiSelection clamps the index", () => {
    let state = freshState();
    state = type(state, "[[fo");
    expect(ws(state).active).toBe(true);

    // setWikiResults dispatches via a fake view wrapper.
    const view = {
      state,
      dispatch(tr: import("prosemirror-state").Transaction) {
        state = state.apply(tr);
        this.state = state;
      },
    };
    setWikiResults(view as unknown as import("prosemirror-view").EditorView, RESULTS);
    expect(ws(state).results).toHaveLength(3);
    expect(ws(state).index).toBe(0);

    const move = (d: 1 | -1) => {
      moveWikiSelection(d)(state, (tr) => {
        state = state.apply(tr);
      });
    };

    move(1);
    expect(ws(state).index).toBe(1);
    move(1);
    expect(ws(state).index).toBe(2);
    move(1); // clamp at results.length - 1
    expect(ws(state).index).toBe(2);
    move(-1);
    expect(ws(state).index).toBe(1);
    move(-1);
    expect(ws(state).index).toBe(0);
    move(-1); // clamp at 0
    expect(ws(state).index).toBe(0);
  });

  it("moveWikiSelection falls through (false) when inactive", () => {
    const state = freshState();
    const acted = moveWikiSelection(1)(state, () => {});
    expect(acted).toBe(false);
  });

  it("commitWikiSelection replaces the span with a paper_link node", () => {
    let state = freshState();
    state = type(state, "before [[fo");
    const fromBefore = ws(state).from;

    const view = {
      state,
      dispatch(tr: import("prosemirror-state").Transaction) {
        state = state.apply(tr);
        this.state = state;
      },
    };
    setWikiResults(view as unknown as import("prosemirror-view").EditorView, RESULTS);
    // Highlight the second result (id 20).
    moveWikiSelection(1)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(ws(state).index).toBe(1);

    const acted = commitWikiSelection()(state, (tr) => {
      state = state.apply(tr);
    });
    expect(acted).toBe(true);

    // The `[[fo` range became a paper_link with docId 20.
    const node = state.doc.nodeAt(fromBefore);
    expect(node?.type.name).toBe("paper_link");
    expect(node?.attrs.docId).toBe(20);
    // Surrounding text intact.
    expect(state.doc.textContent).toContain("before ");
    expect(state.doc.textContent).not.toContain("[[");
    // State goes inactive.
    expect(ws(state).active).toBe(false);
  });

  it("commitWikiSelection falls through with no results", () => {
    let state = freshState();
    state = type(state, "[[fo");
    const acted = commitWikiSelection()(state, () => {});
    expect(acted).toBe(false);
  });

  it("cancelWikiSuggest deactivates and does not re-open the same span", () => {
    let state = freshState();
    state = type(state, "[[fo");
    expect(ws(state).active).toBe(true);

    const acted = cancelWikiSuggest()(state, (tr) => {
      state = state.apply(tr);
    });
    expect(acted).toBe(true);
    expect(ws(state).active).toBe(false);

    // A no-op transaction (or further typing within the SAME span) must not
    // re-activate the dismissed span. Re-type the same trailing char path:
    // type another `o` -> still the same `[[` start, stays dismissed.
    state = type(state, "o");
    expect(ws(state).active).toBe(false);
  });

  it("cancelWikiSuggest falls through when inactive", () => {
    const state = freshState();
    const acted = cancelWikiSuggest()(state, () => {});
    expect(acted).toBe(false);
  });
});

describe("wikiLinkSuggest popup + keymap (real EditorView)", () => {
  let view: EditorView;
  let host: HTMLDivElement;
  let fetchMock: ReturnType<typeof vi.fn>;

  function searchPayload(results: WikiResult[]) {
    return {
      ok: true,
      json: async () => ({ results }),
    } as unknown as Response;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => searchPayload(RESULTS));
    vi.stubGlobal("fetch", fetchMock);

    host = document.createElement("div");
    document.body.appendChild(host);
    const place = document.createElement("div");
    host.appendChild(place);

    const state = EditorState.create({
      schema,
      plugins: [
        wikiLinkSuggestPlugin(),
        wikiLinkSuggestPopupPlugin(),
        keymap(wikiLinkKeymap()),
      ],
    });
    view = new EditorView(place, { state });
  });

  afterEach(() => {
    // Always destroy — the popup's debounce timer is a leaked-timer hazard.
    view.destroy();
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function curWs(): WikiState {
    return wikiLinkKey.getState(view.state)!;
  }

  function popup(): HTMLElement | null {
    return host.querySelector(".pm-wikilink-popup");
  }

  it("typing `[[fo` debounced-fetches results and shows the popup", async () => {
    view.dispatch(view.state.tr.insertText("[[fo"));
    expect(curWs().active).toBe(true);

    // Advance past the debounce and flush the fetch promise chain.
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/-/paper/api/link-search?q=fo");
    expect(url).toContain("limit=20");

    expect(curWs().results).toHaveLength(3);
    const el = popup();
    expect(el).not.toBeNull();
    expect(el!.style.display).toBe("block");
    // The rendered list reflects plugin state.
    expect(el!.querySelectorAll(".pm-wikilink-item")).toHaveLength(3);
  });

  it("ArrowDown then Enter commits the highlighted paper_link", async () => {
    view.dispatch(view.state.tr.insertText("[[fo"));
    await vi.runAllTimersAsync();
    expect(curWs().results).toHaveLength(3);

    // Move to the second result (id 20), then commit.
    moveWikiSelection(1)(view.state, view.dispatch.bind(view));
    expect(curWs().index).toBe(1);
    commitWikiSelection()(view.state, view.dispatch.bind(view));

    // The `[[fo` text became a paper_link with the chosen id.
    let found: { docId: unknown } | null = null;
    view.state.doc.descendants((node) => {
      if (node.type.name === "paper_link") found = { docId: node.attrs.docId };
    });
    expect(found).not.toBeNull();
    expect(found!.docId).toBe(20);
    expect(view.state.doc.textContent).not.toContain("[[");
    expect(curWs().active).toBe(false);
  });

  it("Escape cancels: state inactive and popup hidden", async () => {
    view.dispatch(view.state.tr.insertText("[[fo"));
    await vi.runAllTimersAsync();
    expect(curWs().active).toBe(true);
    expect(popup()!.style.display).toBe("block");

    cancelWikiSuggest()(view.state, view.dispatch.bind(view));
    expect(curWs().active).toBe(false);
    expect(popup()!.style.display).toBe("none");
  });
});

describe("wikiLinkSuggest create-page row", () => {
  /** Minimal view stub: applies dispatches to its own `state`, no-op focus. */
  function fakeView(initial: EditorState) {
    const v = {
      state: initial,
      dispatch(tr: import("prosemirror-state").Transaction) {
        v.state = v.state.apply(tr);
      },
      focus() {},
    };
    return v as unknown as EditorView & { state: EditorState };
  }

  /** Flush the async create flow (a microtask-deep promise chain). */
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function withQuery(opts: { onCreatePage?: (t: string) => Promise<number | null> }, text: string) {
    let state = EditorState.create({
      schema,
      plugins: [wikiLinkSuggestPlugin(opts)],
    });
    state = state.apply(state.tr.insertText(text));
    return fakeView(state);
  }

  it("committing the create row mints a doc and inserts its paper_link", async () => {
    const onCreatePage = vi.fn(async () => 99);
    const opts = { onCreatePage };
    const view = withQuery(opts, "see [[Foo");
    // No results fetched: the only navigable row is the create row at index 0.
    expect(wikiLinkKey.getState(view.state)!.index).toBe(0);

    const acted = commitWikiSelection(opts)(view.state, view.dispatch, view);
    expect(acted).toBe(true);
    await flush();

    // The query (trimmed) is what we asked the host to create.
    expect(onCreatePage).toHaveBeenCalledWith("Foo");
    // The `[[Foo` span became a paper_link pointing at the new id.
    let docId: unknown = null;
    view.state.doc.descendants((n) => {
      if (n.type.name === "paper_link") docId = n.attrs.docId;
    });
    expect(docId).toBe(99);
    expect(view.state.doc.textContent).not.toContain("[[");
    expect(view.state.doc.textContent).toContain("see ");
  });

  it("a cancelled create (null) leaves the typed `[[query` untouched", async () => {
    const onCreatePage = vi.fn(async () => null);
    const opts = { onCreatePage };
    const view = withQuery(opts, "[[Foo");

    commitWikiSelection(opts)(view.state, view.dispatch, view);
    await flush();

    expect(onCreatePage).toHaveBeenCalled();
    let hasLink = false;
    view.state.doc.descendants((n) => {
      if (n.type.name === "paper_link") hasLink = true;
    });
    expect(hasLink).toBe(false);
    expect(view.state.doc.textContent).toContain("[[Foo");
  });

  it("ArrowDown walks past the results onto the create row, then clamps", () => {
    const opts = { onCreatePage: async () => 1 };
    const view = withQuery(opts, "[[fo");
    setWikiResults(view, RESULTS);
    expect(wikiLinkKey.getState(view.state)!.results).toHaveLength(3);

    const down = () => moveWikiSelection(1)(view.state, view.dispatch);
    down(); // 0 -> 1
    down(); // 1 -> 2
    down(); // 2 -> 3 (the create row sits at index === results.length)
    expect(wikiLinkKey.getState(view.state)!.index).toBe(3);
    down(); // clamps at the create row
    expect(wikiLinkKey.getState(view.state)!.index).toBe(3);
  });

  it("without onCreatePage there is no create row to commit", () => {
    // results.length === 0 and no create row → Enter falls through.
    const view = withQuery({}, "[[fo");
    const acted = commitWikiSelection({})(view.state, view.dispatch, view);
    expect(acted).toBe(false);
    // The index never extends past the (empty) result list.
    moveWikiSelection(1)(view.state, view.dispatch);
    expect(wikiLinkKey.getState(view.state)!.index).toBe(0);
  });
});

/**
 * Regression guard for the keymap-ordering bug: Enter has competing handlers
 * (`splitListItem` for task/list items via the list keymap + buildKeymap), so
 * the `[[` keymap MUST be registered ahead of them. Earlier it sat *after*
 * buildKeymap, so inside a list item `splitListItem` swallowed Enter and the
 * popup's commit never fired — Enter split the list instead of picking the
 * highlighted row. These tests drive a *real* Enter keydown through the same
 * plugin ordering collab.ts uses (the unit tests above call commitWikiSelection
 * directly, which bypasses keymap priority and so never caught this).
 */
describe("wikiLinkSuggest Enter through the keymap chain", () => {
  let host: HTMLElement;
  let view: EditorView;

  afterEach(() => {
    view.destroy();
    host.remove();
  });

  /**
   * Build a view whose plugins mirror collab.ts's Enter-handler ordering: the
   * `[[` keymap first, THEN the list/task split keymaps. `inList` wraps the
   * `[[query` paragraph in a bullet list so the competing `splitListItem`
   * handlers are live.
   */
  function mount(query: string, inList: boolean): void {
    host = document.createElement("div");
    document.body.appendChild(host);

    const para = schema.nodes.paragraph.create();
    const body = inList
      ? schema.nodes.bullet_list.create(null, schema.nodes.list_item.create(null, para))
      : para;
    const docNode = schema.nodes.doc.create(null, body);

    let state = EditorState.create({
      doc: docNode,
      // Order matches collab.ts after the fix: suggestion keymap precedes the
      // list/task split keymap and buildKeymap.
      plugins: [
        wikiLinkSuggestPlugin(),
        keymap(wikiLinkKeymap()),
        keymap({ Enter: splitListItem(schema.nodes.task_item) }),
        keymap(buildKeymap(schema)),
        keymap(baseKeymap),
      ],
    });
    // Drop the cursor inside the (only) paragraph and type the trigger.
    const cursor = TextSelection.near(state.doc.resolve(inList ? 3 : 1));
    state = state.apply(state.tr.setSelection(cursor).insertText(query));
    view = new EditorView(host, { state });
    // Seed results synchronously (no fetch in this suite).
    view.dispatch(
      view.state.tr.setMeta(wikiLinkKey, { type: "setResults", results: RESULTS }),
    );
  }

  /** Fire Enter through the plugin keydown chain, first-truthy-wins. */
  function pressEnter(): boolean {
    const event = new KeyboardEvent("keydown", { key: "Enter" });
    return view.someProp("handleKeyDown", (f) => f(view, event)) ?? false;
  }

  function linkId(): unknown {
    let id: unknown = null;
    view.state.doc.descendants((n) => {
      if (n.type.name === "paper_link") id = n.attrs.docId;
    });
    return id;
  }

  it("commits the highlighted result inside a list item (not split list)", () => {
    mount("[[fo", true);
    moveWikiSelection(1)(view.state, view.dispatch.bind(view)); // -> Beta (id 20)

    expect(pressEnter()).toBe(true);

    // Enter inserted the paper_link rather than splitting the list item.
    expect(linkId()).toBe(20);
    expect(view.state.doc.textContent).not.toContain("[[");
    expect(wikiLinkKey.getState(view.state)!.active).toBe(false);
    // Still a single list item — no split happened.
    let listItems = 0;
    view.state.doc.descendants((n) => {
      if (n.type.name === "list_item") listItems += 1;
    });
    expect(listItems).toBe(1);
  });

  it("commits the highlighted result in a plain paragraph", () => {
    mount("[[fo", false);
    expect(pressEnter()).toBe(true);
    expect(linkId()).toBe(10); // first result
    expect(view.state.doc.textContent).not.toContain("[[");
  });
});
