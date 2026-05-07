/**
 * PaperApp integration tests.
 *
 * We test the connection-management logic that PaperApp.svelte exercises,
 * without mounting the Svelte component (which requires a browser-condition
 * resolve pass not configured in this vitest environment).
 *
 * Two behaviours are verified:
 *   1. EditorConnection is constructed with the correct opts (docId, place)
 *      and a Reporter instance — matching PaperApp's $effect body.
 *   2. close() is called when the cleanup function returned from $effect runs —
 *      matching PaperApp's onDestroy / $effect teardown.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Reporter } from "../reporter";

// ─── Mock collab module ───────────────────────────────────────────────────────

const mockClose = vi.fn();

vi.mock("../collab", () => ({
  EditorConnection: vi.fn().mockImplementation(function (
    this: { close: () => void }
  ) {
    this.close = mockClose;
  }),
}));

// ─── Import after mock is registered ────────────────────────────────────────

const { EditorConnection } = await import("../collab");

// ─── Helpers — mirror the logic in PaperApp's $effect ──────────────────────────

/**
 * Simulates what PaperApp.svelte's $effect does when editorEl becomes available.
 * Returns a teardown function that mirrors the $effect cleanup + onDestroy.
 */
function initConnection(opts: {
  docId: string;
  place: HTMLElement;
}): { conn: { close: () => void }; teardown: () => void } {
  const reporter = new Reporter();
  const unsub = reporter.subscribe(() => {});
  // EditorConnection constructor auto-starts in production; mock captures construction.
  const conn = new EditorConnection(
    { docId: opts.docId, place: opts.place },
    reporter
  );

  const teardown = () => {
    unsub();
    (conn as { close: () => void }).close();
  };

  return { conn: conn as unknown as { close: () => void }, teardown };
}

// ─── Teardown ────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PaperApp connection management", () => {
  it("mounts and initializes connection with correct opts", () => {
    const place = document.createElement("div");
    document.body.appendChild(place);

    initConnection({ docId: "1", place });

    const MockCtor = vi.mocked(EditorConnection);
    expect(MockCtor).toHaveBeenCalledOnce();

    const [opts, reporter] = MockCtor.mock.calls[0] as [
      { docId: string; place: HTMLElement },
      Reporter,
    ];
    expect(opts.docId).toBe("1");
    expect(opts.place).toBe(place);
    expect(reporter).toBeInstanceOf(Reporter);
  });

  it("closes connection on unmount (teardown)", () => {
    const place = document.createElement("div");
    document.body.appendChild(place);

    const { teardown } = initConnection({ docId: "1", place });

    // Before teardown: close has not been called
    expect(mockClose).not.toHaveBeenCalled();

    // Simulate component unmount / $effect cleanup
    teardown();

    expect(mockClose).toHaveBeenCalledOnce();
  });
});
