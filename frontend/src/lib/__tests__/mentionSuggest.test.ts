import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { schema } from "../schema";
import {
  mentionKey,
  mentionSuggestPlugin,
  mentionSuggestPopupPlugin,
  mentionKeymap,
  moveMentionSelection,
  setMentionResults,
  cancelMentionSuggest,
  commitMentionSelection,
  type MentionResult,
  type MentionState,
} from "../mentionSuggest";

function freshState(): EditorState {
  return EditorState.create({
    schema,
    plugins: [mentionSuggestPlugin],
  });
}

function ms(state: EditorState): MentionState {
  return mentionKey.getState(state)!;
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

const RESULTS: MentionResult[] = [
  { id: "alice", name: "Alice", avatarUrl: null },
  { id: "bob", name: "Bob", avatarUrl: "/avatars/bob.png" },
  { id: "carol", name: "Carol", avatarUrl: null },
];

describe("mentionSuggest plugin state", () => {
  it("activates on `@fo` at start of paragraph with the right query and from", () => {
    let state = freshState();
    state = type(state, "@fo");
    const m = ms(state);
    expect(m.active).toBe(true);
    expect(m.query).toBe("fo");
    // `from` points at the `@`: cursor pos minus the 3 chars `@fo`.
    expect(m.from).toBe(state.selection.from - 3);
  });

  it("activates after a space (word boundary), pointing `from` at the `@`", () => {
    let state = freshState();
    state = type(state, "hi @fo");
    const m = ms(state);
    expect(m.active).toBe(true);
    expect(m.query).toBe("fo");
    // The regex consumes the leading space, but `from` must be the `@`, i.e.
    // cursor minus `@fo` (3), NOT cursor minus the whole ` @fo` match (4).
    expect(m.from).toBe(state.selection.from - 3);
    // And the char at `from` is indeed the `@`.
    expect(state.doc.textBetween(m.from, m.from + 1)).toBe("@");
  });

  it("does NOT activate when `@` immediately follows a non-space char (email guard)", () => {
    let state = freshState();
    state = type(state, "bob@");
    expect(ms(state).active).toBe(false);
    state = type(state, "example");
    expect(ms(state).active).toBe(false);
  });

  it("extends and shrinks the query as you type and backspace", () => {
    let state = freshState();
    state = type(state, "@fo");
    expect(ms(state).query).toBe("fo");
    state = type(state, "o");
    expect(ms(state).query).toBe("foo");
    state = backspace(state);
    expect(ms(state).query).toBe("fo");
    expect(ms(state).active).toBe(true);
  });

  it("deactivates when the `@` is removed", () => {
    let state = freshState();
    state = type(state, "@fo");
    expect(ms(state).active).toBe(true);
    // Remove `fo` and the `@`.
    state = backspace(state, 3);
    expect(ms(state).active).toBe(false);
  });

  it("setMentionResults + moveMentionSelection clamps the index", () => {
    let state = freshState();
    state = type(state, "@fo");
    expect(ms(state).active).toBe(true);

    const view = {
      state,
      dispatch(tr: import("prosemirror-state").Transaction) {
        state = state.apply(tr);
        this.state = state;
      },
    };
    setMentionResults(
      view as unknown as import("prosemirror-view").EditorView,
      RESULTS,
      false,
    );
    expect(ms(state).results).toHaveLength(3);
    expect(ms(state).index).toBe(0);

    const move = (d: 1 | -1) => {
      moveMentionSelection(d)(state, (tr) => {
        state = state.apply(tr);
      });
    };

    move(1);
    expect(ms(state).index).toBe(1);
    move(1);
    expect(ms(state).index).toBe(2);
    move(1); // clamp at results.length - 1
    expect(ms(state).index).toBe(2);
    move(-1);
    expect(ms(state).index).toBe(1);
    move(-1);
    expect(ms(state).index).toBe(0);
    move(-1); // clamp at 0
    expect(ms(state).index).toBe(0);
  });

  it("moveMentionSelection falls through (false) when inactive", () => {
    const state = freshState();
    const acted = moveMentionSelection(1)(state, () => {});
    expect(acted).toBe(false);
  });

  it("commitMentionSelection replaces the span with a mention node carrying the string actorId", () => {
    let state = freshState();
    state = type(state, "before @fo");
    const fromBefore = ms(state).from;

    const view = {
      state,
      dispatch(tr: import("prosemirror-state").Transaction) {
        state = state.apply(tr);
        this.state = state;
      },
    };
    setMentionResults(
      view as unknown as import("prosemirror-view").EditorView,
      RESULTS,
      false,
    );
    // Highlight the second result (bob).
    moveMentionSelection(1)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(ms(state).index).toBe(1);

    const acted = commitMentionSelection()(state, (tr) => {
      state = state.apply(tr);
    });
    expect(acted).toBe(true);

    // The `@fo` range became a mention with the STRING actorId.
    const node = state.doc.nodeAt(fromBefore);
    expect(node?.type.name).toBe("mention");
    expect(node?.attrs.actorId).toBe("bob");
    // Surrounding text intact.
    expect(state.doc.textContent).toContain("before ");
    expect(state.doc.textContent).not.toContain("@fo");
    // State goes inactive.
    expect(ms(state).active).toBe(false);
  });

  it("commitMentionSelection falls through with no results", () => {
    let state = freshState();
    state = type(state, "@fo");
    const acted = commitMentionSelection()(state, () => {});
    expect(acted).toBe(false);
  });

  it("cancelMentionSuggest deactivates and does not re-open the same span", () => {
    let state = freshState();
    state = type(state, "@fo");
    expect(ms(state).active).toBe(true);

    const acted = cancelMentionSuggest()(state, (tr) => {
      state = state.apply(tr);
    });
    expect(acted).toBe(true);
    expect(ms(state).active).toBe(false);

    // Further typing within the SAME span must not re-activate it.
    state = type(state, "o");
    expect(ms(state).active).toBe(false);
  });

  it("cancelMentionSuggest falls through when inactive", () => {
    const state = freshState();
    const acted = cancelMentionSuggest()(state, () => {});
    expect(acted).toBe(false);
  });
});

describe("mentionSuggest popup + keymap (real EditorView)", () => {
  let view: EditorView;
  let host: HTMLDivElement;
  let fetchMock: ReturnType<typeof vi.fn>;

  function searchPayload(results: MentionResult[]) {
    return {
      ok: true,
      json: async () => ({ results, open_audience: false }),
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
        mentionSuggestPlugin,
        mentionSuggestPopupPlugin(7),
        keymap(mentionKeymap()),
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

  function curMs(): MentionState {
    return mentionKey.getState(view.state)!;
  }

  function popup(): HTMLElement | null {
    return host.querySelector(".pm-mention-popup");
  }

  it("typing `@fo` debounced-fetches doc-scoped results and shows the popup", async () => {
    view.dispatch(view.state.tr.insertText("@fo"));
    expect(curMs().active).toBe(true);

    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/-/paper/api/docs/7/mention-search?q=fo");
    expect(url).toContain("limit=20");

    expect(curMs().results).toHaveLength(3);
    const el = popup();
    expect(el).not.toBeNull();
    expect(el!.style.display).toBe("block");
    expect(el!.querySelectorAll(".pm-mention-item")).toHaveLength(3);
  });

  it("ArrowDown then Enter commits the highlighted mention with the string actorId", async () => {
    view.dispatch(view.state.tr.insertText("@fo"));
    await vi.runAllTimersAsync();
    expect(curMs().results).toHaveLength(3);

    moveMentionSelection(1)(view.state, view.dispatch.bind(view));
    expect(curMs().index).toBe(1);
    commitMentionSelection()(view.state, view.dispatch.bind(view));

    let found: { actorId: unknown } | null = null;
    view.state.doc.descendants((node) => {
      if (node.type.name === "mention") found = { actorId: node.attrs.actorId };
    });
    expect(found).not.toBeNull();
    expect(found!.actorId).toBe("bob");
    expect(view.state.doc.textContent).not.toContain("@fo");
    expect(curMs().active).toBe(false);
  });

  it("clicking a result commits that mention", async () => {
    view.dispatch(view.state.tr.insertText("@fo"));
    await vi.runAllTimersAsync();
    const items = popup()!.querySelectorAll<HTMLElement>(".pm-mention-item");
    expect(items).toHaveLength(3);
    // Click the third (carol).
    items[2].dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );

    let found: { actorId: unknown } | null = null;
    view.state.doc.descendants((node) => {
      if (node.type.name === "mention") found = { actorId: node.attrs.actorId };
    });
    expect(found).not.toBeNull();
    expect(found!.actorId).toBe("carol");
    expect(curMs().active).toBe(false);
  });

  it("Escape cancels: state inactive and popup hidden", async () => {
    view.dispatch(view.state.tr.insertText("@fo"));
    await vi.runAllTimersAsync();
    expect(curMs().active).toBe(true);
    expect(popup()!.style.display).toBe("block");

    cancelMentionSuggest()(view.state, view.dispatch.bind(view));
    expect(curMs().active).toBe(false);
    expect(popup()!.style.display).toBe("none");
  });
});
