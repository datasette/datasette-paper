/**
 * Selection bubble (`selectionBubble.ts`): the mapped anchor in plugin state,
 * the show/hide gate, the controls' commands, and teardown.
 *
 * jsdom has no layout — `coordsAtPos` throws (no `getClientRects`) and every
 * `offset*` reads 0 — so the positioning path must *degrade*, not throw; the
 * tests that care about it stub `coordsAtPos` explicitly. The view class is
 * driven directly where a test needs a handle on the instance (ProseMirror
 * doesn't expose plugin views), otherwise through the plugin, mounted the way
 * production does: an `EditorView` inside an `.editor-host` parent.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState, Selection, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import { activeHighlightColor } from "../highlight";
import {
  SelectionBubbleView,
  selectionBubbleKey,
  selectionBubblePlugin,
  type BubbleAnchor,
} from "../selectionBubble";

const { doc, paragraph, heading } = schema.nodes;
const { strong, highlight } = schema.marks;

const mounted: EditorView[] = [];
const hosts: HTMLElement[] = [];

/** `doc(paragraph("Hello world"))` — text occupies positions 1..12. */
function hello(): PMNode {
  return doc.create(null, [paragraph.create(null, schema.text("Hello world"))]);
}

function mount(
  d: PMNode = hello(),
  sel?: { from: number; to: number },
  opts: { plugin?: boolean } = {},
): EditorView {
  const host = document.createElement("div");
  host.className = "editor-host";
  document.body.appendChild(host);
  hosts.push(host);
  const state = EditorState.create({
    doc: d,
    selection: sel ? TextSelection.create(d, sel.from, sel.to) : Selection.atStart(d),
    plugins: opts.plugin === false ? [] : [selectionBubblePlugin()],
  });
  const view = new EditorView(host, { state });
  mounted.push(view);
  return view;
}

const root = (view: EditorView): HTMLElement =>
  view.dom.parentElement!.querySelector(".pm-selection-bubble") as HTMLElement;

const control = (view: EditorView, label: string): HTMLButtonElement =>
  root(view).querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;

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

// ─── plugin state ────────────────────────────────────────────────────────────

describe("selectionBubbleKey.apply", () => {
  /** A state carrying `anchor`, with no view attached. */
  function anchored(anchor: BubbleAnchor): EditorState {
    const state = EditorState.create({
      doc: hello(),
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
    const next = state.apply(state.tr.insertText("x", 7).insertText("y", 3));
    expect(selectionBubbleKey.getState(next)).toEqual({ from: 4, to: 8 });
  });

  it("drops the anchor when a collaborator deletes the span", () => {
    const state = anchored({ from: 3, to: 7 });
    const next = state.apply(state.tr.delete(3, 7));
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

// ─── show / hide ─────────────────────────────────────────────────────────────

describe("visibility", () => {
  it("shows for a non-empty text selection", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    expect(root(view)).not.toBeNull();
    expect(root(view).style.display).toBe("");
  });

  it("stays hidden for a collapsed cursor", () => {
    const view = mount();
    expect(root(view).style.display).toBe("none");
  });

  it("hides again when the selection collapses", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    expect(root(view).style.display).toBe("none");
  });

  it("stays hidden on mobile widths", () => {
    // This jsdom has no matchMedia at all (the plugin's `typeof … !== "function"`
    // guard is what keeps every other test here alive), so install one.
    const mq = { matches: true, addEventListener() {}, removeEventListener() {} };
    vi.stubGlobal("matchMedia", () => mq as unknown as MediaQueryList);
    const view = mount(hello(), { from: 1, to: 6 });
    expect(root(view).style.display).toBe("none");
  });

  it("does not throw without layout, and positions when coords exist", () => {
    const view = mount(hello(), { from: 1, to: 6 }, { plugin: false });
    const bubble = new SelectionBubbleView(view);
    // No stub: coordsAtPos throws in jsdom. Shown, just not placed.
    expect(() => bubble.update(view, null)).not.toThrow();
    expect(root(view).style.top).toBe("");

    stubCoords(view);
    bubble.update(view, null);
    // host rect is all-zero in jsdom, so top is the stubbed line top minus the gap.
    expect(root(view).style.top).toBe("194px");
    expect(root(view).classList.contains("pm-sb-below")).toBe(false);
    bubble.destroy();
  });

  it("flips below when sitting above would collide with the sticky toolbar", () => {
    const view = mount(hello(), { from: 1, to: 6 }, { plugin: false });
    const bubble = new SelectionBubbleView(view);
    // jsdom reports every offset as 0; the flip needs a real height to decide.
    Object.defineProperty(root(view), "offsetHeight", { value: 38, configurable: true });
    vi.spyOn(view, "coordsAtPos").mockReturnValue({
      left: 100,
      right: 100,
      top: 20,
      bottom: 36,
    });
    bubble.update(view, null);
    expect(root(view).classList.contains("pm-sb-below")).toBe(true);
    // Below the selection's line bottom, plus the gap.
    expect(root(view).style.top).toBe("42px");
    bubble.destroy();
  });
});

// ─── commands ────────────────────────────────────────────────────────────────

describe("controls", () => {
  it("B toggles strong over the selected range and keeps the selection", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    control(view, "Bold").click();
    expect(view.state.doc.rangeHasMark(1, 6, strong)).toBe(true);
    expect(view.state.selection.from).toBe(1);
    expect(view.state.selection.to).toBe(6);
    expect(control(view, "Bold").classList.contains("active")).toBe(true);
    expect(control(view, "Bold").getAttribute("aria-pressed")).toBe("true");
  });

  it("a mousedown on the bubble is prevented so the selection survives", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    const evt = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    control(view, "Bold").dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("a swatch applies its slot colour and the remove swatch clears it", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    // The highlight commands end in `scrollIntoView()`, which sends the view
    // through coordsAtPos on dispatch — jsdom needs it answered.
    stubCoords(view);
    control(view, "Highlight").click();
    control(view, "Highlight color 2").click();
    expect(activeHighlightColor(view.state)).toBe("hl2");
    expect(view.state.doc.rangeHasMark(1, 6, highlight)).toBe(true);

    control(view, "Highlight").click();
    control(view, "Remove highlight").click();
    expect(activeHighlightColor(view.state)).toBeNull();
    expect(view.state.doc.rangeHasMark(1, 6, highlight)).toBe(false);
  });

  it("the trigger dot tracks activeHighlightColor", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    stubCoords(view);
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

  it("opening one dropdown closes the other", () => {
    const view = mount(hello(), { from: 1, to: 6 });
    const textTrigger = control(view, "Turn into");
    const linkTrigger = control(view, "Link");
    textTrigger.click();
    expect(textTrigger.getAttribute("aria-expanded")).toBe("true");
    linkTrigger.click();
    expect(textTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(linkTrigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("a Text ▾ row turns the block and closes the menu", () => {
    const view = mount(hello(), { from: 1, to: 6 });
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

  it("reads Text in a paragraph", () => {
    expect(label(mount(hello(), { from: 1, to: 6 }))).toBe("Text");
  });

  it("reads H2, and marks the matching row active", () => {
    const d = doc.create(null, [heading.create({ level: 2 }, schema.text("Title"))]);
    const view = mount(d, { from: 1, to: 4 });
    expect(label(view)).toBe("H2");
    const active = root(view).querySelector(".tb-menu-item.active");
    expect(active!.textContent).toContain("Heading 2");
  });

  it("reads H5 even though no row matches — Text is the way out", () => {
    const d = doc.create(null, [heading.create({ level: 5 }, schema.text("Deep"))]);
    const view = mount(d, { from: 1, to: 4 });
    expect(label(view)).toBe("H5");
    expect(root(view).querySelector(".tb-menu-item.active")).toBeNull();
  });
});

// ─── lifecycle ───────────────────────────────────────────────────────────────

describe("lifecycle", () => {
  it("update() early-returns when neither doc nor selection changed", () => {
    const view = mount(hello(), { from: 1, to: 6 }, { plugin: false });
    const bubble = new SelectionBubbleView(view);
    const coords = stubCoords(view);
    bubble.update(view, view.state);
    expect(coords).not.toHaveBeenCalled();
    bubble.update(view, null);
    expect(coords).toHaveBeenCalled();
    bubble.destroy();
  });

  it("destroy() removes the root and drains every listener", () => {
    const view = mount(hello(), { from: 1, to: 6 }, { plugin: false });
    const bubble = new SelectionBubbleView(view);
    const listeners = (bubble as unknown as { listeners: unknown[] }).listeners;
    expect(listeners.length).toBeGreaterThan(0);
    expect(root(view)).not.toBeNull();

    bubble.destroy();
    expect(root(view)).toBeNull();
    expect((bubble as unknown as { listeners: unknown[] }).listeners).toHaveLength(0);
  });

  it("close() hides the bubble and clears the stored anchor", () => {
    const view = mount(hello(), { from: 1, to: 6 }, { plugin: false });
    const bubble = new SelectionBubbleView(view);
    bubble.close();
    expect(root(view).style.display).toBe("none");
    bubble.destroy();
  });

  it("no-ops when the editor view has no parent to anchor to", () => {
    const state = EditorState.create({ doc: hello(), plugins: [selectionBubblePlugin()] });
    const view = new EditorView(null, { state });
    expect(view.dom.parentElement).toBeNull();
    expect(() => view.dispatch(view.state.tr.insertText("x", 1))).not.toThrow();
    view.destroy();
  });
});
