/**
 * AuthorsPanel tests.
 *
 * Real component mount via @testing-library/svelte (like LinksPanel). The
 * panel starts open and loads GET /authors on mount. `fetch` is stubbed and
 * keyed by method + URL so the byline, candidate list, and mutation responses
 * return canned payloads.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

import AuthorsPanel from "../AuthorsPanel.svelte";

type Author = { id: string; name: string; avatar_url: string | null };

let byline: Author[];
let candidates: Author[];

function json(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  byline = [];
  candidates = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.includes("/author-candidates")) {
      return Promise.resolve(json({ results: candidates, open_audience: false }));
    }
    if (method === "GET" && url.endsWith("/authors")) {
      return Promise.resolve(json({ authors: byline }));
    }
    if (method === "POST" && url.endsWith("/authors/add")) {
      const id = JSON.parse(String(init?.body)).actor_id as string;
      const added = candidates.find((c) => c.id === id) ?? {
        id,
        name: id,
        avatar_url: null,
      };
      byline = [...byline, added];
      candidates = candidates.filter((c) => c.id !== id);
      return Promise.resolve(json({ authors: byline }));
    }
    if (method === "POST" && url.endsWith("/authors/remove")) {
      const id = JSON.parse(String(init?.body)).actor_id as string;
      byline = byline.filter((a) => a.id !== id);
      return Promise.resolve(json({ authors: byline }));
    }
    if (method === "POST" && url.endsWith("/authors/replace")) {
      const ids = JSON.parse(String(init?.body)).authors as string[];
      byline = ids.map((id) => byline.find((a) => a.id === id)!);
      return Promise.resolve(json({ authors: byline }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function settled(): Promise<void> {
  await vi.waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
}

describe("AuthorsPanel", () => {
  it("renders the byline read-only when canManage is false", async () => {
    byline = [
      { id: "alice", name: "Alice", avatar_url: null },
      { id: "bob", name: "Bob", avatar_url: null },
    ];
    render(AuthorsPanel, { docId: "1", canManage: false });
    await settled();

    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    // No management affordances for a non-manager.
    expect(screen.queryByText("+ Add author")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove author" })).toBeNull();
  });

  it("shows an empty state when there are no authors", async () => {
    render(AuthorsPanel, { docId: "1", canManage: false });
    await settled();
    expect(screen.getByText("No authors yet")).toBeTruthy();
  });

  it("lets a manager add a candidate and updates the byline from the response", async () => {
    byline = [{ id: "alice", name: "Alice", avatar_url: null }];
    candidates = [{ id: "bob", name: "Bob", avatar_url: null }];
    render(AuthorsPanel, { docId: "1", canManage: true });
    await settled();

    await fireEvent.click(screen.getByText("+ Add author"));
    // Picker fetches candidates; wait for Bob to appear as a candidate button.
    const bobBtn = await vi.waitFor(() =>
      screen.getByRole("button", { name: /Bob/ }),
    );
    await fireEvent.click(bobBtn);

    // Byline now includes Bob (from the POST response).
    await vi.waitFor(() => {
      const names = screen
        .getAllByText(/Alice|Bob/)
        .map((el) => el.textContent);
      expect(names).toContain("Bob");
    });
    const fetchMock = vi.mocked(fetch);
    const posted = fetchMock.mock.calls.some(
      (c) => String(c[0]).endsWith("/authors/add"),
    );
    expect(posted).toBe(true);
  });

  it("lets a manager remove an author", async () => {
    byline = [
      { id: "alice", name: "Alice", avatar_url: null },
      { id: "bob", name: "Bob", avatar_url: null },
    ];
    render(AuthorsPanel, { docId: "1", canManage: true });
    await settled();

    const removeButtons = screen.getAllByRole("button", {
      name: "Remove author",
    });
    // Remove Bob (second row).
    await fireEvent.click(removeButtons[1]);

    await vi.waitFor(() => expect(screen.queryByText("Bob")).toBeNull());
    expect(screen.getByText("Alice")).toBeTruthy();
  });
});
