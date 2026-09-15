/**
 * Toolbar shortcut hints render from the `SHORTCUTS` registry (plans/shortcuts
 * ticket 04): accessible names stay plain, the chord lives in `title` +
 * `aria-keyshortcuts`, and menu hints are platform-formatted. jsdom is non-mac
 * (`navigator.platform === ""`), so every chord renders Ctrl-style.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import Toolbar from "../Toolbar.svelte";
import { schema } from "../schema";
import { buildSlashCommands, type SlashCommand } from "../slashMenu";

let view: EditorView;

beforeEach(() => {
  // Toolbar reads matchMedia for `isMobile`; jsdom has none. Desktop layout.
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
  const state = EditorState.create({
    doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("hi")])]),
  });
  view = new EditorView(document.createElement("div"), { state });
});

afterEach(() => {
  cleanup();
  view.destroy();
  vi.unstubAllGlobals();
});

function mount(insertCommands: SlashCommand[] = []) {
  return render(Toolbar, { props: { view, insertCommands } });
}

function rowHint(menuName: string, label: string): string | null | undefined {
  const menu = screen.getByRole("menu", { name: menuName });
  const row = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (el) => el.querySelector(".tb-menu-label")?.textContent === label,
  );
  expect(row, `${menuName} ▾ row "${label}"`).toBeTruthy();
  return row!.querySelector(".tb-menu-hint")?.textContent;
}

describe("Toolbar shortcut hints", () => {
  it("buttons keep plain accessible names and carry the chord in title + aria-keyshortcuts", async () => {
    mount();
    await tick();
    const bold = screen.getByRole("button", { name: "Bold" });
    expect(bold.getAttribute("aria-keyshortcuts")).toBe("Control+B");
    expect(bold.getAttribute("title")).toBe("Bold (Ctrl+B)");

    const hl = screen.getByRole("button", { name: "Highlight" });
    expect(hl.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+H");
    expect(hl.getAttribute("title")).toBe("Highlight (Ctrl+Shift+H)");

    const redo = screen.getByRole("button", { name: "Redo" });
    expect(redo.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+Z");
  });

  it("menu rows render platform-formatted hints from the registry", async () => {
    // @feat shortcuts: test — toolbar button titles / aria-keyshortcuts and menu hints are non-mac under jsdom
    const { container } = mount();
    await tick();

    await fireEvent.click(screen.getByRole("button", { name: "Turn into" }));
    expect(rowHint("Turn into", "Heading 1")).toBe("Ctrl+Shift+1");
    expect(rowHint("Turn into", "Text")).toBe("Ctrl+Shift+0");
    expect(container.innerHTML).not.toMatch(/[⌘⇧⌃]/);
    // Close it first: the open menu's outside-click listener would otherwise
    // close the next one on the same click.
    await fireEvent.click(screen.getByRole("button", { name: "Turn into" }));

    await fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(rowHint("List", "Bullet list")).toBe("Ctrl+Shift+8");
    expect(rowHint("List", "Indent")).toBe("Ctrl+]");
    const indent = screen.getByRole("menuitem", { name: /Indent/ });
    expect(indent.getAttribute("aria-keyshortcuts")).toBe("Control+]");
    expect(container.innerHTML).not.toMatch(/[⌘⇧⌃]/);
  });

  it("Insert rows show a hint only when their command names a shortcut", async () => {
    // Real registry: divider + the date quick-inserts are styling-group slash
    // commands opted into the Insert menu (`insertMenuGroup`).
    mount(buildSlashCommands());
    await tick();
    await fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(rowHint("Insert", "Divider")).toBe("Ctrl+_");
    expect(rowHint("Insert", "Today")).toBe("Ctrl+;");
    expect(rowHint("Insert", "Tomorrow")).toBe("Ctrl+Shift+;");
    expect(rowHint("Insert", "Image")).toBeUndefined();
    const divider = screen.getByRole("menuitem", { name: /Divider/ });
    expect(divider.getAttribute("aria-keyshortcuts")).toBe("Control+_");
  });
});
