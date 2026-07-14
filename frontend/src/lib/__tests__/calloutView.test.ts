// @feat callout: NodeView tests — kind class/icon render, picker open/close
// (Escape + outside-click), kind-row setNodeMarkup + restyle, Quote/Remove rows,
// and the empty-title placeholder data attribute.
/**
 * NodeView tests for the callout kind picker + rendering. Mounts a real
 * `EditorView` into `document.body` (the isConnected gotcha, frontend/CLAUDE.md)
 * with the callout NodeView registered, drives the icon-button picker, and
 * asserts on the doc model + the chrome DOM. Views are destroyed per test.
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState, Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import { CalloutView } from "../calloutView";

const { doc, paragraph, callout, callout_title } = schema.nodes;
const mounted: EditorView[] = [];

function mount(kind: string, title = "", body = "body") {
  const c = callout.create({ kind }, [
    callout_title.create(null, title ? schema.text(title) : []),
    paragraph.create(null, body ? schema.text(body) : []),
  ]);
  const d = doc.create(null, [c]);
  const place = document.createElement("div");
  place.className = "editor-host";
  document.body.appendChild(place);
  const view = new EditorView(place, {
    state: EditorState.create({ doc: d, selection: Selection.atEnd(d) }),
    nodeViews: {
      callout: (node, v, getPos) => new CalloutView(node, v, getPos as () => number | undefined),
    },
  });
  mounted.push(view);
  return view;
}

const btn = (view: EditorView) => view.dom.querySelector(".pm-callout-kind") as HTMLButtonElement;
const popup = (view: EditorView) => view.dom.querySelector(".pm-callout-kind-popup") as HTMLDivElement;
const isOpen = (view: EditorView) => popup(view).classList.contains("pm-callout-kind-popup--open");
const items = (view: EditorView) =>
  [...view.dom.querySelectorAll(".pm-callout-kind-item")] as HTMLButtonElement[];
const rowByLabel = (view: EditorView, label: string) =>
  items(view).find((el) => el.textContent?.includes(label))!;

describe("CalloutView rendering", () => {
  afterEach(() => {
    for (const v of mounted.splice(0)) v.destroy();
  });

  it("renders the kind class, data attr and an icon", () => {
    const view = mount("warning");
    const el = view.dom.querySelector(".pm-callout") as HTMLElement;
    expect(el.classList.contains("pm-callout--warning")).toBe(true);
    expect(el.getAttribute("data-callout")).toBe("warning");
    expect(btn(view).querySelector("svg")).not.toBeNull();
  });

  it("stamps the kind label on an empty title for the CSS placeholder", async () => {
    const view = mount("tip", "");
    await Promise.resolve(); // constructor stamps via a microtask
    const title = view.dom.querySelector(".pm-callout-title") as HTMLElement;
    expect(title.getAttribute("data-kind-label")).toBe("Tip");
  });

  it("clamps an unknown kind to note", () => {
    const view = mount("bogus");
    const el = view.dom.querySelector(".pm-callout") as HTMLElement;
    expect(el.classList.contains("pm-callout--note")).toBe(true);
  });
});

describe("CalloutView kind picker", () => {
  afterEach(() => {
    for (const v of mounted.splice(0)) v.destroy();
  });

  it("opens with 5 kind rows (current checked) + Quote + Remove", () => {
    const view = mount("note");
    btn(view).click();
    expect(isOpen(view)).toBe(true);
    // 5 kinds + Quote + Remove = 7 rows.
    expect(items(view).length).toBe(7);
    const checked = view.dom.querySelectorAll(".pm-callout-kind-item--checked");
    expect(checked.length).toBe(1);
    expect((checked[0] as HTMLElement).textContent).toContain("Note");
    expect(rowByLabel(view, "Quote")).toBeTruthy();
    expect(rowByLabel(view, "Remove callout")).toBeTruthy();
  });

  it("a kind row dispatches setNodeMarkup and update() swaps the class", () => {
    const view = mount("note");
    btn(view).click();
    rowByLabel(view, "Important").click();
    expect(view.state.doc.firstChild!.attrs.kind).toBe("important");
    const el = view.dom.querySelector(".pm-callout") as HTMLElement;
    expect(el.classList.contains("pm-callout--important")).toBe(true);
    expect(el.classList.contains("pm-callout--note")).toBe(false);
    // Selecting closes the picker.
    expect(isOpen(view)).toBe(false);
  });

  it("Escape and outside-click both close the picker across repeated cycles", () => {
    const view = mount("note");
    btn(view).click();
    expect(isOpen(view)).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(isOpen(view)).toBe(false);

    btn(view).click();
    expect(isOpen(view)).toBe(true);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(isOpen(view)).toBe(false);
  });

  it("the Quote row demotes the callout to a blockquote", () => {
    const view = mount("note", "T", "body");
    btn(view).click();
    rowByLabel(view, "Quote").click();
    const top = view.state.doc.firstChild!;
    expect(top.type.name).toBe("blockquote");
    // Non-empty title preserved as the first paragraph.
    expect(top.child(0).textContent).toBe("T");
  });

  it("the Remove callout row unwraps the callout", () => {
    const view = mount("note", "", "body");
    btn(view).click();
    rowByLabel(view, "Remove callout").click();
    expect(view.state.doc.firstChild!.type.name).toBe("paragraph");
    expect(view.state.doc.firstChild!.textContent).toBe("body");
  });

  it("does not open the picker in view mode", () => {
    const view = mount("note");
    view.setProps({ editable: () => false });
    btn(view).click();
    expect(isOpen(view)).toBe(false);
  });
});
