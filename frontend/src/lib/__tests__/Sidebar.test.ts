/**
 * Sidebar rail: Escape closes the open panel, but only an Escape nobody else
 * claimed. An inner interaction outside the editor (the link edit dialog, a
 * row drag) preventDefaults its Escape; the panel must stay open so the
 * innermost interaction wins (plans/shortcuts ticket 06, B4/B10).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/svelte";

import Sidebar from "../Sidebar.svelte";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as unknown as Response),
    ),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openLinks() {
  const r = render(Sidebar, { props: { view: null, docId: "d1" } });
  await fireEvent.click(r.getByLabelText("Links"));
  expect(r.container.querySelector(".paper-rail-flyout")).toBeTruthy();
  return r;
}

describe("Sidebar Escape", () => {
  it("closes the open panel on an unclaimed Escape", async () => {
    const { container } = await openLinks();
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".paper-rail-flyout")).toBeNull();
  });

  it("ignores an Escape an inner interaction already preventDefaulted", async () => {
    const { container } = await openLinks();
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    ev.preventDefault();
    window.dispatchEvent(ev);
    await Promise.resolve();
    expect(container.querySelector(".paper-rail-flyout")).toBeTruthy();
  });
});
