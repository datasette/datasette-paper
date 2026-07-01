/**
 * PaperIndex chrome tests (issue #55 listing-page pass): per-tab
 * descriptions, deep-linkable URL hashes, and the reworked template
 * picker ("No template" + "Create a template").
 *
 * Like PaperIndexTags.test.ts, PaperIndex talks to the backend through
 * the typed openapi-fetch `client`, so we mock that module and answer
 * GET by url + query.
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
    tags: [],
    ...extra,
  };
}

beforeEach(() => {
  window.location.hash = "";
  getMock.mockImplementation(
    (url: string, opts?: { params?: { query?: Record<string, unknown> } }) => {
      const query = opts?.params?.query ?? {};
      if (url === "/-/paper/api/tags") {
        return Promise.resolve({ data: { tags: [] }, error: undefined });
      }
      if (url === "/-/paper/api/docs") {
        if (query.kind === "template") {
          return Promise.resolve({
            data: [doc({ id: 9, name: "Weekly", kind: "template", state: "active" })],
            error: undefined,
          });
        }
        return Promise.resolve({ data: [doc({})], error: undefined });
      }
      return Promise.reject(new Error(`unexpected GET: ${url}`));
    },
  );
});

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
  window.location.hash = "";
});

describe("PaperIndex chrome", () => {
  it("shows the active-tab description and updates it on tab switch", async () => {
    render(PaperIndex);
    await vi.waitFor(() =>
      expect(screen.getByRole("link", { name: "My Doc" })).toBeTruthy(),
    );
    expect(
      screen.getByText("Papers you're currently working on."),
    ).toBeTruthy();

    await fireEvent.click(screen.getByRole("tab", { name: /^Trash/ }));
    await vi.waitFor(() =>
      expect(screen.getByText(/scheduled to be deleted 7 days/)).toBeTruthy(),
    );
  });

  it("reflects the selected tab in the URL hash", async () => {
    render(PaperIndex);
    await vi.waitFor(() => expect(window.location.hash).toBe("#active"));

    await fireEvent.click(screen.getByRole("tab", { name: /^Archive/ }));
    await vi.waitFor(() => expect(window.location.hash).toBe("#archive"));
  });

  it("honors an initial URL hash on mount", async () => {
    window.location.hash = "#templates";
    render(PaperIndex);
    // The Templates tab is selected → its template row is listed.
    await vi.waitFor(() =>
      expect(screen.getByRole("link", { name: "Weekly" })).toBeTruthy(),
    );
    expect(screen.getByText(/reusable starting points/i)).toBeTruthy();
  });

  it("renders the reworked template picker options", async () => {
    render(PaperIndex);
    await vi.waitFor(() =>
      expect(screen.getByRole("option", { name: "No template" })).toBeTruthy(),
    );
    expect(
      screen.getByRole("option", { name: /Create a template/ }),
    ).toBeTruthy();
  });
});
