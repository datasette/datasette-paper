/**
 * PaperIndex tag-surface tests: per-row tag chips render from the list
 * payload, and selecting a tag filter refetches the list with ?tag=.
 *
 * PaperIndex calls the backend through the typed openapi-fetch `client`
 * (relative baseUrl, unbuildable as a Request under jsdom), so we mock the
 * client module and dispatch GET by url + query.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));
vi.mock("../client", () => ({ client: { GET: getMock, POST: postMock } }));

import PaperIndex from "../PaperIndex.svelte";

function doc(extra: Record<string, unknown>) {
  return {
    id: 1,
    name: "My Doc",
    current_version: 0,
    updated_at: "2026-06-22T00:00:00.000Z",
    created_by: "alice",
    created_by_name: "alice",
    created_by_avatar: null,
    is_owner: true,
    state: "active",
    archived_at: null,
    trashed_at: null,
    delete_at: null,
    kind: "doc",
    locked: false,
    tags: ["x", "y"],
    ...extra,
  };
}

let filteredCalls: string[][];

beforeEach(() => {
  filteredCalls = [];
  getMock.mockImplementation((url: string, opts?: { params?: { query?: Record<string, unknown> } }) => {
    const query = opts?.params?.query ?? {};
    if (url === "/-/paper/api/tags") {
      return Promise.resolve({
        data: { tags: [{ tag: "x", count: 1 }, { tag: "y", count: 1 }] },
        error: undefined,
      });
    }
    if (url === "/-/paper/api/docs") {
      if (query.kind === "template") {
        return Promise.resolve({ data: [], error: undefined });
      }
      const tags = (query.tag as string[] | undefined) ?? [];
      if (tags.length) filteredCalls.push(tags);
      return Promise.resolve({ data: [doc({})], error: undefined });
    }
    return Promise.reject(new Error(`unexpected GET: ${url}`));
  });
});

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
});

describe("PaperIndex tags", () => {
  it("renders per-row tag chips from the list payload", async () => {
    render(PaperIndex);
    await vi.waitFor(() =>
      expect(screen.getByRole("link", { name: "My Doc" })).toBeTruthy(),
    );
    // Row chips carry the "Filter by <tag>" accessible name (aria-label).
    expect(screen.getByRole("button", { name: "Filter by x" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filter by y" })).toBeTruthy();
  });

  it("selecting a tag in the filter bar refetches with ?tag=", async () => {
    render(PaperIndex);
    await vi.waitFor(() =>
      expect(screen.getByRole("link", { name: "My Doc" })).toBeTruthy(),
    );

    // The filter bar chip's accessible name is the bare tag ("x"); the row
    // chip's is "Filter by x". Exact-match name lookup picks the bar chip.
    await fireEvent.click(screen.getByRole("button", { name: "x" }));

    await vi.waitFor(() =>
      expect(filteredCalls.some((t) => t.includes("x"))).toBe(true),
    );
  });
});
