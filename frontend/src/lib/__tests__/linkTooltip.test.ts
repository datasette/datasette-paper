/**
 * Tests for the link-hover tooltip plugin.
 *
 * Drives the plugin through an `EditorConnection` (so the full plugin
 * stack mounts the way it does in production) but interacts directly
 * with the rendered `<a>` element + the tooltip DOM. jsdom doesn't
 * implement `navigator.clipboard`; we stub it where needed.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

import { EditorConnection } from "../collab";
import { schema } from "../schema";

// ─── Mock EventSource ────────────────────────────────────────────────────────

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState: number = 0;
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

  close() {
    this.readyState = 2;
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BOOTSTRAP = {
  doc: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
  },
  version: 0,
  snapshotVersion: 0,
  steps: [] as unknown[],
  clientIDs: [] as unknown[],
  users: 1,
};

function makeBootstrapFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ...BOOTSTRAP }),
  });
}

function makeEl(): HTMLElement {
  // The link tooltip anchors to `view.dom.parentElement`. Mirror the
  // production layout where EditorConnection mounts its EditorView
  // inside an `.editor-host` div.
  const host = document.createElement("div");
  host.className = "editor-host";
  document.body.appendChild(host);
  return host;
}

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Replace the whole bootstrap "Hello" paragraph with a paragraph
 * containing a single link-marked text node. Returns the rendered
 * `<a>` element.
 */
function buildLinkDoc(
  conn: EditorConnection,
  text: string,
  href: string,
): HTMLAnchorElement {
  const view = conn.view!;
  const linkMark = schema.marks.link.create({ href });
  const para = schema.nodes.paragraph.create(null, [
    schema.text(text, [linkMark]),
  ]);
  view.dispatch(
    view.state.tr.replaceWith(0, view.state.doc.content.size, para),
  );
  const a = view.dom.querySelector("a[href]") as HTMLAnchorElement | null;
  if (!a) {
    throw new Error(
      `expected <a href> in editor DOM, got: ${view.dom.innerHTML}`,
    );
  }
  return a;
}

function tooltipRoot(host: HTMLElement): HTMLElement | null {
  return host.querySelector(".pm-link-tooltip-root");
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("linkTooltipPlugin", () => {
  it("mouseover on a link shows a tooltip with URL + Open + Copy", async () => {
    const host = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection({ docId: "test-doc", place: host });
    await waitFor(() => expect(conn.view).not.toBeNull());

    const a = buildLinkDoc(conn, "see this", "https://example.test/path");

    // Tooltip starts hidden.
    const root = tooltipRoot(host)!;
    expect(root).not.toBeNull();
    expect(root.style.display).toBe("none");

    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

    expect(root.style.display).toBe("block");

    const url = root.querySelector(".pm-link-tooltip-url");
    expect(url?.textContent).toBe("https://example.test/path");

    const open = root.querySelector(
      "a.pm-link-tooltip-open",
    ) as HTMLAnchorElement;
    expect(open).not.toBeNull();
    expect(open.getAttribute("href")).toBe("https://example.test/path");
    expect(open.target).toBe("_blank");
    expect(open.rel).toMatch(/noopener/);

    expect(root.querySelector("button.pm-link-tooltip-copy")).not.toBeNull();

    conn.close();
  });

  it("mouseout from the link schedules a hide; re-entering the tooltip cancels it", async () => {
    vi.useFakeTimers();
    const host = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection({ docId: "test-doc", place: host });
    await vi.waitFor(() => expect(conn.view).not.toBeNull(), {
      timeout: 3000,
      interval: 1,
    });

    const a = buildLinkDoc(conn, "x", "https://x.test");
    const root = tooltipRoot(host)!;

    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(root.style.display).toBe("block");

    // mouseout to an unrelated target → schedules hide.
    const elsewhere = document.createElement("span");
    document.body.appendChild(elsewhere);
    a.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: elsewhere }),
    );

    // Still visible before the timer fires.
    expect(root.style.display).toBe("block");

    // Move into the tooltip itself before the hide timer elapses.
    root.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

    // Advance past HIDE_DELAY_MS; hide should NOT have happened because
    // entering the tooltip cancels it.
    vi.advanceTimersByTime(300);
    expect(root.style.display).toBe("block");

    // Now leave the tooltip entirely.
    root.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: elsewhere }),
    );
    vi.advanceTimersByTime(300);
    expect(root.style.display).toBe("none");

    conn.close();
    vi.useRealTimers();
  });

  it("view-mode (editable=false) suppresses the tooltip even on hover", async () => {
    const host = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection({ docId: "test-doc", place: host });
    await waitFor(() => expect(conn.view).not.toBeNull());

    conn.setEditable(false);

    const a = buildLinkDoc(conn, "x", "https://x.test");
    const root = tooltipRoot(host)!;

    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(root.style.display).toBe("none");

    conn.close();
  });

  it("flipping to read-only while the tooltip is open hides it on the next update", async () => {
    const host = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection({ docId: "test-doc", place: host });
    await waitFor(() => expect(conn.view).not.toBeNull());

    const a = buildLinkDoc(conn, "x", "https://x.test");
    const root = tooltipRoot(host)!;

    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(root.style.display).toBe("block");

    // Flip read-only — triggers a view update (setProps), which our
    // plugin's `update()` uses to close any open tooltip.
    conn.setEditable(false);

    expect(root.style.display).toBe("none");

    conn.close();
  });

  it("Copy button writes the URL to navigator.clipboard and shows a `Copied` confirmation", async () => {
    vi.useFakeTimers();
    const host = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const conn = new EditorConnection({ docId: "test-doc", place: host });
    await vi.waitFor(() => expect(conn.view).not.toBeNull(), {
      timeout: 3000,
      interval: 1,
    });

    const a = buildLinkDoc(conn, "x", "https://copy.test/page");
    const root = tooltipRoot(host)!;
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

    const copyBtn = root.querySelector(
      "button.pm-link-tooltip-copy",
    ) as HTMLButtonElement;
    copyBtn.click();

    expect(writeText).toHaveBeenCalledWith("https://copy.test/page");
    expect(copyBtn.textContent).toBe("Copied");

    // Confirmation label reverts after ~1.2s.
    vi.advanceTimersByTime(1500);
    expect(copyBtn.textContent).toBe("Copy");

    conn.close();
    vi.useRealTimers();
  });

  it("moving between two adjacent links retargets the tooltip without hide-flicker", async () => {
    vi.useFakeTimers();
    const host = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection({ docId: "test-doc", place: host });
    await vi.waitFor(() => expect(conn.view).not.toBeNull(), {
      timeout: 3000,
      interval: 1,
    });

    const view = conn.view!;
    // Two links separated by a space — both should be hoverable.
    const aMark = schema.marks.link.create({ href: "https://a.test" });
    const bMark = schema.marks.link.create({ href: "https://b.test" });
    const para = schema.nodes.paragraph.create(null, [
      schema.text("first", [aMark]),
      schema.text(" "),
      schema.text("second", [bMark]),
    ]);
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, para),
    );

    const links = view.dom.querySelectorAll("a[href]");
    expect(links).toHaveLength(2);
    const first = links[0] as HTMLAnchorElement;
    const second = links[1] as HTMLAnchorElement;

    const root = tooltipRoot(host)!;
    first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(root.querySelector(".pm-link-tooltip-url")?.textContent).toBe(
      "https://a.test",
    );

    // Leave the first link, immediately enter the second. The mouseout
    // relatedTarget is the second link, which the plugin treats as "let
    // the next mouseover swap" — don't schedule a hide.
    first.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: second }),
    );
    second.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));

    expect(root.style.display).toBe("block");
    expect(root.querySelector(".pm-link-tooltip-url")?.textContent).toBe(
      "https://b.test",
    );

    // Advance well past HIDE_DELAY_MS — no stale scheduled hide should
    // fire and close the freshly-targeted tooltip.
    vi.advanceTimersByTime(500);
    expect(root.style.display).toBe("block");

    conn.close();
    vi.useRealTimers();
  });

  it("destroy on connection close removes the tooltip DOM and detaches listeners", async () => {
    const host = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();

    const conn = new EditorConnection({ docId: "test-doc", place: host });
    await waitFor(() => expect(conn.view).not.toBeNull());

    const a = buildLinkDoc(conn, "x", "https://x.test");
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(tooltipRoot(host)).not.toBeNull();

    conn.close();
    expect(tooltipRoot(host)).toBeNull();
  });
});
