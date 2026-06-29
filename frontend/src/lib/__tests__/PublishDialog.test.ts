/**
 * PublishDialog tests. The dialog talks to the publish API with plain `fetch`
 * (the endpoints aren't in the typed client), so we stub `fetch` and assert the
 * calls + that the per-block frozen toggle surfaces the sensitive-data warning.
 *
 * jsdom doesn't implement <dialog>.showModal/close, so we stub them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";

import PublishDialog from "../PublishDialog.svelte";

const PREVIEW = {
  version: 4,
  html: "<h1>Hi</h1>",
  blocks: [{ block_id: "b0", kind: "sql", mode: "live", label: "analytics" }],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom <dialog> stubs.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });

  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/publications")) {
      return { ok: true, json: async () => ({ published_version: null }) } as Response;
    }
    if (url.includes("/publish/preview")) {
      return { ok: true, json: async () => PREVIEW } as Response;
    }
    if (url.endsWith("/publish")) {
      return {
        ok: true,
        json: async () => ({ version: 4 }),
        _init: init,
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PublishDialog", () => {
  it("loads a preview and lists data blocks", async () => {
    render(PublishDialog, { open: true, docId: "7" });
    await waitFor(() => expect(screen.getByText(/sql: analytics/)).toBeTruthy());
    expect(screen.getByText(/Publishing/)).toBeTruthy();
  });

  it("shows the sensitive-data warning when data is set to frozen", async () => {
    const { container } = render(PublishDialog, { open: true, docId: "7" });
    await waitFor(() => screen.getByText(/sql: analytics/));
    expect(container.querySelector(".pub-warn")).toBeNull();
    // Flip the default data mode to frozen → every data block is frozen.
    const frozenRadio = screen.getByLabelText(/Frozen/) as HTMLInputElement;
    await fireEvent.click(frozenRadio);
    await waitFor(() => {
      const warn = container.querySelector(".pub-warn");
      expect(warn?.textContent).toMatch(/bake/i);
      expect(warn?.textContent).toMatch(/audience/i);
    });
  });

  it("publishes with the chosen mode + audience", async () => {
    const onPublished = vi.fn();
    render(PublishDialog, { open: true, docId: "7", onPublished });
    await waitFor(() => screen.getByText(/sql: analytics/));

    // Choose public audience, then publish.
    const publicRadio = screen.getByLabelText(/Public/) as HTMLInputElement;
    await fireEvent.click(publicRadio);
    await fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(onPublished).toHaveBeenCalledWith(4));
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/publish"));
    expect(call).toBeTruthy();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.data_mode_default).toBe("live");
    expect(body.audience).toEqual([{ principal: "everyone" }]);
  });
});
