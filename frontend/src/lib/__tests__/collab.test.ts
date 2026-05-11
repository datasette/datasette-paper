import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { getVersion, sendableSteps } from "prosemirror-collab";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { EditorConnection, preloadMarkdownParser } from "../collab";
import type { ConnectionOpts, StepApplyError } from "../collab";
import { schema } from "../schema";

// ─── Mock EventSource ────────────────────────────────────────────────────────

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  readyState: number = 0; // CONNECTING
  private listeners: Record<string, Array<(evt: Event) => void>> = {};

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (evt: Event) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: (evt: Event) => void) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }
  }

  dispatchEvent(type: string, data?: string) {
    const handlers = this.listeners[type] ?? [];
    const evt = { type, data: data ?? "" } as unknown as MessageEvent;
    handlers.forEach((h) => h(evt));
  }

  close() {
    this.readyState = 2; // CLOSED
  }
}

// ─── Bootstrap fixture ────────────────────────────────────────────────────────

const BOOTSTRAP = {
  doc: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
  },
  version: 5,
  snapshotVersion: 5,
  steps: [] as unknown[],
  clientIDs: [] as unknown[],
  users: 1,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeBootstrapFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ...BOOTSTRAP }),
  });
}

function makeEl(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function makeOpts(el: HTMLElement): ConnectionOpts {
  return { docId: "test-doc", place: el };
}

/** Wait for a condition by asserting inside the callback (so waitFor retries on throw). */
async function waitFor(condition: () => void, timeout = 3000): Promise<void> {
  return vi.waitFor(condition, { timeout });
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ─── Test: doc state events ─────────────────────────────────────────────────

describe("doc state (archive/trash)", () => {
  it("calls onDocState with the bootstrap state and again on `state-changed` SSE", async () => {
    const el = makeEl();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...BOOTSTRAP,
        state: "active",
        archived_at: null,
        trashed_at: null,
        delete_at: null,
      }),
    });
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const events: Array<{ state: string; delete_at: string | null }> = [];
    const conn = new EditorConnection({
      docId: "test-doc",
      place: el,
      onDocState: (s) => {
        events.push({ state: s.state, delete_at: s.delete_at });
      },
    });

    await waitFor(() => expect(conn.view).not.toBeNull());
    // Bootstrap fired once with the seeded state.
    expect(events).toEqual([{ state: "active", delete_at: null }]);

    // Server flips state to trashed and broadcasts state-changed.
    const es = MockEventSource.instances[0];
    es.dispatchEvent(
      "state-changed",
      JSON.stringify({
        state: "trashed",
        archived_at: null,
        trashed_at: "2026-05-07T12:00:00.000Z",
        delete_at: "2026-05-14T12:00:00.000Z",
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      state: "trashed",
      delete_at: "2026-05-14T12:00:00.000Z",
    });

    conn.close();
  });

  it("ignores malformed `state-changed` payloads without throwing", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const events: string[] = [];
    const conn = new EditorConnection({
      docId: "test-doc",
      place: el,
      onDocState: (s) => events.push(s.state),
    });
    await waitFor(() => expect(conn.view).not.toBeNull());

    const es = MockEventSource.instances[0];
    // Junk JSON.
    es.dispatchEvent("state-changed", "not-json");
    // Unknown state.
    es.dispatchEvent("state-changed", JSON.stringify({ state: "wat" }));

    // No additional callbacks beyond the (missing) bootstrap one — the
    // bootstrap fixture has no `state` field, so the callback fires zero
    // times for this test's setup.
    expect(events).toEqual([]);

    conn.close();
  });
});

// ─── Test 1: start() happy path ───────────────────────────────────────────────

describe("start() happy path", () => {
  it("bootstraps EditorView and opens EventSource at correct URL", async () => {
    const el = makeEl();
    const fetchMock = makeBootstrapFetch();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const conn = new EditorConnection(makeOpts(el));

    // Wait for view to be created (waitFor retries on assertion failure)
    await waitFor(() => expect(conn.view).not.toBeNull());

    // Version matches bootstrap
    const version = getVersion(conn.view!.state);
    expect(version).toBe(BOOTSTRAP.version);

    // Fetch was called with the bootstrap URL
    expect(fetchMock).toHaveBeenCalledWith(
      "/-/paper/api/docs/test-doc",
      expect.objectContaining({ method: "GET" })
    );

    // EventSource opened with correct URL including version
    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.instances[0].url).toContain(
      "/-/paper/api/docs/test-doc/events?version=5"
    );

    conn.close();
  });
});

// ─── Test 2: dispatchTransaction → send() 200 ────────────────────────────────

describe("send() 200 response", () => {
  it("POSTs correct body shape and clears sendable steps on 200", async () => {
    const el = makeEl();

    const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === "POST" && (url as string).endsWith("/events")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ version: BOOTSTRAP.version + 1 }),
        });
      }
      // Bootstrap GET
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ...BOOTSTRAP }),
      });
    });
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    // Dispatch a real ProseMirror transaction that inserts a character
    const view = conn.view!;
    const tr = view.state.tr.insertText("X", 1);
    view.dispatch(tr);

    // Wait for the send() POST to be called
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (call) => {
          const [url, opts] = call as [string, RequestInit];
          return typeof url === "string" && url.endsWith("/events") && opts?.method === "POST";
        }
      );
      expect(postCall).toBeDefined();
    });

    // Find POST call
    const postCall = fetchMock.mock.calls.find(
      (call) => {
        const [url, opts] = call as [string, RequestInit];
        return typeof url === "string" && url.endsWith("/events") && opts?.method === "POST";
      }
    );

    const body = JSON.parse(postCall![1].body as string);
    expect(body).toMatchObject({
      version: BOOTSTRAP.version,
    });
    expect(Array.isArray(body.steps)).toBe(true);
    expect(typeof body.clientID).toBe("number");

    // After 200, sendable steps should be cleared
    await waitFor(() => expect(sendableSteps(conn.view!.state)).toBeNull());

    conn.close();
  });
});

// ─── Test 3: send() 409 ────────────────────────────────────────────────────

describe("send() 409 response", () => {
  it("closes and reopens the SSE stream on 409", async () => {
    const el = makeEl();

    const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === "POST" && (url as string).endsWith("/events")) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({}),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ...BOOTSTRAP }),
      });
    });
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const initialES = MockEventSource.instances[0];
    expect(initialES).toBeDefined();

    // Trigger a send
    const view = conn.view!;
    const tr = view.state.tr.insertText("X", 1);
    view.dispatch(tr);

    // Wait for 409 to be processed → SSE stream should be reopened
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2));

    // The original EventSource should be closed
    expect(initialES.readyState).toBe(2); // CLOSED

    // A new EventSource should be opened with the latest version in the URL
    const newES = MockEventSource.instances[MockEventSource.instances.length - 1];
    expect(newES).not.toBe(initialES);
    expect(newES.url).toContain("/events?version=");

    conn.close();
  });
});

// ─── Test 4: send() 410 ────────────────────────────────────────────────────

describe("send() 410 response", () => {
  it("calls start() again (full restart) on 410", async () => {
    const el = makeEl();

    let bootstrapCallCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === "POST" && (url as string).endsWith("/events")) {
        return Promise.resolve({
          ok: false,
          status: 410,
          json: async () => ({}),
        });
      }
      // Bootstrap GET
      bootstrapCallCount++;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ...BOOTSTRAP }),
      });
    });
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    expect(bootstrapCallCount).toBe(1);

    // Trigger a send
    const view = conn.view!;
    const tr = view.state.tr.insertText("X", 1);
    view.dispatch(tr);

    // Wait for restart — bootstrap should be called a second time
    await waitFor(() => expect(bootstrapCallCount).toBeGreaterThanOrEqual(2));

    conn.close();
  });
});

// ─── Test: keymap wires markdown shortcuts ──────────────────────────────────

describe("markdown keybindings", () => {
  it("Mod-B (ctrl in jsdom) toggles strong mark on the current selection", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Select "Hello" — paragraph content runs from doc pos 1..6
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)),
    );

    const evt = new KeyboardEvent("keydown", { key: "b", ctrlKey: true });
    const handled = view.someProp("handleKeyDown", (fn) => fn(view, evt));
    expect(handled).toBe(true);

    expect(view.state.doc.rangeHasMark(1, 6, schema.marks.strong)).toBe(true);

    conn.close();
  });

  it("`# ` input rule promotes the textblock to a heading", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Replace "Hello" (pos 1..6) with just "#" so the input rule's
    // textBefore-anchor matches once we feed it the trailing space.
    view.dispatch(
      view.state.tr.replaceWith(1, 6, schema.text("#")),
    );

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 2, 2, " ", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const top = view.state.doc.firstChild!;
    expect(top.type.name).toBe("heading");
    expect(top.attrs.level).toBe(1);

    conn.close();
  });

  it("Shift-Ctrl-1 promotes the textblock to a heading", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const evt = new KeyboardEvent("keydown", {
      key: "1",
      ctrlKey: true,
      shiftKey: true,
    });
    const handled = view.someProp("handleKeyDown", (fn) => fn(view, evt));
    expect(handled).toBe(true);

    const top = view.state.doc.firstChild!;
    expect(top.type.name).toBe("heading");
    expect(top.attrs.level).toBe(1);

    conn.close();
  });
});

// ─── Test: inline mark input rules ──────────────────────────────────────────

describe("inline mark input rules", () => {
  it("`**bold**` autoformats as a strong mark and strips the delimiters", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Replace "Hello" with `**bold*` so typing the final `*` completes `**bold**`.
    view.dispatch(view.state.tr.replaceWith(1, 6, schema.text("**bold*")));

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 8, 8, "*", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const para = view.state.doc.firstChild!;
    expect(para.type.name).toBe("paragraph");
    expect(para.textContent).toBe("bold");
    expect(view.state.doc.rangeHasMark(1, 5, schema.marks.strong)).toBe(true);

    conn.close();
  });

  it("`*em*` autoformats as an em mark", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    view.dispatch(view.state.tr.replaceWith(1, 6, schema.text("*em")));

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 4, 4, "*", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const para = view.state.doc.firstChild!;
    expect(para.textContent).toBe("em");
    expect(view.state.doc.rangeHasMark(1, 3, schema.marks.em)).toBe(true);
    expect(view.state.doc.rangeHasMark(1, 3, schema.marks.strong)).toBe(false);
  });

  it("the em rule does not fire on the inner `*`s of `**bold**`", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Set up `**bold*` then type the second closing `*` — the strong rule
    // must win, leaving the doc with one strong span and no em.
    view.dispatch(view.state.tr.replaceWith(1, 6, schema.text("**bold*")));

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 8, 8, "*", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const para = view.state.doc.firstChild!;
    expect(para.textContent).toBe("bold");
    expect(view.state.doc.rangeHasMark(1, 5, schema.marks.strong)).toBe(true);
    expect(view.state.doc.rangeHasMark(1, 5, schema.marks.em)).toBe(false);

    conn.close();
  });

  it("`` `code` `` autoformats as a code mark", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    view.dispatch(view.state.tr.replaceWith(1, 6, schema.text("`code")));

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 6, 6, "`", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const para = view.state.doc.firstChild!;
    expect(para.textContent).toBe("code");
    expect(view.state.doc.rangeHasMark(1, 5, schema.marks.code)).toBe(true);

    conn.close();
  });

  it("`[text](url)` autoformats as an inline link", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // `[link](https://x.test` (21 chars) → typing `)` completes the markdown.
    view.dispatch(
      view.state.tr.replaceWith(1, 6, schema.text("[link](https://x.test")),
    );

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 22, 22, ")", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const para = view.state.doc.firstChild!;
    expect(para.textContent).toBe("link");
    const linkType = schema.marks.link;
    expect(view.state.doc.rangeHasMark(1, 5, linkType)).toBe(true);
    // Inspect the link mark's href attr by walking the inline node.
    let href: string | null = null;
    para.descendants((node) => {
      const lm = node.marks.find((m) => m.type === linkType);
      if (lm) href = lm.attrs.href as string;
    });
    expect(href).toBe("https://x.test");

    conn.close();
  });

  // Regression: when the user has already produced `<code>code</code>` inside
  // a `[...]` bracket pair (via the `` ` `` autoformat) and then closes the
  // markdown link with `](url)`, the link input rule should not destroy the
  // existing inline-code mark on "code". The bug: linkInputRule replaces the
  // matched range with `schema.text(match[1], [link])` — a plain string with
  // only the link mark — wiping the code mark.
  it("`[`code` something](url)` keeps the inline code mark inside the link", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const codeMark = schema.marks.code.create();
    // Build the paragraph the way it looks just before the user types `)`:
    //   [<code>code</code> something](https://x.test
    // Three text nodes: "[", marked "code", " something](https://x.test"
    const para = schema.nodes.paragraph.create(null, [
      schema.text("["),
      schema.text("code", [codeMark]),
      schema.text(" something](https://x.test"),
    ]);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, para));

    // Sanity: code mark is on "code" before the rule runs.
    // Positions: 1=`[`, 2..6=`code`, 6+ =` something]...`
    expect(view.state.doc.rangeHasMark(2, 6, schema.marks.code)).toBe(true);

    // Type `)` at the end of the paragraph — the linkInputRule fires.
    const endPos = view.state.doc.content.size - 1; // inside the paragraph
    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, endPos, endPos, ")", () => view.state.tr),
    );
    expect(handled).toBe(true);

    // Walk the resulting paragraph and dump (text, marks) so a failure shows
    // exactly what the rule produced.
    const result = view.state.doc.firstChild!;
    const segments: Array<{ text: string; marks: string[] }> = [];
    result.descendants((node) => {
      if (node.isText) {
        segments.push({
          text: node.text ?? "",
          marks: node.marks.map((m) => m.type.name).sort(),
        });
      }
    });

    // Expected: a "code" segment with both link+code marks, then " something"
    // with only link.
    const codeSeg = segments.find((s) => s.text === "code");
    expect(
      codeSeg,
      `no "code" segment in ${JSON.stringify(segments)}`,
    ).toBeDefined();
    expect(codeSeg!.marks).toEqual(["code", "link"]);

    conn.close();
  });

  it("`https://x.test<space>` autoformats as an inline link", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Replace "Hello" with "https://x.test" (14 chars, positions 1..15).
    view.dispatch(
      view.state.tr.replaceWith(1, 6, schema.text("https://x.test")),
    );

    // Type space at position 15 (right after the URL).
    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 15, 15, " ", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const para = view.state.doc.firstChild!;
    expect(para.textContent).toBe("https://x.test ");

    const linkType = schema.marks.link;
    expect(view.state.doc.rangeHasMark(1, 15, linkType)).toBe(true);
    // Trailing space must NOT carry the link mark.
    expect(view.state.doc.rangeHasMark(15, 16, linkType)).toBe(false);

    let href: string | null = null;
    para.descendants((node) => {
      const lm = node.marks.find((m) => m.type === linkType);
      if (lm) href = lm.attrs.href as string;
    });
    expect(href).toBe("https://x.test");

    conn.close();
  });

  it("strips trailing `.` from autolinked URLs", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // "https://x.test." (15 chars, positions 1..16).
    view.dispatch(
      view.state.tr.replaceWith(1, 6, schema.text("https://x.test.")),
    );

    // Type space at position 16 (right after the period).
    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 16, 16, " ", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const linkType = schema.marks.link;
    // Link covers "https://x.test" (positions 1..15) — period excluded.
    expect(view.state.doc.rangeHasMark(1, 15, linkType)).toBe(true);
    expect(view.state.doc.rangeHasMark(15, 16, linkType)).toBe(false);

    let href: string | null = null;
    view.state.doc.firstChild!.descendants((node) => {
      const lm = node.marks.find((m) => m.type === linkType);
      if (lm) href = lm.attrs.href as string;
    });
    expect(href).toBe("https://x.test");

    conn.close();
  });

  it("autolink does not re-mark a URL already inside a link", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Build a paragraph where the visible text is "https://x.test" but
    // the link's href points elsewhere — the autolink rule should not
    // replace the user's intentional href.
    const linkMark = schema.marks.link.create({ href: "https://elsewhere.test" });
    const para = schema.nodes.paragraph.create(null, [
      schema.text("https://x.test", [linkMark]),
    ]);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, para));

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 15, 15, " ", () => view.state.tr),
    );
    // Either the rule reports unhandled, or it fires but leaves the
    // existing href intact. Asserting the href is what matters.
    void handled;

    let href: string | null = null;
    view.state.doc.firstChild!.descendants((node) => {
      const lm = node.marks.find((m) => m.type === schema.marks.link);
      if (lm) href = lm.attrs.href as string;
    });
    expect(href).toBe("https://elsewhere.test");

    conn.close();
  });

  it("the strong rule does not fire mid-word (no leading whitespace before `**`)", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // `foo**bar*` — typing `*` would otherwise complete `**bar**` adjacent
    // to `foo`, but the `(?:^|\s)` anchor prevents that.
    view.dispatch(view.state.tr.replaceWith(1, 6, schema.text("foo**bar*")));

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 10, 10, "*", () => view.state.tr),
    );
    // Rule should NOT fire — `someProp` returns the first truthy handler
    // result, so neither `false` nor `undefined` indicates a fired rule.
    expect(handled).not.toBe(true);
    // And no strong mark should be present on `bar`.
    expect(view.state.doc.rangeHasMark(1, 9, schema.marks.strong)).toBe(false);

    conn.close();
  });
});

// ─── Test: heading folding ─────────────────────────────────────────────────

describe("heading folding", () => {
  it("folding `## A` hides siblings until the next equal-level heading", async () => {
    const { setHeadingFolded } = await import("../foldHeadings");
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Build: ## A / para1 / ### A.1 / para2 / ## B / para3
    // Folding ## A should hide para1, ### A.1, para2 — but NOT ## B / para3.
    const { schema: s } = await import("../schema");
    const doc = s.nodes.doc.create(null, [
      s.nodes.heading.create({ level: 2 }, s.text("A")),
      s.nodes.paragraph.create(null, s.text("para1")),
      s.nodes.heading.create({ level: 3 }, s.text("A.1")),
      s.nodes.paragraph.create(null, s.text("para2")),
      s.nodes.heading.create({ level: 2 }, s.text("B")),
      s.nodes.paragraph.create(null, s.text("para3")),
    ]);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));

    // Position of `## A` is 0 (first top-level node).
    setHeadingFolded(view, 0, true);

    // After fold: paragraphs/headings between A's end and B's start should
    // be marked with .pm-folded; B's heading and onward should not.
    const editorRoot = view.dom as HTMLElement;
    const folded = Array.from(editorRoot.querySelectorAll(".pm-folded"));
    const foldedTexts = folded.map((n) => (n.textContent ?? "").trim());
    expect(foldedTexts).toContain("para1");
    expect(foldedTexts).toContain("A.1");
    expect(foldedTexts).toContain("para2");
    expect(foldedTexts).not.toContain("B");
    expect(foldedTexts).not.toContain("para3");

    // Unfold and the hide decorations should drop.
    setHeadingFolded(view, 0, false);
    expect(editorRoot.querySelectorAll(".pm-folded").length).toBe(0);

    conn.close();
  });

  // Repro for: with `# h1 / ## a / para_a / ## b / para_b / ## c / para_c`,
  // folding `## a` should hide ONLY para_a — `## b`, `## c` and their paras
  // must stay visible. Reported bug: folding `## a` collapses everything,
  // leaving only `# h1` visible.
  it("folding the first ## under a # hides only its own section", async () => {
    const { setHeadingFolded } = await import("../foldHeadings");
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const { schema: s } = await import("../schema");
    const doc = s.nodes.doc.create(null, [
      s.nodes.heading.create({ level: 1 }, s.text("h1")),
      s.nodes.heading.create({ level: 2 }, s.text("a")),
      s.nodes.paragraph.create(null, s.text("para_a")),
      s.nodes.heading.create({ level: 2 }, s.text("b")),
      s.nodes.paragraph.create(null, s.text("para_b")),
      s.nodes.heading.create({ level: 2 }, s.text("c")),
      s.nodes.paragraph.create(null, s.text("para_c")),
    ]);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));

    // Position of `## a` is the offset right after `# h1`.
    let aPos = -1;
    view.state.doc.forEach((node, offset) => {
      if (
        aPos === -1 &&
        node.type.name === "heading" &&
        node.attrs.level === 2 &&
        node.textContent === "a"
      ) {
        aPos = offset;
      }
    });
    expect(aPos).toBeGreaterThan(0);

    setHeadingFolded(view, aPos, true);

    const editorRoot = view.dom as HTMLElement;
    const foldedTexts = Array.from(
      editorRoot.querySelectorAll(".pm-folded"),
    ).map((n) => (n.textContent ?? "").trim());

    expect(foldedTexts).toContain("para_a");
    // The bug: these get folded too. They MUST remain visible.
    expect(foldedTexts).not.toContain("b");
    expect(foldedTexts).not.toContain("para_b");
    expect(foldedTexts).not.toContain("c");
    expect(foldedTexts).not.toContain("para_c");

    conn.close();
  });

  it("renders a chevron widget on every heading", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const { schema: s } = await import("../schema");
    const doc = s.nodes.doc.create(null, [
      s.nodes.heading.create({ level: 1 }, s.text("One")),
      s.nodes.heading.create({ level: 2 }, s.text("Two")),
    ]);
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));

    const editorRoot = view.dom as HTMLElement;
    const chevrons = editorRoot.querySelectorAll(".pm-fold-toggle");
    expect(chevrons.length).toBe(2);

    conn.close();
  });
});

// ─── Test: schema fix — code mark non-inclusive ─────────────────────────────

describe("code mark inclusiveness", () => {
  it("typing at the boundary of an existing code span does NOT extend the mark", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Replace "Hello" with a code-marked "Hi" — paragraph content positions 1..3.
    const codeMark = schema.marks.code.create();
    view.dispatch(
      view.state.tr.replaceWith(1, 6, schema.text("Hi", [codeMark])),
    );
    expect(view.state.doc.rangeHasMark(1, 3, schema.marks.code)).toBe(true);

    // Cursor sits right after the code span; insert plain text.
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)),
    );
    view.dispatch(view.state.tr.insertText("X", 3));

    // The newly typed "X" must NOT carry the code mark.
    expect(view.state.doc.rangeHasMark(3, 4, schema.marks.code)).toBe(false);

    conn.close();
  });
});

// ─── Test: task list ───────────────────────────────────────────────────────

describe("task list", () => {
  // Setup used by all task-list rule tests: replace the bootstrap doc with
  // a single-item bullet_list whose item's paragraph already contains
  // `[ ]` or `[x]`. The trailing space is then typed via handleTextInput
  // so the input rule fires.
  function setUpBulletWithMarker(view: EditorView, marker: "[ ]" | "[x]") {
    const para = schema.nodes.paragraph.create(null, schema.text(marker));
    const item = schema.nodes.list_item.create(null, para);
    const bullet = schema.nodes.bullet_list.create(null, item);
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, bullet),
    );
    // Cursor inside the paragraph, at the end of the marker (just before
    // the trailing space we're about to type).
    let pos = -1;
    view.state.doc.descendants((node: PMNode, p: number) => {
      if (pos === -1 && node.isText) pos = p + node.nodeSize;
    });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)),
    );
    return pos;
  }

  it("inside an empty `- ` item, typing `[ ] ` converts the list to a task_list", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const pos = setUpBulletWithMarker(view, "[ ]");

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, pos, pos, " ", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const top = view.state.doc.firstChild!;
    expect(top.type.name).toBe("task_list");
    expect(top.childCount).toBe(1);
    expect(top.firstChild!.type.name).toBe("task_item");
    expect(top.firstChild!.attrs.checked).toBe(false);
    // The new task_item's paragraph is empty.
    expect(top.firstChild!.firstChild!.content.size).toBe(0);

    conn.close();
  });

  it("`[x] ` produces a checked task_item via the same flow", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const pos = setUpBulletWithMarker(view, "[x]");

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, pos, pos, " ", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const top = view.state.doc.firstChild!;
    expect(top.type.name).toBe("task_list");
    expect(top.firstChild!.attrs.checked).toBe(true);

    conn.close();
  });

  it("preserves trailing bullet content when prefixing with `[ ] `", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Existing bullet `- fix branch`, with the user having moved their
    // cursor to the start of the line and typed `[ ]`. They are now
    // about to type the trailing space which fires the rule.
    const para = schema.nodes.paragraph.create(
      null,
      schema.text("[ ]fix branch"),
    );
    const bullet = schema.nodes.bullet_list.create(
      null,
      schema.nodes.list_item.create(null, para),
    );
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, bullet),
    );
    // Cursor between `]` and `f`, i.e. parentOffset 3.
    let pos = -1;
    view.state.doc.descendants((node: PMNode, p: number) => {
      if (pos === -1 && node.isText) pos = p + 3;
    });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)),
    );

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, pos, pos, " ", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const top = view.state.doc.firstChild!;
    expect(top.type.name).toBe("task_list");
    expect(top.childCount).toBe(1);
    const item = top.firstChild!;
    expect(item.type.name).toBe("task_item");
    expect(item.attrs.checked).toBe(false);
    // The trailing content survives the conversion.
    expect(item.firstChild!.textContent).toBe("fix branch");
    // Cursor at the start of the preserved content.
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(view.state.selection.$from.parentOffset).toBe(0);

    conn.close();
  });

  // Negative paths — the new rule is intentionally narrow.

  it("does NOT fire in a plain paragraph (no surrounding bullet_list)", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    view.dispatch(view.state.tr.replaceWith(1, 6, schema.text("[ ]")));

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 4, 4, " ", () => view.state.tr),
    );
    expect(handled).not.toBe(true);
    expect(view.state.doc.firstChild!.type.name).toBe("paragraph");

    conn.close();
  });

  it("does NOT fire when the bullet_list has more than one item", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const bullet = schema.nodes.bullet_list.create(null, [
      schema.nodes.list_item.create(
        null,
        schema.nodes.paragraph.create(null, schema.text("a")),
      ),
      schema.nodes.list_item.create(
        null,
        schema.nodes.paragraph.create(null, schema.text("[ ]")),
      ),
    ]);
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, bullet),
    );
    // Place cursor at end of the second item's "[ ]" text.
    let pos = -1;
    view.state.doc.descendants((node, p) => {
      if (node.isText && node.text === "[ ]") pos = p + node.nodeSize;
    });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)),
    );

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, pos, pos, " ", () => view.state.tr),
    );
    expect(handled).not.toBe(true);
    expect(view.state.doc.firstChild!.type.name).toBe("bullet_list");
    expect(view.state.doc.firstChild!.childCount).toBe(2);

    conn.close();
  });

  it("does NOT fire when the bullet item has other content alongside the marker", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // `- foo[ ]` — typing the trailing space here must NOT collapse the
    // line into a task_item; the rule only fires on a *clean* `[ ]`.
    const para = schema.nodes.paragraph.create(null, schema.text("foo[ ]"));
    const bullet = schema.nodes.bullet_list.create(
      null,
      schema.nodes.list_item.create(null, para),
    );
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, bullet),
    );
    let pos = -1;
    view.state.doc.descendants((node, p) => {
      if (node.isText) pos = p + node.nodeSize;
    });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)),
    );

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, pos, pos, " ", () => view.state.tr),
    );
    expect(handled).not.toBe(true);
    expect(view.state.doc.firstChild!.type.name).toBe("bullet_list");

    conn.close();
  });

  it("Enter inside a task_item splits to a fresh unchecked item", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Replace the bootstrap "Hello" paragraph with a task_list containing
    // a single CHECKED task_item — sets up the case where the new item
    // must NOT inherit the parent's checked state.
    const taskList = schema.nodes.task_list.create(
      null,
      schema.nodes.task_item.create(
        { checked: true },
        schema.nodes.paragraph.create(null, schema.text("first")),
      ),
    );
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, taskList),
    );

    // Place the cursor at the end of "first" inside the paragraph.
    // Resolve a position inside the textblock and ask for its `.end()`.
    const $inside = view.state.doc.resolve(4);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, $inside.end()),
      ),
    );

    const evt = new KeyboardEvent("keydown", { key: "Enter" });
    const handled = view.someProp("handleKeyDown", (fn) => fn(view, evt));
    expect(handled).toBe(true);

    const list = view.state.doc.firstChild!;
    expect(list.type.name).toBe("task_list");
    expect(list.childCount).toBe(2);
    expect(list.child(0).attrs.checked).toBe(true);
    expect(list.child(1).attrs.checked).toBe(false);

    conn.close();
  });
});

// ─── Test: Enter exits a trailing code_block ───────────────────────────────

describe("Enter inside a code_block at end of doc", () => {
  it("strips the trailing newline and appends a paragraph on the second Enter", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Doc with only a code_block whose content is "x\n" (i.e. the user has
    // already pressed Enter once, leaving an empty trailing line).
    const codeBlock = schema.nodes.code_block.create(
      null,
      schema.text("x\n"),
    );
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, codeBlock),
    );

    // Cursor at end of the code_block.
    const endOfBlock = view.state.doc.resolve(view.state.doc.content.size - 1);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, endOfBlock.pos),
      ),
    );

    const evt = new KeyboardEvent("keydown", { key: "Enter" });
    const handled = view.someProp("handleKeyDown", (fn) => fn(view, evt));
    expect(handled).toBe(true);

    // Expected doc shape: code_block("x") + empty paragraph.
    const doc = view.state.doc;
    expect(doc.childCount).toBe(2);
    expect(doc.firstChild!.type.name).toBe("code_block");
    expect(doc.firstChild!.textContent).toBe("x");
    expect(doc.lastChild!.type.name).toBe("paragraph");
    expect(doc.lastChild!.content.size).toBe(0);
    // Cursor lives inside the new paragraph.
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");

    conn.close();
  });

  it("does not fire mid-doc (something follows the code_block)", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // code_block("x\n") followed by a paragraph — block is NOT last in doc.
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, [
      schema.nodes.code_block.create(null, schema.text("x\n")),
      schema.nodes.paragraph.create(null, schema.text("after")),
    ]);
    view.dispatch(tr);

    // Place cursor at end of the code_block (inside it).
    let endOfCode = -1;
    view.state.doc.descendants((node, pos) => {
      if (
        endOfCode === -1 &&
        node.type === schema.nodes.code_block
      ) {
        endOfCode = pos + 1 + node.content.size;
      }
    });
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, endOfCode),
      ),
    );

    // Snapshot the doc structure before pressing Enter so we can compare.
    const before = view.state.doc.toJSON();
    const evt = new KeyboardEvent("keydown", { key: "Enter" });
    view.someProp("handleKeyDown", (fn) => fn(view, evt));
    // The exit-code-block command must not have fired — but baseKeymap's
    // default code_block Enter handler may insert another \n. Either way,
    // the doc must NOT have grown by an extra paragraph at the end.
    const after = view.state.doc;
    expect(after.lastChild!.type.name).toBe("paragraph");
    expect(after.lastChild!.textContent).toBe("after");
    // Top-level child count is unchanged (still code_block + paragraph).
    expect(after.childCount).toBe(before.content!.length);

    conn.close();
  });

  it("does not fire when the previous char is not a newline (single Enter)", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Code block ends with "x" — no trailing newline. The user pressing
    // Enter here should just insert a newline, not exit the block.
    const codeBlock = schema.nodes.code_block.create(null, schema.text("x"));
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, codeBlock),
    );
    const cursor = view.state.doc.content.size - 1;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, cursor)),
    );

    const before = view.state.doc.toJSON();
    const evt = new KeyboardEvent("keydown", { key: "Enter" });
    view.someProp("handleKeyDown", (fn) => fn(view, evt));
    // Doc still has exactly one child (no paragraph appended).
    expect(view.state.doc.childCount).toBe(before.content!.length);
    expect(view.state.doc.firstChild!.type.name).toBe("code_block");

    conn.close();
  });
});

// ─── Test: Tab / Shift-Tab indent in lists ──────────────────────────────────

describe("Tab indent in lists", () => {
  it("Tab inside the second `- ` item nests it under the first", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Build: bullet_list with two top-level items "a" and "b".
    const bullet = schema.nodes.bullet_list.create(null, [
      schema.nodes.list_item.create(
        null,
        schema.nodes.paragraph.create(null, schema.text("a")),
      ),
      schema.nodes.list_item.create(
        null,
        schema.nodes.paragraph.create(null, schema.text("b")),
      ),
    ]);
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, bullet),
    );

    // Cursor inside the second item's "b" text node. Walk to find it so
    // we don't depend on a hard-coded offset.
    let bPos = -1;
    view.state.doc.descendants((node, pos) => {
      if (bPos === -1 && node.isText && node.text === "b") bPos = pos + 1;
    });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, bPos)),
    );

    const evt = new KeyboardEvent("keydown", { key: "Tab" });
    const handled = view.someProp("handleKeyDown", (fn) => fn(view, evt));
    expect(handled).toBe(true);

    // After sink: top-level list has one item "a" containing a nested
    // bullet_list whose only item is "b".
    const list = view.state.doc.firstChild!;
    expect(list.type.name).toBe("bullet_list");
    expect(list.childCount).toBe(1);
    const onlyItem = list.firstChild!;
    expect(onlyItem.type.name).toBe("list_item");
    // Nested structure: list_item → paragraph("a") + bullet_list → list_item("b")
    expect(onlyItem.childCount).toBe(2);
    expect(onlyItem.child(1).type.name).toBe("bullet_list");
    expect(onlyItem.child(1).firstChild!.textContent).toBe("b");

    conn.close();
  });

  it("Tab inside the second `[ ] ` item nests it under the first", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const taskList = schema.nodes.task_list.create(null, [
      schema.nodes.task_item.create(
        null,
        schema.nodes.paragraph.create(null, schema.text("a")),
      ),
      schema.nodes.task_item.create(
        null,
        schema.nodes.paragraph.create(null, schema.text("b")),
      ),
    ]);
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, taskList),
    );

    let bPos = -1;
    view.state.doc.descendants((node, pos) => {
      if (bPos === -1 && node.isText && node.text === "b") bPos = pos + 1;
    });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, bPos)),
    );

    const evt = new KeyboardEvent("keydown", { key: "Tab" });
    const handled = view.someProp("handleKeyDown", (fn) => fn(view, evt));
    expect(handled).toBe(true);

    const list = view.state.doc.firstChild!;
    expect(list.type.name).toBe("task_list");
    expect(list.childCount).toBe(1);
    const onlyItem = list.firstChild!;
    expect(onlyItem.child(1).type.name).toBe("task_list");
    expect(onlyItem.child(1).firstChild!.textContent).toBe("b");

    conn.close();
  });

  // Regression: when sinkListItem can't make progress (e.g. the cursor is on
  // the only item in its list, so there's no preceding sibling to nest
  // under), Tab must still be swallowed so focus doesn't leak to the next
  // element on the page.
  it("Tab on the only item in a list is still consumed (no focus shift)", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const bullet = schema.nodes.bullet_list.create(
      null,
      schema.nodes.list_item.create(
        null,
        schema.nodes.paragraph.create(null, schema.text("only")),
      ),
    );
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, bullet),
    );

    let pos = -1;
    view.state.doc.descendants((node, p) => {
      if (pos === -1 && node.isText && node.text === "only") pos = p + 1;
    });
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)),
    );

    const evt = new KeyboardEvent("keydown", { key: "Tab" });
    const handled = view.someProp("handleKeyDown", (fn) => fn(view, evt));
    expect(handled).toBe(true);

    // Doc shape unchanged — the inner sinkListItem couldn't make progress.
    const list = view.state.doc.firstChild!;
    expect(list.childCount).toBe(1);
    expect(list.firstChild!.firstChild!.textContent).toBe("only");

    conn.close();
  });

  it("Tab outside any list returns false (lets focus move)", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Bootstrap doc is a plain paragraph "Hello" — cursor is already inside.
    const evt = new KeyboardEvent("keydown", { key: "Tab" });
    const handled = view.someProp("handleKeyDown", (fn) => fn(view, evt));
    expect(handled).not.toBe(true);

    conn.close();
  });

  it("Shift-Tab inside a nested `- ` item lifts it back out", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Build: bullet_list[ list_item("a", bullet_list[ list_item("b") ]) ]
    const inner = schema.nodes.bullet_list.create(
      null,
      schema.nodes.list_item.create(
        null,
        schema.nodes.paragraph.create(null, schema.text("b")),
      ),
    );
    const outerItem = schema.nodes.list_item.create(null, [
      schema.nodes.paragraph.create(null, schema.text("a")),
      inner,
    ]);
    const bullet = schema.nodes.bullet_list.create(null, outerItem);
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, bullet),
    );

    // Find the position inside "b" — walk descendants until we hit it.
    let bPos = -1;
    view.state.doc.descendants((node, pos) => {
      if (bPos === -1 && node.isText && node.text === "b") bPos = pos + 1;
    });
    expect(bPos).toBeGreaterThan(0);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, bPos)),
    );

    const evt = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true });
    const handled = view.someProp("handleKeyDown", (fn) => fn(view, evt));
    expect(handled).toBe(true);

    // After lift: top-level list has two siblings, "a" and "b".
    const list = view.state.doc.firstChild!;
    expect(list.type.name).toBe("bullet_list");
    expect(list.childCount).toBe(2);
    expect(list.child(0).firstChild!.textContent).toBe("a");
    expect(list.child(1).firstChild!.textContent).toBe("b");

    conn.close();
  });
});

// ─── Test: setEditable / view mode ──────────────────────────────────────────

describe("setEditable (view mode)", () => {
  it("flipping editable=false stops typing AND suppresses presence POSTs", async () => {
    const el = makeEl();

    const presenceCalls: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.endsWith("/presence")) {
        presenceCalls.push(opts?.body as string);
        return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ...BOOTSTRAP }),
      });
    });
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    expect(view.editable).toBe(true);

    // Flip to read-only
    conn.setEditable(false);
    expect(view.editable).toBe(false);

    // Move the selection while read-only — would normally trigger a
    // debounced presence POST; the cursor reporter must short-circuit.
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)),
    );
    // Let the 150ms debounce elapse plus a buffer.
    await new Promise((r) => setTimeout(r, 200));
    expect(presenceCalls).toHaveLength(0);

    // Flip back to editable: a fresh selection move should now broadcast.
    conn.setEditable(true);
    expect(view.editable).toBe(true);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 4)),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(presenceCalls.length).toBeGreaterThan(0);

    conn.close();
  });
});

// ─── Test 5: recover() backoff ────────────────────────────────────────────────

describe("recover() backoff", () => {
  it("doubles the backoff on each error, capped at 60_000ms", async () => {
    vi.useFakeTimers();

    const el = makeEl();
    const fetchMock = makeBootstrapFetch();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const conn = new EditorConnection(makeOpts(el));

    // Resolve the async start()
    await vi.runAllTimersAsync();

    // Simulate first error
    conn.backOff = 0;
    conn.recover(new Error("first error"));
    const backoff1 = conn.backOff;
    expect(backoff1).toBe(200);

    // Simulate second error without resetting backOff
    conn.recover(new Error("second error"));
    const backoff2 = conn.backOff;
    expect(backoff2).toBe(400);

    // Continue doubling
    conn.recover(new Error("third error"));
    expect(conn.backOff).toBe(800);

    // Eventually cap at 60_000
    conn.backOff = 40000;
    conn.recover(new Error("big error"));
    expect(conn.backOff).toBe(60000);

    conn.backOff = 60000;
    conn.recover(new Error("already max"));
    expect(conn.backOff).toBe(60000);

    conn.close();
    vi.useRealTimers();
  });
});

// ─── Markdown clipboard parser ────────────────────────────────────────────────

describe("clipboardTextParser markdown paste", () => {
  it("parses markdown text into typed nodes; Shift falls through to plain", async () => {
    const el = makeEl();
    const fetchMock = makeBootstrapFetch();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    await preloadMarkdownParser();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const $context = view.state.doc.resolve(1);

    // someProp returns the parser function's result, or undefined when the
    // function returns null (which is our "fall through" signal).
    const parsed = view.someProp("clipboardTextParser", (f) =>
      f("# Heading\n\n**bold** and *em*", $context, false, view),
    );
    expect(parsed).toBeDefined();
    const heading = parsed!.content.firstChild!;
    expect(heading.type).toBe(schema.nodes.heading);
    expect(heading.attrs.level).toBe(1);
    expect(heading.textContent).toBe("Heading");

    const para = parsed!.content.child(1);
    expect(para.type).toBe(schema.nodes.paragraph);
    // Marks survive the schema round-trip.
    const strong = para.content.firstChild!;
    expect(strong.marks.some((m) => m.type === schema.marks.strong)).toBe(true);

    // Shift-paste (`plain=true`) returns null → ProseMirror falls back to the
    // built-in plain-text parser.
    const shiftParsed = view.someProp("clipboardTextParser", (f) =>
      f("# Heading", $context, true, view),
    );
    expect(shiftParsed).toBeUndefined();

    conn.close();
  });

  // Regression: pasting `[\`code\` something](https://link)` should produce a
  // link whose `code` portion *also* carries the `code` mark, so it renders in
  // monospace inside the link. The bug report: the editor drops the inner
  // `code` mark and renders the whole thing as plain link text.
  it("preserves inline `code` mark inside a link when pasting markdown", async () => {
    const el = makeEl();
    const fetchMock = makeBootstrapFetch();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    await preloadMarkdownParser();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const $context = view.state.doc.resolve(1);

    const parsed = view.someProp("clipboardTextParser", (f) =>
      f("[`code` something](https://link)", $context, false, view),
    );
    expect(parsed).toBeDefined();

    // Walk the slice and gather (text, markTypes) pairs so the assertion
    // failure message shows the actual structure.
    const segments: Array<{ text: string; marks: string[] }> = [];
    parsed!.content.descendants((node) => {
      if (node.isText) {
        segments.push({
          text: node.text ?? "",
          marks: node.marks.map((m) => m.type.name).sort(),
        });
      }
    });

    // The `code` text segment must carry BOTH the link and code marks.
    const codeSeg = segments.find((s) => s.text === "code");
    expect(codeSeg, `no "code" segment in ${JSON.stringify(segments)}`).toBeDefined();
    expect(codeSeg!.marks).toEqual(["code", "link"]);

    // The trailing " something" segment carries only the link mark.
    const tailSeg = segments.find((s) => s.text.includes("something"));
    expect(tailSeg, `no tail segment in ${JSON.stringify(segments)}`).toBeDefined();
    expect(tailSeg!.marks).toEqual(["link"]);

    conn.close();
  });

  // Same input, but actually dispatch the slice into the editor and inspect
  // the rendered DOM. If parsing carries both marks but rendering drops the
  // inner <code>, the bug lives in the schema's DOM toDOM / mark ordering.
  it("renders <a><code>code</code> something</a> after pasting markdown", async () => {
    const el = makeEl();
    const fetchMock = makeBootstrapFetch();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    await preloadMarkdownParser();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const $context = view.state.doc.resolve(1);
    const slice = view.someProp("clipboardTextParser", (f) =>
      f("[`code` something](https://link)", $context, false, view),
    );
    expect(slice).toBeDefined();

    // Replace the entire doc with the parsed slice so the test is independent
    // of where the cursor was.
    const tr = view.state.tr.replace(0, view.state.doc.content.size, slice!);
    view.dispatch(tr);

    const html = view.dom.innerHTML;
    expect(
      html,
      `expected anchor wrapping <code>code</code>, got: ${html}`,
    ).toContain('<code>code</code>');
    expect(html).toMatch(/<a [^>]*href="https:\/\/link"[^>]*>/);

    conn.close();
  });
});

// ─── Test: transformPasted linkifies bare URLs ──────────────────────────────

describe("transformPasted linkify", () => {
  it("a bare URL in pasted text picks up a link mark", async () => {
    const { Slice } = await import("prosemirror-model");
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Build a slice: one paragraph "see https://example.test for more".
    const para = schema.nodes.paragraph.create(null, [
      schema.text("see https://example.test for more"),
    ]);
    const slice = new Slice(para.content, 0, 0);

    const result = view.someProp("transformPasted", (f) => f(slice, view, false));
    expect(result).toBeDefined();
    const transformed = result as InstanceType<typeof Slice>;

    const segments: Array<{ text: string; marks: string[] }> = [];
    transformed.content.descendants((node) => {
      if (node.isText) {
        segments.push({
          text: node.text ?? "",
          marks: node.marks.map((m) => m.type.name).sort(),
        });
      }
    });

    const linkSeg = segments.find((s) => s.text === "https://example.test");
    expect(linkSeg, `no URL segment in ${JSON.stringify(segments)}`).toBeDefined();
    expect(linkSeg!.marks).toEqual(["link"]);
    // Surrounding plain text segments stay unmarked.
    expect(segments.find((s) => s.text === "see ")?.marks).toEqual([]);
    expect(segments.find((s) => s.text === " for more")?.marks).toEqual([]);

    conn.close();
  });

  it("strips trailing punctuation from pasted URLs", async () => {
    const { Slice } = await import("prosemirror-model");
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const para = schema.nodes.paragraph.create(null, [
      schema.text("end https://example.test."),
    ]);
    const slice = new Slice(para.content, 0, 0);

    const result = view.someProp("transformPasted", (f) => f(slice, view, false));
    const transformed = result as InstanceType<typeof Slice>;

    const segments: Array<{ text: string; marks: string[] }> = [];
    transformed.content.descendants((node) => {
      if (node.isText) {
        segments.push({
          text: node.text ?? "",
          marks: node.marks.map((m) => m.type.name).sort(),
        });
      }
    });

    expect(segments.find((s) => s.text === "https://example.test")?.marks).toEqual(["link"]);
    // The trailing "." sits in its own unmarked segment.
    expect(segments.find((s) => s.text === ".")?.marks).toEqual([]);

    conn.close();
  });

  it("leaves text alone if it already carries a link mark", async () => {
    const { Slice } = await import("prosemirror-model");
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // User pasted markdown `[https://example.test](https://elsewhere.test)`
    // — text matches a URL pattern but already has a link mark with a
    // different href. Don't clobber it.
    const linkMark = schema.marks.link.create({ href: "https://elsewhere.test" });
    const para = schema.nodes.paragraph.create(null, [
      schema.text("https://example.test", [linkMark]),
    ]);
    const slice = new Slice(para.content, 0, 0);

    const result = view.someProp("transformPasted", (f) => f(slice, view, false));
    const transformed = result as InstanceType<typeof Slice>;

    let href: string | null = null;
    transformed.content.descendants((node) => {
      const lm = node.marks.find((m) => m.type === schema.marks.link);
      if (lm) href = lm.attrs.href as string;
    });
    expect(href).toBe("https://elsewhere.test");

    conn.close();
  });

  it("recurses into nested block content (URL inside a list item)", async () => {
    const { Slice } = await import("prosemirror-model");
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    const para = schema.nodes.paragraph.create(null, [
      schema.text("visit https://nested.test"),
    ]);
    const item = schema.nodes.list_item.create(null, [para]);
    const list = schema.nodes.bullet_list.create(null, [item]);
    const slice = new Slice(list.content, 0, 0);

    const result = view.someProp("transformPasted", (f) => f(slice, view, false));
    const transformed = result as InstanceType<typeof Slice>;

    let foundLinked = false;
    transformed.content.descendants((node) => {
      if (
        node.isText &&
        node.text === "https://nested.test" &&
        node.marks.some((m) => m.type === schema.marks.link)
      ) {
        foundLinked = true;
      }
    });
    expect(foundLinked).toBe(true);

    conn.close();
  });
});

// ─── Step-apply error handling (bootstrap + SSE) ────────────────────────────
//
// Real-world cause: a client (or rebase) generated a `replace` step with
// `slice.openStart=0`/`openEnd=0` whose `from` resolved inside a non-textblock
// parent (a `list_item` before its paragraph child). `Step.apply` only catches
// `ReplaceError`, but `Node.checkContent` throws `RangeError` on a content-
// spec violation, so the throw escaped the bootstrap loop and the whole doc
// failed to mount.
//
// The minimal repro: doc `bullet_list > list_item > paragraph("a")`, then a
// `replace` step that inserts bare text at position 2 (inside the list_item,
// before its paragraph). The resulting list_item content would be
// `<text("x"), paragraph("a")>` which violates list_item's `paragraph block*`
// spec.

const BAD_STEP_BOOT = {
  doc: {
    type: "doc",
    content: [
      {
        type: "bullet_list",
        content: [
          {
            type: "list_item",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "a" }] },
            ],
          },
        ],
      },
    ],
  },
  version: 1,
  snapshotVersion: 0,
  steps: [
    {
      stepType: "replace",
      from: 2,
      to: 2,
      slice: { content: [{ type: "text", text: "x" }] },
    },
  ],
  clientIDs: [62970755],
  users: 1,
  permissions: {
    canView: true,
    canEdit: true,
    canManage: false,
    isOwner: false,
    visibility: "private" as const,
  },
};

describe("step-apply error handling", () => {
  it("bootstrap: minimal repro — bad step does not throw, renders snapshot doc, fires onStepError, locks read-only", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => BAD_STEP_BOOT,
      });

    // Capture unhandled rejections / errors so we can fail the test if the
    // bootstrap throws instead of recovering. vitest surfaces these via
    // process events under jsdom.
    const unhandled: unknown[] = [];
    const onErr = (e: Event) => unhandled.push(e);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onErr);

    const errors: StepApplyError[] = [];
    const conn = new EditorConnection({
      docId: "test-doc",
      place: el,
      onStepError: (e) => errors.push(e),
    });

    await waitFor(() => expect(conn.view).not.toBeNull());

    // Editor mounted with the snapshot doc — the bad step at version 1
    // was skipped, no later steps to attempt.
    expect(conn.view!.state.doc.toJSON()).toEqual(BAD_STEP_BOOT.doc);

    // The error callback was called exactly once for the bad step.
    expect(errors).toHaveLength(1);
    expect(errors[0].phase).toBe("bootstrap");
    expect(errors[0].version).toBe(1);
    expect(errors[0].message).toMatch(/list_item/i);

    // The view is forced read-only — even though the bootstrap permissions
    // grant canEdit, editing forward from a partial doc would corrupt sync.
    expect(conn.view!.props.editable?.(conn.view!.state)).toBe(false);

    // setEditable(true) cannot re-enable the editor while stepError is set.
    conn.setEditable(true);
    expect(conn.view!.props.editable?.(conn.view!.state)).toBe(false);

    expect(unhandled).toEqual([]);

    window.removeEventListener("error", onErr);
    window.removeEventListener("unhandledrejection", onErr);
    conn.close();
  });

  it("bootstrap: applies steps before the bad one, stops at the first failure", async () => {
    // Three valid inserts before the bad one. They each prepend a char to
    // the paragraph: "a" → "ba" → "cba" → "dcba", *then* the bad step tries
    // to inject bare text inside the list_item.
    const boot = {
      ...BAD_STEP_BOOT,
      version: 4,
      snapshotVersion: 0,
      steps: [
        {
          stepType: "replace",
          from: 3,
          to: 3,
          slice: { content: [{ type: "text", text: "b" }] },
        },
        {
          stepType: "replace",
          from: 3,
          to: 3,
          slice: { content: [{ type: "text", text: "c" }] },
        },
        {
          stepType: "replace",
          from: 3,
          to: 3,
          slice: { content: [{ type: "text", text: "d" }] },
        },
        // Bad step — same shape as the minimal repro.
        {
          stepType: "replace",
          from: 2,
          to: 2,
          slice: { content: [{ type: "text", text: "x" }] },
        },
      ],
      clientIDs: [62970755, 62970755, 62970755, 62970755],
    };

    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => boot });

    const errors: StepApplyError[] = [];
    const conn = new EditorConnection({
      docId: "test-doc",
      place: el,
      onStepError: (e) => errors.push(e),
    });

    await waitFor(() => expect(conn.view).not.toBeNull());

    // The 3 valid steps applied; paragraph reads "dcba".
    const para = conn.view!.state.doc
      .firstChild!.firstChild!.firstChild!;
    expect(para.type.name).toBe("paragraph");
    expect(para.textContent).toBe("dcba");

    expect(errors).toHaveLength(1);
    expect(errors[0].version).toBe(4);
    expect(errors[0].phase).toBe("bootstrap");

    conn.close();
  });

  it("bootstrap: happy path — no onStepError fires for a fully valid history", async () => {
    const el = makeEl();
    const fetchMock = makeBootstrapFetch();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const errors: StepApplyError[] = [];
    const conn = new EditorConnection({
      docId: "test-doc",
      place: el,
      onStepError: (e) => errors.push(e),
    });

    await waitFor(() => expect(conn.view).not.toBeNull());
    expect(errors).toEqual([]);
    // Confirm editor is editable (no stepError → caller's setEditable wins).
    expect(conn.view!.props.editable?.(conn.view!.state)).toBe(true);

    conn.close();
  });

  it("SSE: bad remote step does not crash the connection, fires onStepError, stays subscribed", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const errors: StepApplyError[] = [];
    const conn = new EditorConnection({
      docId: "test-doc",
      place: el,
      onStepError: (e) => errors.push(e),
    });

    await waitFor(() => expect(conn.view).not.toBeNull());
    expect(errors).toEqual([]);

    // The bootstrap fixture has a `paragraph("Hello")` as the only block.
    // Position 1 is inside that paragraph. To trigger a content-spec
    // violation via SSE, send a step that wraps the doc in a list_item
    // without a paragraph child — straight bare text as list_item content.
    // Construct that by replacing the whole doc with a slice that produces
    // an invalid list_item structure.
    const es = MockEventSource.instances[0];
    expect(es).toBeDefined();

    // Use the same minimal-repro shape: pretend the server has just promoted
    // the paragraph to a bullet_list/list_item and is now broadcasting a
    // bare-text insert into the list_item. The receiveTransaction call must
    // not throw out of the SSE handler.
    es.dispatchEvent(
      "update",
      JSON.stringify({
        version: BOOTSTRAP.version + 1,
        // A step that's syntactically valid but would produce invalid
        // content: insert a text node at position 0 (the doc level), which
        // violates doc's `block+` content spec.
        steps: [
          {
            stepType: "replace",
            from: 0,
            to: 0,
            slice: { content: [{ type: "text", text: "x" }] },
          },
        ],
        clientIDs: [99999],
      }),
    );

    // The handler captured the error rather than letting it escape.
    expect(errors).toHaveLength(1);
    expect(errors[0].phase).toBe("sse");
    expect(errors[0].version).toBe(BOOTSTRAP.version + 1);

    // EventSource is still open — we only `close()` on explicit teardown.
    expect(es.readyState).not.toBe(2);

    conn.close();
  });

  it("send: 422 from /events fires onStepError with phase=send and locks read-only", async () => {
    const el = makeEl();

    // Bootstrap is happy; the 422 only fires on the subsequent POST /events.
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ...BOOTSTRAP }),
      }))
      // Second fetch (POST /events) returns 422.
      .mockImplementationOnce(async () => ({
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        json: async () => ({
          error: "invalid_step",
          step_index: 0,
          message: "Invalid content for node list_item",
        }),
      }));
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const errors: StepApplyError[] = [];
    const conn = new EditorConnection({
      docId: "test-doc",
      place: el,
      onStepError: (e) => errors.push(e),
    });

    await waitFor(() => expect(conn.view).not.toBeNull());

    // Drive a local edit so the connection sends to /events.
    const view = conn.view!;
    const tr = view.state.tr.insertText("X", 1);
    view.dispatch(tr);

    // Wait for the 422 to land and the stepError callback to fire.
    await waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0].phase).toBe("send");
    expect(errors[0].message).toMatch(/Invalid content/i);

    // Editor is now locked read-only — the local doc is ahead of what the
    // server accepted, so further edits would diverge further.
    expect(conn.view!.props.editable?.(conn.view!.state)).toBe(false);

    conn.close();
  });

  it("SSE: stops applying further step batches after bootstrap stepError", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => BAD_STEP_BOOT,
      });

    const errors: StepApplyError[] = [];
    const conn = new EditorConnection({
      docId: "test-doc",
      place: el,
      onStepError: (e) => errors.push(e),
    });

    await waitFor(() => expect(conn.view).not.toBeNull());
    expect(errors).toHaveLength(1);

    // After the bootstrap stepError, the local doc no longer reflects the
    // server's version. A "valid-looking" SSE update would still build
    // positions against the partial doc. Skip it entirely and don't surface
    // another error (the bootstrap error already told the user).
    const errorsAtBoot = errors.length;
    const docBefore = conn.view!.state.doc.toJSON();

    const es = MockEventSource.instances[0];
    es.dispatchEvent(
      "update",
      JSON.stringify({
        version: 2,
        steps: [
          {
            stepType: "replace",
            from: 3,
            to: 3,
            slice: { content: [{ type: "text", text: "y" }] },
          },
        ],
        clientIDs: [62970755],
      }),
    );

    // Doc unchanged.
    expect(conn.view!.state.doc.toJSON()).toEqual(docBefore);
    // No new error reported — bootstrap one is sufficient.
    expect(errors.length).toBe(errorsAtBoot);

    conn.close();
  });
});

// ─── Auto-snapshot ──────────────────────────────────────────────────────────
//
// The server's hydration cost scales with the number of steps replayed
// since the last snapshot. Without an auto-snapshot trigger every cold
// load and every new browser tab pays the cost of replaying the full
// history. Wire the snapshot to fire after `SNAPSHOT_STEP_THRESHOLD`
// steps drift, debounced by `SNAPSHOT_DEBOUNCE_MS` so a typing burst
// produces one snapshot, not a hundred.

describe("auto-snapshot", () => {
  // Capture every URL+body pair so the threshold/debounce assertions can
  // count exactly how many /snapshot POSTs fired. The default
  // bootstrap fetch returns the BOOTSTRAP fixture.
  function makeSnapshotFetch() {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      if (url.endsWith("/snapshot")) {
        return Promise.resolve({ ok: true, status: 204, json: async () => null });
      }
      // The bootstrap GET and any /events POST: treat as a happy bootstrap.
      // Tests in this block don't drive /events sends; they synthesize step
      // batches via SSE which doesn't hit fetch.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ...BOOTSTRAP }),
      });
    });
    return { fetchMock, calls };
  }

  /**
   * Dispatch `n` synthetic "received from server" step batches by feeding
   * the SSE handler. Each batch advances the collab plugin's version by
   * one — same effect on `getVersion` as a real broadcast. Uses an
   * always-insert-at-1 step so the steps actually apply against the
   * bootstrap fixture (paragraph("Hello")).
   */
  function feedSseSteps(
    es: MockEventSource,
    fromVersion: number,
    n: number,
  ): void {
    for (let i = 0; i < n; i++) {
      es.dispatchEvent(
        "update",
        JSON.stringify({
          version: fromVersion + i + 1,
          steps: [
            {
              stepType: "replace",
              from: 1,
              to: 1,
              slice: { content: [{ type: "text", text: "." }] },
            },
          ],
          clientIDs: [99999],
        }),
      );
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires one /snapshot after 100 steps + debounce window", async () => {
    const el = makeEl();
    const { fetchMock, calls } = makeSnapshotFetch();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const conn = new EditorConnection(makeOpts(el));
    await vi.waitFor(() => expect(conn.view).not.toBeNull(), { timeout: 1000 });

    feedSseSteps(MockEventSource.instances[0], BOOTSTRAP.version, 100);
    // Threshold met. Nothing fires until the debounce window elapses.
    expect(
      calls.filter((c) => c.url.endsWith("/snapshot")),
    ).toHaveLength(0);

    vi.advanceTimersByTime(5000);
    await vi.waitFor(() =>
      expect(
        calls.filter((c) => c.url.endsWith("/snapshot")),
      ).toHaveLength(1),
    );

    const snap = calls.find((c) => c.url.endsWith("/snapshot"))!;
    const body = snap.body as { version: number; doc: unknown };
    expect(body.version).toBe(BOOTSTRAP.version + 100);
    expect(body.doc).toBeDefined();

    conn.close();
  });

  it("debounces: 100 steps + 50 more before the timer fires → one /snapshot at the later version", async () => {
    const el = makeEl();
    const { fetchMock, calls } = makeSnapshotFetch();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const conn = new EditorConnection(makeOpts(el));
    await vi.waitFor(() => expect(conn.view).not.toBeNull(), { timeout: 1000 });

    feedSseSteps(MockEventSource.instances[0], BOOTSTRAP.version, 100);
    // Halfway through the debounce window, another burst arrives.
    vi.advanceTimersByTime(2000);
    feedSseSteps(MockEventSource.instances[0], BOOTSTRAP.version + 100, 50);

    vi.advanceTimersByTime(5000);
    await vi.waitFor(() =>
      expect(
        calls.filter((c) => c.url.endsWith("/snapshot")),
      ).toHaveLength(1),
    );

    const snap = calls.find((c) => c.url.endsWith("/snapshot"))!;
    expect((snap.body as { version: number }).version).toBe(
      BOOTSTRAP.version + 150,
    );

    conn.close();
  });

  it("does not fire below the threshold", async () => {
    const el = makeEl();
    const { fetchMock, calls } = makeSnapshotFetch();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const conn = new EditorConnection(makeOpts(el));
    await vi.waitFor(() => expect(conn.view).not.toBeNull(), { timeout: 1000 });

    feedSseSteps(MockEventSource.instances[0], BOOTSTRAP.version, 50);
    vi.advanceTimersByTime(10_000);

    expect(
      calls.filter((c) => c.url.endsWith("/snapshot")),
    ).toHaveLength(0);

    conn.close();
  });

  it("cancels the pending snapshot on close()", async () => {
    const el = makeEl();
    const { fetchMock, calls } = makeSnapshotFetch();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const conn = new EditorConnection(makeOpts(el));
    await vi.waitFor(() => expect(conn.view).not.toBeNull(), { timeout: 1000 });

    feedSseSteps(MockEventSource.instances[0], BOOTSTRAP.version, 100);
    // Pending timer scheduled but not fired.
    vi.advanceTimersByTime(2000);
    conn.close();
    vi.advanceTimersByTime(10_000);

    expect(
      calls.filter((c) => c.url.endsWith("/snapshot")),
    ).toHaveLength(0);
  });

  it("re-arms after a successful snapshot: another 100 steps fires another snapshot", async () => {
    const el = makeEl();
    const { fetchMock, calls } = makeSnapshotFetch();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const conn = new EditorConnection(makeOpts(el));
    await vi.waitFor(() => expect(conn.view).not.toBeNull(), { timeout: 1000 });

    feedSseSteps(MockEventSource.instances[0], BOOTSTRAP.version, 100);
    vi.advanceTimersByTime(5000);
    await vi.waitFor(() =>
      expect(
        calls.filter((c) => c.url.endsWith("/snapshot")),
      ).toHaveLength(1),
    );

    // Drive another 100 steps. The threshold check measures from
    // lastSnapshotVersion, so this should arm a second timer.
    feedSseSteps(MockEventSource.instances[0], BOOTSTRAP.version + 100, 100);
    vi.advanceTimersByTime(5000);
    await vi.waitFor(() =>
      expect(
        calls.filter((c) => c.url.endsWith("/snapshot")),
      ).toHaveLength(2),
    );

    const second = calls.filter((c) => c.url.endsWith("/snapshot"))[1];
    expect((second.body as { version: number }).version).toBe(
      BOOTSTRAP.version + 200,
    );

    conn.close();
  });

  it("does not fire after a step error (editor is locked, doc is desynced)", async () => {
    const el = makeEl();
    const { fetchMock, calls } = makeSnapshotFetch();
    (globalThis as Record<string, unknown>).fetch = fetchMock;

    const conn = new EditorConnection(makeOpts(el));
    await vi.waitFor(() => expect(conn.view).not.toBeNull(), { timeout: 1000 });

    // Trigger an SSE step error (bare-text into doc level).
    MockEventSource.instances[0].dispatchEvent(
      "update",
      JSON.stringify({
        version: BOOTSTRAP.version + 1,
        steps: [
          {
            stepType: "replace",
            from: 0,
            to: 0,
            slice: { content: [{ type: "text", text: "x" }] },
          },
        ],
        clientIDs: [99999],
      }),
    );

    // Even if we somehow continued to receive valid steps after the
    // error, the snapshot scheduler stays off because `stepError` is set.
    feedSseSteps(MockEventSource.instances[0], BOOTSTRAP.version, 100);
    vi.advanceTimersByTime(10_000);

    expect(
      calls.filter((c) => c.url.endsWith("/snapshot")),
    ).toHaveLength(0);

    conn.close();
  });
});
