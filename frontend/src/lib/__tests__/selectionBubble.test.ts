/**
 * Selection bubble (`selectionBubble.ts`): the mapped anchor in plugin state,
 * the suppression matrix, the two show triggers, the Escape ladder, the
 * controls' commands, and teardown.
 *
 * jsdom has no layout — `coordsAtPos` throws (no `getClientRects`) and every
 * `offset*` reads 0 — so the positioning path must *degrade*, not throw; the
 * tests that care about it stub `coordsAtPos` explicitly. The view is mounted
 * the way production does (an `EditorView` inside an `.editor-host` parent,
 * with the plugin and the Escape keymap installed); `selectionBubbleViewFor`
 * is how a test gets a handle on the instance, since ProseMirror doesn't
 * expose plugin views.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  EditorState,
  NodeSelection,
  Selection,
  TextSelection,
} from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import { activeHighlightColor } from "../highlight";
import {
  selectionBubbleKey,
  selectionBubbleKeymap,
  selectionBubblePlugin,
  selectionBubbleViewFor,
  shouldShowBubble,
  type BubbleAnchor,
  type SelectionBubbleView,
} from "../selectionBubble";

const { doc, paragraph, heading, code_block, sql_block, source } = schema.nodes;
const { table, table_row, table_cell } = schema.nodes;
const { strong, highlight } = schema.marks;

const mounted: EditorView[] = [];
const hosts: HTMLElement[] = [];

/** `doc(paragraph("Hello world"))` — text occupies positions 1..12. */
function hello(): PMNode {
  return doc.create(null, [paragraph.create(null, schema.text("Hello world"))]);
}

/** `doc(paragraph("Hello world"), code_block("select 1"))` — code text 14..22. */
function withCode(): PMNode {
  return doc.create(null, [
    paragraph.create(null, schema.text("Hello world")),
    code_block.create(null, schema.text("select 1")),
  ]);
}

/** A one-cell table; the cell's paragraph text occupies 4..8. */
function withTable(): PMNode {
  return doc.create(null, [
    table.create(null, [
      table_row.create(null, [
        table_cell.create(null, paragraph.create(null, schema.text("Cell"))),
      ]),
    ]),
  ]);
}

function stateOf(d: PMNode, sel?: { from: number; to: number }): EditorState {
  return EditorState.create({
    doc: d,
    selection: sel
      ? TextSelection.create(d, sel.from, sel.to)
      : Selection.atStart(d),
  });
}

function mount(d: PMNode = hello(), sel?: { from: number; to: number }): EditorView {
  const host = document.createElement("div");
  host.className = "editor-host";
  document.body.appendChild(host);
  hosts.push(host);
  const state = EditorState.create({
    doc: d,
    selection: sel ? TextSelection.create(d, sel.from, sel.to) : Selection.atStart(d),
    plugins: [selectionBubblePlugin(), keymap(selectionBubbleKeymap())],
  });
  const view = new EditorView(host, { state });
  mounted.push(view);
  return view;
}

const root = (view: EditorView): HTMLElement =>
  view.dom.parentElement!.querySelector(".pm-selection-bubble") as HTMLElement;

const control = (view: EditorView, label: string): HTMLButtonElement =>
  root(view).querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;

const bubbleOf = (view: EditorView): SelectionBubbleView =>
  selectionBubbleViewFor(view)!;

/** Fire the mouseup trigger and wait out its settle tick. */
async function mouseup(view: EditorView): Promise<void> {
  view.dom.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function contextmenu(view: EditorView, x = 40, y = 120): MouseEvent {
  const evt = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  view.dom.dispatchEvent(evt);
  return evt;
}

function pressEscape(view: EditorView): KeyboardEvent {
  const evt = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  view.dom.dispatchEvent(evt);
  return evt;
}

/** Make `coordsAtPos` answer so the positioning path runs end to end. */
function stubCoords(view: EditorView) {
  // A command ending in `scrollIntoView()` sends the view through
  // scrollToSelection → window.scrollBy, which jsdom logs as "Not implemented".
  vi.stubGlobal("scrollBy", () => {});
  return vi
    .spyOn(view, "coordsAtPos")
    .mockReturnValue({ left: 100, right: 100, top: 200, bottom: 216 });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (mounted.length) mounted.pop()!.destroy();
  while (hosts.length) hosts.pop()!.remove();
});

// ─── suppression matrix ──────────────────────────────────────────────────────

describe("shouldShowBubble", () => {
  const ok = { editable: true, mobile: false };

  it("allows a non-empty selection in a plain paragraph", () => {
    expect(shouldShowBubble(stateOf(hello(), { from: 1, to: 6 }), ok)).toBe(true);
  });

  it("rejects a collapsed selection", () => {
    expect(shouldShowBubble(stateOf(hello()), ok)).toBe(false);
  });

  it("rejects a NodeSelection — an atom has its own chrome", () => {
    const d = hello();
    const state = EditorState.create({ doc: d, selection: NodeSelection.create(d, 0) });
    expect(shouldShowBubble(state, ok)).toBe(false);
  });

  it("rejects a selection inside a code_block", () => {
    expect(shouldShowBubble(stateOf(withCode(), { from: 14, to: 20 }), ok)).toBe(
      false,
    );
  });

  it("rejects a selection inside a sql_block", () => {
    const d = doc.create(null, [sql_block.create(null, schema.text("select 1"))]);
    expect(shouldShowBubble(stateOf(d, { from: 1, to: 7 }), ok)).toBe(false);
  });

  it("rejects a selection inside a source block", () => {
    const d = doc.create(null, [source.create(null, schema.text("select 1"))]);
    expect(shouldShowBubble(stateOf(d, { from: 1, to: 7 }), ok)).toBe(false);
  });

  it("rejects a selection inside a table cell — the table tooltip owns that UI", () => {
    expect(shouldShowBubble(stateOf(withTable(), { from: 4, to: 8 }), ok)).toBe(
      false,
    );
  });

  it("rejects a selection spanning a paragraph and a code block", () => {
    // Either end being code suppresses: half the range is a surface the
    // controls can't act on.
    const state = stateOf(withCode(), { from: 3, to: 16 });
    expect(state.selection.$from.parent.type).toBe(paragraph);
    expect(state.selection.$to.parent.type).toBe(code_block);
    expect(shouldShowBubble(state, ok)).toBe(false);
  });

  it("rejects a read-only view", () => {
    expect(
      shouldShowBubble(stateOf(hello(), { from: 1, to: 6 }), {
        editable: false,
        mobile: false,
      }),
    ).toBe(false);
  });

  it("rejects mobile widths", () => {
    expect(
      shouldShowBubble(stateOf(hello(), { from: 1, to: 6 }), {
        editable: true,
        mobile: true,
      }),
    ).toBe(false);
  });
});

// ─── plugin state ────────────────────────────────────────────────────────────

describe("selectionBubbleKey.apply", () => {
  /** A state carrying `anchor`, with no view attached. */
  function anchored(anchor: BubbleAnchor): EditorState {
    const d = hello();
    const state = EditorState.create({
      doc: d,
      // Non-empty, as it always is when a trigger writes an anchor: the
      // collapse rule below would otherwise drop it on the first transaction.
      selection: TextSelection.create(d, 3, 7),
      plugins: [selectionBubblePlugin()],
    });
    return state.apply(state.tr.setMeta(selectionBubbleKey, anchor));
  }

  it("starts empty and records an explicit anchor", () => {
    const state = EditorState.create({ doc: hello(), plugins: [selectionBubblePlugin()] });
    expect(selectionBubbleKey.getState(state)).toBeNull();
    expect(selectionBubbleKey.getState(anchored({ from: 3, to: 7 }))).toEqual({
      from: 3,
      to: 7,
    });
  });

  it("maps the anchor across an insertion before it", () => {
    const state = anchored({ from: 3, to: 7 });
    const next = state.apply(state.tr.insertText("ab", 1));
    expect(selectionBubbleKey.getState(next)).toEqual({ from: 5, to: 9 });
  });

  it("does not grow when text lands on either edge (bias 1 / -1)", () => {
    const state = anchored({ from: 3, to: 7 });
    // Bare inserts, not `tr.insertText`: the latter is the typing helper and
    // re-places the caret (transaction.ts:179-180), which is a dismiss here.
    // A collaborator's step arrives as a plain replacement.
    const next = state.apply(
      state.tr.insert(7, schema.text("x")).insert(3, schema.text("y")),
    );
    expect(selectionBubbleKey.getState(next)).toEqual({ from: 4, to: 8 });
  });

  it("drops the anchor when a collaborator deletes the span", () => {
    const state = anchored({ from: 3, to: 7 });
    const next = state.apply(state.tr.delete(3, 7));
    expect(selectionBubbleKey.getState(next)).toBeNull();
  });

  it("drops the anchor when the selection collapses", () => {
    const state = anchored({ from: 3, to: 7 });
    const next = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 5)),
    );
    expect(selectionBubbleKey.getState(next)).toBeNull();
  });

  it("honours an explicit null meta as a dismiss", () => {
    const state = anchored({ from: 3, to: 7 });
    const next = state.apply(state.tr.setMeta(selectionBubbleKey, null));
    expect(selectionBubbleKey.getState(next)).toBeNull();
  });

  it("leaves the anchor alone for a transaction with no opinion", () => {
    const state = anchored({ from: 3, to: 7 });
    const next = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1, 4)),
    );
    expect(selectionBubbleKey.getState(next)).toEqual({ from: 3, to: 7 });
  });
});

// ─── triggers ────────────────────────────────────────────────────────────────

describe("triggers", () => {
  it("does not open from a selection alone — update() never summons", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    expect(root(view)).not.toBeNull();
    expect(root(view).style.display).toBe("none");
  });

  it("opens on the mouseup settle tick", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    expect(root(view).style.display).toBe("");
    expect(selectionBubbleKey.getState(view.state)).toEqual({ from: 1, to: 6 });
  });

  it("opens on a shift-arrow keyup", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    view.dom.dispatchEvent(
      new KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true, bubbles: true }),
    );
    expect(root(view).style.display).toBe("");
  });

  it("ignores a keyup that is neither shift nor an arrow", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    view.dom.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
    expect(root(view).style.display).toBe("none");
  });

  it("closes on a mouseup that left the selection collapsed", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    await mouseup(view);
    expect(root(view).style.display).toBe("none");
    expect(selectionBubbleKey.getState(view.state)).toBeNull();
  });

  it("stays shut for a selection inside a code block", async () => {
    const view = mount(withCode(), { from: 14, to: 20 });
    await mouseup(view);
    expect(root(view).style.display).toBe("none");
  });

  it("typing hides a visible bubble", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    expect(root(view).style.display).toBe("");
    // What typing over a selection does: replace it, leaving a collapsed cursor.
    view.dispatch(view.state.tr.insertText("x"));
    expect(root(view).style.display).toBe("none");
    expect(selectionBubbleKey.getState(view.state)).toBeNull();
  });

  it("hides again when the selection collapses", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    expect(root(view).style.display).toBe("none");
  });

  it("stays hidden on mobile widths", async () => {
    // This jsdom has no matchMedia at all (the plugin's `typeof … !== "function"`
    // guard is what keeps every other test here alive), so install one.
    const mq = { matches: true, addEventListener() {}, removeEventListener() {} };
    vi.stubGlobal("matchMedia", () => mq as unknown as MediaQueryList);
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    expect(root(view).style.display).toBe("none");
  });
});

// ─── right-click ─────────────────────────────────────────────────────────────

describe("contextmenu", () => {
  it("over a selection opens the bubble at the pointer and takes the menu", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    const evt = contextmenu(view, 40, 120);
    expect(evt.defaultPrevented).toBe(true);
    expect(root(view).style.display).toBe("");
    // Placed from the pointer, so no coordsAtPos (which throws in jsdom) and
    // no zero-rect host offset: 120 - GAP.
    expect(root(view).style.top).toBe("114px");
  });

  it("over a collapsed cursor leaves the native menu alone", () => {
    const view = mount();
    const evt = contextmenu(view);
    expect(evt.defaultPrevented).toBe(false);
    expect(root(view).style.display).toBe("none");
  });

  it("inside a code block leaves the native menu alone", () => {
    const view = mount(withCode(), { from: 14, to: 20 });
    const evt = contextmenu(view);
    expect(evt.defaultPrevented).toBe(false);
    expect(root(view).style.display).toBe("none");
  });

  it("re-summons the bubble after an Escape", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    contextmenu(view);
    pressEscape(view);
    expect(root(view).style.display).toBe("none");
    contextmenu(view);
    expect(root(view).style.display).toBe("");
  });
});

// ─── Escape ──────────────────────────────────────────────────────────────────

describe("Escape", () => {
  it("closes an open popover first, and consumes the key", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    control(view, "Turn into").click();
    expect(control(view, "Turn into").getAttribute("aria-expanded")).toBe("true");

    const evt = pressEscape(view);
    expect(evt.defaultPrevented).toBe(true);
    expect(control(view, "Turn into").getAttribute("aria-expanded")).toBe("false");
    expect(root(view).style.display).toBe(""); // bubble itself survives
  });

  it("closes the bubble on the next Escape, clearing the anchor", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    const evt = pressEscape(view);
    expect(evt.defaultPrevented).toBe(true);
    expect(root(view).style.display).toBe("none");
    expect(selectionBubbleKey.getState(view.state)).toBeNull();
  });

  it("does not consume an Escape with neither popover nor bubble open", () => {
    // The case that protects the Sidebar's rail panel.
    const view = mount(hello(), { from: 1, to: 6 });
    const evt = pressEscape(view);
    expect(evt.defaultPrevented).toBe(false);
  });
});

// ─── commands ────────────────────────────────────────────────────────────────

describe("controls", () => {
  it("B toggles strong over the selected range and keeps the selection", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    control(view, "Bold").click();
    expect(view.state.doc.rangeHasMark(1, 6, strong)).toBe(true);
    expect(view.state.selection.from).toBe(1);
    expect(view.state.selection.to).toBe(6);
    expect(control(view, "Bold").classList.contains("active")).toBe(true);
    expect(control(view, "Bold").getAttribute("aria-pressed")).toBe("true");
    // The bubble outlives the command — the anchor mapped across its step.
    expect(root(view).style.display).toBe("");
  });

  it("a mousedown on the bubble is prevented so the selection survives", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    const evt = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    control(view, "Bold").dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("a swatch applies its slot colour and the remove swatch clears it", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    // The highlight commands end in `scrollIntoView()`, which sends the view
    // through coordsAtPos on dispatch — jsdom needs it answered.
    stubCoords(view);
    await mouseup(view);
    control(view, "Highlight").click();
    control(view, "Highlight color 2").click();
    expect(activeHighlightColor(view.state)).toBe("hl2");
    expect(view.state.doc.rangeHasMark(1, 6, highlight)).toBe(true);

    control(view, "Highlight").click();
    control(view, "Remove highlight").click();
    expect(activeHighlightColor(view.state)).toBeNull();
    expect(view.state.doc.rangeHasMark(1, 6, highlight)).toBe(false);
  });

  it("the trigger dot tracks activeHighlightColor", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    stubCoords(view);
    await mouseup(view);
    const dot = () => root(view).querySelector(".tb-hl-trigger-dot") as HTMLElement;
    expect(dot().classList.contains("tb-hl-none")).toBe(true);
    expect(dot().dataset.color).toBeUndefined();

    control(view, "Highlight").click();
    control(view, "Highlight color 3").click();
    expect(dot().classList.contains("tb-hl-none")).toBe(false);
    expect(dot().dataset.color).toBe("hl3");
    const current = root(view).querySelector(".tb-hl-swatch.current") as HTMLElement;
    expect(current.dataset.color).toBe("hl3");
  });

  it("opening one dropdown closes the other", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    const textTrigger = control(view, "Turn into");
    const linkTrigger = control(view, "Link");
    textTrigger.click();
    expect(textTrigger.getAttribute("aria-expanded")).toBe("true");
    linkTrigger.click();
    expect(textTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(linkTrigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("a Text ▾ row turns the block and closes the menu", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    control(view, "Turn into").click();
    const row = [...root(view).querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.startsWith("Heading 2"),
    )!;
    row.click();
    expect(view.state.doc.firstChild!.type).toBe(heading);
    expect(view.state.doc.firstChild!.attrs.level).toBe(2);
    expect(control(view, "Turn into").getAttribute("aria-expanded")).toBe("false");
  });
});

// ─── trigger label ───────────────────────────────────────────────────────────

describe("Text ▾ label", () => {
  const label = (view: EditorView) =>
    root(view).querySelector(".tb-trigger-label")!.textContent;

  it("reads Text in a paragraph", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    expect(label(view)).toBe("Text");
  });

  it("reads H2, and marks the matching row active", async () => {
    const d = doc.create(null, [heading.create({ level: 2 }, schema.text("Title"))]);
    const view = mount(d, { from: 1, to: 4 });
    await mouseup(view);
    expect(label(view)).toBe("H2");
    const active = root(view).querySelector(".tb-menu-item.active");
    expect(active!.textContent).toContain("Heading 2");
  });

  it("reads H5 even though no row matches — Text is the way out", async () => {
    const d = doc.create(null, [heading.create({ level: 5 }, schema.text("Deep"))]);
    const view = mount(d, { from: 1, to: 4 });
    await mouseup(view);
    expect(label(view)).toBe("H5");
    expect(root(view).querySelector(".tb-menu-item.active")).toBeNull();
  });
});

// ─── positioning ─────────────────────────────────────────────────────────────

describe("positioning", () => {
  it("does not throw without layout, and positions when coords exist", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    // No stub: coordsAtPos throws in jsdom. Shown, just not placed.
    await mouseup(view);
    expect(root(view).style.display).toBe("");
    expect(root(view).style.top).toBe("");

    stubCoords(view);
    bubbleOf(view).update(view, null);
    // host rect is all-zero in jsdom, so top is the stubbed line top minus the gap.
    expect(root(view).style.top).toBe("194px");
    expect(root(view).classList.contains("pm-sb-below")).toBe(false);
  });

  it("flips below when sitting above would collide with the sticky toolbar", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    // jsdom reports every offset as 0; the flip needs a real height to decide.
    Object.defineProperty(root(view), "offsetHeight", { value: 38, configurable: true });
    vi.spyOn(view, "coordsAtPos").mockReturnValue({
      left: 100,
      right: 100,
      top: 20,
      bottom: 36,
    });
    await mouseup(view);
    expect(root(view).classList.contains("pm-sb-below")).toBe(true);
    // Below the selection's line bottom, plus the gap.
    expect(root(view).style.top).toBe("42px");
  });
});

// ─── lifecycle ───────────────────────────────────────────────────────────────

describe("lifecycle", () => {
  it("update() early-returns when neither doc, selection nor anchor changed", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    const bubble = bubbleOf(view);
    const coords = stubCoords(view);
    bubble.update(view, view.state);
    expect(coords).not.toHaveBeenCalled();
    bubble.update(view, null);
    expect(coords).toHaveBeenCalled();
  });

  it("destroy() removes the root and drains every listener", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    const bubble = bubbleOf(view);
    const listeners = (bubble as unknown as { listeners: unknown[] }).listeners;
    expect(listeners.length).toBeGreaterThan(0);
    expect(root(view)).not.toBeNull();

    bubble.destroy();
    expect(root(view)).toBeNull();
    expect((bubble as unknown as { listeners: unknown[] }).listeners).toHaveLength(0);
    expect(selectionBubbleViewFor(view)).toBeUndefined();
  });

  it("close() hides the bubble and clears the stored anchor", async () => {
    const view = mount(hello(), { from: 1, to: 6 });
    await mouseup(view);
    bubbleOf(view).close();
    expect(root(view).style.display).toBe("none");
    expect(selectionBubbleKey.getState(view.state)).toBeNull();
  });

  it("no-ops when the editor view has no parent to anchor to", () => {
    const state = EditorState.create({ doc: hello(), plugins: [selectionBubblePlugin()] });
    const view = new EditorView(null, { state });
    expect(view.dom.parentElement).toBeNull();
    expect(() => view.dispatch(view.state.tr.insertText("x", 1))).not.toThrow();
    view.destroy();
  });
});
