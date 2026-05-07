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
import { EditorConnection, preloadMarkdownParser } from "../collab";
import type { ConnectionOpts } from "../collab";
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
  it("`[ ] ` input rule wraps the paragraph in a task_list / task_item", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    // Replace "Hello" with "[ ]" so the input rule fires when we type the
    // trailing space.
    view.dispatch(view.state.tr.replaceWith(1, 6, schema.text("[ ]")));

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 4, 4, " ", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const top = view.state.doc.firstChild!;
    expect(top.type.name).toBe("task_list");
    expect(top.firstChild!.type.name).toBe("task_item");
    expect(top.firstChild!.attrs.checked).toBe(false);

    conn.close();
  });

  it("`[x] ` input rule produces a checked task_item", async () => {
    const el = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection(makeOpts(el));
    await waitFor(() => expect(conn.view).not.toBeNull());

    const view = conn.view!;
    view.dispatch(view.state.tr.replaceWith(1, 6, schema.text("[x]")));

    const handled = view.someProp("handleTextInput", (fn) =>
      fn(view, 4, 4, " ", () => view.state.tr),
    );
    expect(handled).toBe(true);

    const top = view.state.doc.firstChild!;
    expect(top.type.name).toBe("task_list");
    expect(top.firstChild!.attrs.checked).toBe(true);

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
