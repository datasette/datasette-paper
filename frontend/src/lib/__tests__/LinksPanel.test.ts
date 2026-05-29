/**
 * LinksPanel tests.
 *
 * Real component mount via @testing-library/svelte (a project dep) — the
 * vitest config sets `environment: jsdom` + `conditions: ["browser"]`, which
 * is enough to mount this component (unlike PaperApp, it pulls in no
 * ProseMirror/EditorView machinery). `fetch` is stubbed and keyed by URL so
 * the `/links` and `/backlinks` endpoints return canned payloads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

import LinksPanel from "../LinksPanel.svelte";

type LinkItem = {
  id: number;
  occurrences: number;
  status: "ok" | "denied" | "not_found";
  title?: string;
  state?: string;
  kind?: string;
  href?: string;
};

let linksPayload: LinkItem[];
let backlinksPayload: LinkItem[];

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  linksPayload = [];
  backlinksPayload = [];
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/links")) {
      return Promise.resolve(jsonResponse({ links: linksPayload }));
    }
    if (url.endsWith("/backlinks")) {
      return Promise.resolve(jsonResponse({ backlinks: backlinksPayload }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openPanel(): Promise<void> {
  const toggle = screen.getByRole("button", { name: /links/i });
  await fireEvent.click(toggle);
  // Let the $effect-triggered load() (fetch + Promise.all) settle.
  await vi.waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
}

describe("LinksPanel", () => {
  it("opening fetches both endpoints and renders an ok forward link", async () => {
    linksPayload = [
      {
        id: 7,
        occurrences: 1,
        status: "ok",
        title: "Design Notes",
        state: "active",
        kind: "paper",
        href: "/7",
      },
    ];

    render(LinksPanel, { docId: "1" });
    await openPanel();

    const fetchMock = vi.mocked(fetch);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("/-/paper/api/docs/1/links");
    expect(urls).toContain("/-/paper/api/docs/1/backlinks");

    const link = screen.getByRole("link", { name: /Design Notes/ });
    expect(link.getAttribute("href")).toBe("/7");
  });

  it("renders a denied item non-clickable with no title", async () => {
    linksPayload = [
      { id: 9, occurrences: 1, status: "denied", title: "secret-should-not-show" },
    ];

    render(LinksPanel, { docId: "1" });
    await openPanel();

    expect(screen.getByText("Permission denied")).toBeTruthy();
    // No anchor rendered for a denied item.
    expect(screen.queryByRole("link")).toBeNull();
    // The (denied) title is never leaked into the DOM.
    expect(screen.queryByText(/secret-should-not-show/)).toBeNull();
  });

  it("renders a not_found item struck-through and non-clickable", async () => {
    linksPayload = [{ id: 42, occurrences: 1, status: "not_found" }];

    render(LinksPanel, { docId: "1" });
    await openPanel();

    const missing = screen.getByText("Paper #42");
    expect(missing.tagName).toBe("SPAN");
    expect(missing.className).toContain("links-panel-missing");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders a backlink in the Linked from section", async () => {
    backlinksPayload = [
      {
        id: 3,
        occurrences: 2,
        status: "ok",
        title: "Referring Doc",
        state: "active",
        kind: "paper",
        href: "/3",
      },
    ];

    render(LinksPanel, { docId: "1" });
    await openPanel();

    expect(screen.getByText("Linked from")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Referring Doc/ });
    expect(link.getAttribute("href")).toBe("/3");
  });
});
