/**
 * Shared `EditorConnection` test harness: a mock EventSource, the bootstrap
 * fixture + fetch stub, and the mount/wait helpers. Tests install
 * `MockEventSource` as `globalThis.EventSource` in their own `beforeEach`, and
 * must `conn.close()` at the end (the cursor reporter's 150ms debounce).
 */
import { vi } from "vitest";
import type { ConnectionOpts } from "../../collab";

// ─── Mock EventSource ────────────────────────────────────────────────────────

export class MockEventSource {
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

export const BOOTSTRAP = {
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

export function makeBootstrapFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ...BOOTSTRAP }),
  });
}

export function makeEl(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

export function makeOpts(el: HTMLElement): ConnectionOpts {
  return { docId: "test-doc", place: el };
}

/** Wait for a condition by asserting inside the callback (so waitFor retries on throw). */
export async function waitFor(condition: () => void, timeout = 3000): Promise<void> {
  return vi.waitFor(condition, { timeout });
}
