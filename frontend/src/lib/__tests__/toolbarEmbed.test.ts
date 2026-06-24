/**
 * Toolbar embed-dropdown tests.
 *
 * The launcher reads the shared `embedInsertSources()` (driven here via
 * `setProviderManifest`) and calls back through `onInsertEmbed`. We mount the
 * real `Toolbar.svelte` with `view: null` — the embed control never touches the
 * editor view, so a null view is enough and avoids standing up ProseMirror.
 *
 * Two behaviours are pinned:
 *   - single source (default install): the trigger opens the native dialog
 *     directly — `onInsertEmbed(undefined)`, no menu rendered.
 *   - ≥1 provider: the trigger toggles a menu of native + each provider source;
 *     clicking item k calls `onInsertEmbed` with that source's id.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

import Toolbar from "../Toolbar.svelte";
import { setProviderManifest, _resetProvidersForTest } from "../embedProviders";

afterEach(() => {
  cleanup();
  _resetProvidersForTest();
});

const trigger = () => screen.getByLabelText("Insert embed");

describe("Toolbar embed dropdown — single source", () => {
  it("opens the native dialog directly (no menu) when no providers exist", async () => {
    setProviderManifest([]);
    const onInsertEmbed = vi.fn();
    render(Toolbar, { view: null, onInsertEmbed });

    await fireEvent.click(trigger());

    // Native dialog opened directly with the undefined (native) source id…
    expect(onInsertEmbed).toHaveBeenCalledTimes(1);
    expect(onInsertEmbed).toHaveBeenCalledWith(undefined);
    // …and no menu was rendered.
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Toolbar embed dropdown — multiple sources", () => {
  it("opens a menu of native + each provider and reports the clicked id", async () => {
    setProviderManifest([
      {
        kind: "places",
        sources: [
          { id: "place-list", label: "Places" },
          { id: "place-map", label: "Map", icon: "globe" },
        ],
      },
    ]);
    const onInsertEmbed = vi.fn();
    render(Toolbar, { view: null, onInsertEmbed });

    await fireEvent.click(trigger());

    // Native + 2 providers = 3 menu items, native first.
    const items = screen.getAllByRole("menuitem");
    expect(items.map((b) => b.textContent?.trim())).toEqual([
      "Datasette embed",
      "Places",
      "Map",
    ]);
    // The trigger toggle should not have opened the dialog itself.
    expect(onInsertEmbed).not.toHaveBeenCalled();

    // Clicking the second provider reports its source id and closes the menu.
    await fireEvent.click(items[2]);
    expect(onInsertEmbed).toHaveBeenCalledTimes(1);
    expect(onInsertEmbed).toHaveBeenCalledWith("place-map");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("clicking the native item reports an undefined source id", async () => {
    setProviderManifest([
      { kind: "places", sources: [{ id: "place-list", label: "Places" }] },
    ]);
    const onInsertEmbed = vi.fn();
    render(Toolbar, { view: null, onInsertEmbed });

    await fireEvent.click(trigger());
    const items = screen.getAllByRole("menuitem");
    await fireEvent.click(items[0]);
    expect(onInsertEmbed).toHaveBeenCalledWith(undefined);
  });

  it("toggles the menu closed when the trigger is clicked again", async () => {
    setProviderManifest([
      { kind: "places", sources: [{ id: "p", label: "P" }] },
    ]);
    render(Toolbar, { view: null, onInsertEmbed: vi.fn() });

    await fireEvent.click(trigger());
    expect(screen.queryByRole("menu")).not.toBeNull();
    await fireEvent.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
