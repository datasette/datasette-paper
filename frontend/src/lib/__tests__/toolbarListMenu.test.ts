/**
 * The List ▾ menu's Toggle-list row (plans/toggle-list ticket 03): its active
 * marker tracks `activeListItemKind` (the item's `kind` attr) rather than
 * `activeListType` (the container), and clicking it converts the item.
 *
 * The toolbar derives both from a RAF-polled `tick` `$state` — PM transactions
 * don't rerender Svelte — so each case builds the doc it needs BEFORE mounting
 * and asserts on the first render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import { tick } from "svelte";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

import Toolbar from "../Toolbar.svelte";
import { schema } from "../schema";

const n = schema.nodes;
let view: EditorView;

beforeEach(() => {
  // Toolbar reads matchMedia for `isMobile`; jsdom has none. Desktop layout.
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })),
  );
});

afterEach(() => {
  cleanup();
  view?.destroy();
  vi.unstubAllGlobals();
});

/** Mount the toolbar over a doc whose cursor sits inside the "b" text node. */
async function mountWithDoc(doc: PMNode) {
  let pos = -1;
  doc.descendants((node, at) => {
    if (pos === -1 && node.isText && node.text === "b") pos = at + 1;
  });
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, pos) });
  view = new EditorView(document.createElement("div"), { state });
  render(Toolbar, { props: { view, insertCommands: [] } });
  await tick();
  await fireEvent.click(screen.getByRole("button", { name: "List" }));
  return screen.getByRole("menuitem", { name: /Toggle list/ });
}

const item = (text: string, attrs: Record<string, unknown> | null = null) =>
  n.list_item.create(attrs, n.paragraph.create(null, schema.text(text)));

describe("List ▾ Toggle-list row", () => {
  it("is inactive on a plain bullet item", async () => {
    const row = await mountWithDoc(n.doc.create(null, [n.bullet_list.create(null, [item("b")])]));
    expect(row.classList.contains("active")).toBe(false);
  });

  it("is active inside a toggle item", async () => {
    const row = await mountWithDoc(
      n.doc.create(null, [
        n.bullet_list.create(null, [item("b", { kind: "toggle", collapsed: false })]),
      ]),
    );
    expect(row.classList.contains("active")).toBe(true);
  });

  it("carries no shortcut hint (none in v1)", async () => {
    const row = await mountWithDoc(n.doc.create(null, [n.bullet_list.create(null, [item("b")])]));
    expect(row.querySelector(".tb-menu-hint")).toBeNull();
    expect(row.getAttribute("aria-keyshortcuts")).toBeNull();
  });

  it("converts the item at the cursor when clicked", async () => {
    const row = await mountWithDoc(n.doc.create(null, [n.bullet_list.create(null, [item("b")])]));
    await fireEvent.click(row);
    expect(view.state.doc.firstChild!.child(0).attrs.kind).toBe("toggle");
  });
});
