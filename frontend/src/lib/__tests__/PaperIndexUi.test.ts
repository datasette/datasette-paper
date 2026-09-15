/**
 * PaperIndex chrome tests (issue #55 listing-page pass): per-tab
 * descriptions, deep-linkable URL hashes, and the New paper split button
 * (1-click blank + caret menu of templates).
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

  // @feat new-paper: split button + caret menu create flows.
  describe("New paper split button", () => {
    let hrefSet: string | null;
    beforeEach(() => {
      hrefSet = null;
      postMock.mockResolvedValue({ data: doc({ id: 42 }), error: undefined });
      // jsdom can't navigate; capture the href assignment instead.
      vi.spyOn(window, "location", "get").mockReturnValue({
        ...window.location,
        get hash() {
          return "";
        },
        set hash(_v: string) {},
        set href(v: string) {
          hrefSet = v;
        },
      } as unknown as Location);
    });
    afterEach(() => vi.restoreAllMocks());

    it("creates a blank paper in one click, name left to the server", async () => {
      render(PaperIndex);
      await fireEvent.click(
        screen.getByRole("button", { name: "New paper" }),
      );
      await vi.waitFor(() => expect(hrefSet).toBe("/-/paper/doc/42?new=1"));
      expect(postMock).toHaveBeenCalledWith("/-/paper/api/docs", { body: {} });
    });

    it("creates from a template picked in the caret menu", async () => {
      render(PaperIndex);
      await fireEvent.click(
        screen.getByRole("button", { name: "More ways to create a paper" }),
      );
      const item = await screen.findByRole("menuitem", { name: "Weekly" });
      await fireEvent.click(item);
      await vi.waitFor(() => expect(hrefSet).toBe("/-/paper/doc/42?new=1"));
      expect(postMock).toHaveBeenCalledWith("/-/paper/api/docs", {
        body: { template_id: 9, name: "Weekly" },
      });
    });

    it("New template posts kind=template", async () => {
      render(PaperIndex);
      await fireEvent.click(
        screen.getByRole("button", { name: "More ways to create a paper" }),
      );
      await fireEvent.click(
        await screen.findByRole("menuitem", { name: "New template" }),
      );
      await vi.waitFor(() =>
        expect(postMock).toHaveBeenCalledWith("/-/paper/api/docs", {
          body: { name: "Untitled template", kind: "template" },
        }),
      );
    });

    it("Escape closes the menu, returns focus to the caret, and is claimed", async () => {
      render(PaperIndex);
      const caret = screen.getByRole("button", {
        name: "More ways to create a paper",
      });
      await fireEvent.click(caret);
      const item = await screen.findByRole("menuitem", { name: "Weekly" });
      const spy = vi.fn();
      window.addEventListener("keydown", spy);
      await fireEvent.keyDown(item, { key: "Escape" });
      window.removeEventListener("keydown", spy);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(caret);
      expect(spy).not.toHaveBeenCalled();
    });

    it("ArrowDown roves focus across menu items", async () => {
      render(PaperIndex);
      await fireEvent.click(
        screen.getByRole("button", { name: "More ways to create a paper" }),
      );
      const first = await screen.findByRole("menuitem", { name: "Weekly" });
      await vi.waitFor(() => expect(document.activeElement).toBe(first));
      await fireEvent.keyDown(first, { key: "ArrowDown" });
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: "New template" }),
      );
    });

    it("shows a filter input only past 8 templates", async () => {
      const many = Array.from({ length: 9 }, (_, i) =>
        doc({ id: 100 + i, name: `T${i}`, kind: "template" }),
      );
      getMock.mockImplementation(
        (url: string, opts?: { params?: { query?: Record<string, unknown> } }) => {
          if (url === "/-/paper/api/tags")
            return Promise.resolve({ data: { tags: [] }, error: undefined });
          const kind = opts?.params?.query?.kind;
          return Promise.resolve({
            data: kind === "template" ? many : [doc({})],
            error: undefined,
          });
        },
      );
      render(PaperIndex);
      await fireEvent.click(
        screen.getByRole("button", { name: "More ways to create a paper" }),
      );
      const filter = await screen.findByRole("textbox", {
        name: "Filter templates",
      });
      await fireEvent.input(filter, { target: { value: "T3" } });
      await vi.waitFor(() =>
        expect(screen.getAllByRole("menuitem").map((b) => b.textContent?.trim())).toEqual([
          "T3",
          "New template",
          "Manage templates",
        ]),
      );
      await fireEvent.keyDown(filter, { key: "Enter" });
      await vi.waitFor(() =>
        expect(postMock).toHaveBeenCalledWith("/-/paper/api/docs", {
          body: { template_id: 103, name: "T3" },
        }),
      );
    });
  });
});
