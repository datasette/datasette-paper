/**
 * Tests for the plain-link open-in-new-tab plugin.
 *
 * Drives the plugin through an `EditorConnection` (so the real plugin stack
 * mounts, including PM's `handleDOMEvents` wiring), stubs `window.open`, and
 * dispatches `click` events on the rendered anchors.
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
  const host = document.createElement("div");
  host.className = "editor-host";
  document.body.appendChild(host);
  return host;
}

async function waitFor(condition: () => void, timeout = 3000): Promise<void> {
  return vi.waitFor(condition, { timeout });
}

beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as Record<string, unknown>).EventSource = MockEventSource;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Replace the doc with a single link-marked text node; return its `<a>`. */
function buildLinkDoc(conn: EditorConnection, href: string): HTMLAnchorElement {
  const view = conn.view!;
  const linkMark = schema.marks.link.create({ href });
  const para = schema.nodes.paragraph.create(null, [
    schema.text("click me", [linkMark]),
  ]);
  view.dispatch(
    view.state.tr.replaceWith(0, view.state.doc.content.size, para),
  );
  const a = view.dom.querySelector("a[href]") as HTMLAnchorElement | null;
  if (!a) throw new Error(`expected <a> in: ${view.dom.innerHTML}`);
  return a;
}

function click(a: HTMLAnchorElement): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  return ev;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("linkOpenPlugin", () => {
  it("opens a plain link in a new tab on click while editing", async () => {
    const host = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);

    const conn = new EditorConnection({ docId: "test-doc", place: host });
    await waitFor(() => expect(conn.view).not.toBeNull());

    const a = buildLinkDoc(conn, "https://example.test/path");
    const ev = click(a);

    expect(open).toHaveBeenCalledWith(
      "https://example.test/path",
      "_blank",
      "noopener",
    );
    // Native same-tab navigation is suppressed.
    expect(ev.defaultPrevented).toBe(true);

    conn.close();
  });

  it("does nothing in view mode (browser navigates natively)", async () => {
    const host = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);

    const conn = new EditorConnection({ docId: "test-doc", place: host });
    await waitFor(() => expect(conn.view).not.toBeNull());

    const a = buildLinkDoc(conn, "https://example.test/path");
    conn.setEditable(false);
    const ev = click(a);

    expect(open).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);

    conn.close();
  });

  it("skips anchors that carry a class (NodeView/embed chrome owns its clicks)", async () => {
    const host = makeEl();
    (globalThis as Record<string, unknown>).fetch = makeBootstrapFetch();
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);

    const conn = new EditorConnection({ docId: "test-doc", place: host });
    await waitFor(() => expect(conn.view).not.toBeNull());

    const a = buildLinkDoc(conn, "https://example.test/path");
    // Stamp a `pm-*` class (as every NodeView/embed anchor has) → skipped.
    a.className = "pm-block-embed-label--link";
    const ev = click(a);

    expect(open).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);

    conn.close();
  });
});
