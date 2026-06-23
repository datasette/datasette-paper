/**
 * TagEditor tests.
 *
 * The component talks to the backend through the typed openapi-fetch `client`
 * (relative baseUrl, which undici can't build a Request from under jsdom), so
 * we mock the client module directly and assert on the calls. The server is
 * the source of truth for the normalized tag set; the component reflects the
 * response and forwards it via onChange.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));
vi.mock("../client", () => ({ client: { POST: postMock } }));

import TagEditor from "../TagEditor.svelte";

let addResult: string[];
let removeResult: string[];

beforeEach(() => {
  addResult = [];
  removeResult = [];
  postMock.mockImplementation((url: string) => {
    if (url.endsWith("/tags/add")) {
      return Promise.resolve({ data: { tags: addResult }, error: undefined });
    }
    if (url.endsWith("/tags/remove")) {
      return Promise.resolve({ data: { tags: removeResult }, error: undefined });
    }
    return Promise.reject(new Error(`unexpected POST: ${url}`));
  });
});

afterEach(() => {
  cleanup();
  postMock.mockReset();
});

describe("TagEditor", () => {
  it("renders existing tags as chips", () => {
    render(TagEditor, {
      docId: 5,
      docName: "Doc",
      tags: ["alpha"],
      vocab: ["alpha", "beta"],
      onChange: vi.fn(),
      onClose: vi.fn(),
    });
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("adding a tag posts to /tags/add and forwards the server's set", async () => {
    const onChange = vi.fn();
    addResult = ["alpha", "beta"];
    render(TagEditor, {
      docId: 5,
      docName: "Doc",
      tags: ["alpha"],
      vocab: ["alpha", "beta"],
      onChange,
      onClose: vi.fn(),
    });

    const input = screen.getByPlaceholderText("Add a tag…");
    await fireEvent.input(input, { target: { value: "beta" } });
    await fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

    const [url, opts] = postMock.mock.calls[0];
    expect(url).toBe("/-/paper/api/docs/{doc_id}/tags/add");
    expect(opts.params.path.doc_id).toBe(5);
    expect(opts.body).toEqual({ tag: "beta" });
    expect(onChange).toHaveBeenCalledWith(5, ["alpha", "beta"]);
    expect(screen.getByText("beta")).toBeTruthy();
  });

  it("removing a tag posts to /tags/remove and updates the chips", async () => {
    const onChange = vi.fn();
    removeResult = [];
    render(TagEditor, {
      docId: 7,
      docName: "Doc",
      tags: ["alpha"],
      vocab: ["alpha"],
      onChange,
      onClose: vi.fn(),
    });

    await fireEvent.click(screen.getByRole("button", { name: "Remove alpha" }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());

    const [url, opts] = postMock.mock.calls[0];
    expect(url).toBe("/-/paper/api/docs/{doc_id}/tags/remove");
    expect(opts.params.path.doc_id).toBe(7);
    expect(opts.body).toEqual({ tag: "alpha" });
    expect(onChange).toHaveBeenCalledWith(7, []);
    expect(screen.queryByText("alpha")).toBeNull();
  });

  it("Done closes the editor", async () => {
    const onClose = vi.fn();
    render(TagEditor, {
      docId: 5,
      docName: "Doc",
      tags: [],
      vocab: [],
      onChange: vi.fn(),
      onClose,
    });
    await fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });
});
