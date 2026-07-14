/**
 * GraphModal: the shared modal shell around <LinkGraph>. We assert it renders
 * nothing when closed, renders a role=dialog + the graph when open, and that
 * both Escape and a backdrop click call `onClose`. LinkGraph fetches on mount,
 * so `fetch` is stubbed to return an empty graph (the empty-nodes path settles
 * without importing d3-force).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";

import GraphModal from "../GraphModal.svelte";

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse({ nodes: [], edges: [] }))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("GraphModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(GraphModal, {
      props: { open: false, onClose: () => {} },
    });
    expect(container.querySelector(".graph-dialog")).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders the dialog and the graph when open", async () => {
    const { container } = render(GraphModal, {
      props: { open: true, onClose: () => {} },
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute("aria-label")).toBe("Link graph");
    // LinkGraph mounted inside.
    await vi.waitFor(() => expect(container.querySelector(".link-graph-root")).toBeTruthy());
  });

  it("calls onClose on Escape", async () => {
    const onClose = vi.fn();
    render(GraphModal, { props: { open: true, onClose } });
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the backdrop (but not the dialog) is clicked", async () => {
    const onClose = vi.fn();
    const { container } = render(GraphModal, { props: { open: true, onClose } });

    // Clicking the dialog body does NOT close.
    const dialog = container.querySelector(".graph-dialog") as HTMLElement;
    await fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    // Clicking the backdrop itself closes.
    const backdrop = container.querySelector(".graph-backdrop") as HTMLElement;
    await fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("also closes on the header × button", async () => {
    const onClose = vi.fn();
    render(GraphModal, { props: { open: true, onClose } });
    await fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
