// @feat toggle-list: NodeView tests — bare-<li> bullet fast path, chevron
// render, shared collapse over setNodeMarkup, read-only local-only fold
// (dispatch spy asserts NO step), in-place remote collapse (same element
// identity), caret rescue out of a collapsing child list, and the deny-list
// ignoreMutation regression.
/**
 * NodeView tests for `ListItemView`. Mounts a real `EditorView` into
 * `document.body` (the isConnected gotcha, frontend/CLAUDE.md) with the
 * list_item NodeView registered, drives the chevron, and asserts on the doc
 * model plus the chrome DOM. Views are destroyed per test.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState, Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import type { ViewMutationRecord } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import { ListItemView } from "../listItemView";

const { doc, paragraph, bullet_list, list_item } = schema.nodes;

const mounted: EditorView[] = [];
let instances: ListItemView[] = [];

/** One list item: a summary paragraph plus an optional nested bullet list. */
function item(
  attrs: { kind?: string; collapsed?: boolean } | null,
  text: string,
  children: string[] = [],
): PMNode {
  const content: PMNode[] = [paragraph.create(null, text ? schema.text(text) : [])];
  if (children.length) {
    content.push(
      bullet_list.create(
        null,
        children.map((c) => list_item.create(null, [paragraph.create(null, schema.text(c))])),
      ),
    );
  }
  return list_item.create(attrs, content);
}

function mount(items: PMNode[]) {
  const d = doc.create(null, [bullet_list.create(null, items)]);
  const place = document.createElement("div");
  place.className = "editor-host";
  document.body.appendChild(place);
  const view = new EditorView(place, {
    state: EditorState.create({ doc: d, selection: Selection.atEnd(d) }),
    nodeViews: {
      list_item: (node, v, getPos) => {
        const nv = new ListItemView(node, v, getPos as () => number | undefined);
        instances.push(nv);
        return nv;
      },
    },
  });
  mounted.push(view);
  return view;
}

const chevron = (view: EditorView) =>
  view.dom.querySelector(".pm-list-toggle") as HTMLButtonElement;
const toggleLi = (view: EditorView) =>
  view.dom.querySelector('li[data-kind="toggle"]') as HTMLLIElement;
/** The first list item's position: the bullet_list opens at 0. */
const FIRST_ITEM_POS = 1;
const firstItem = (view: EditorView) => view.state.doc.firstChild!.firstChild!;

afterEach(() => {
  for (const v of mounted.splice(0)) v.destroy();
  instances = [];
});

describe("ListItemView rendering", () => {
  it("renders a bullet as a bare <li> with no chrome", () => {
    const view = mount([item(null, "plain")]);
    const li = view.dom.querySelector("li") as HTMLLIElement;
    expect(li.querySelector(".pm-list-toggle")).toBeNull();
    expect(li.hasAttribute("data-kind")).toBe(false);
    expect(li.hasAttribute("data-collapsed")).toBe(false);
    expect(li.className).toBe("");
    // contentDOM IS the <li> — the paragraph is a direct child, exactly what
    // toDOM emits, so pre-existing documents render byte-identically.
    expect(li.firstElementChild!.tagName).toBe("P");
    expect(li.firstElementChild!.textContent).toBe("plain");
  });

  it("renders a toggle with a chevron outside contentDOM, expanded by default", () => {
    const view = mount([item({ kind: "toggle" }, "summary")]);
    const li = toggleLi(view);
    expect(li).not.toBeNull();
    expect(chevron(view).querySelector("svg")).not.toBeNull();
    expect(chevron(view).getAttribute("aria-expanded")).toBe("true");
    expect(li.hasAttribute("data-collapsed")).toBe(false);
    // Chrome sits beside contentDOM, never inside it.
    const content = li.querySelector(".pm-list-item-content") as HTMLElement;
    expect(content.querySelector(".pm-list-toggle")).toBeNull();
    expect(content.firstElementChild!.textContent).toBe("summary");
  });

  it("renders an already-collapsed toggle from the shared attr", () => {
    const view = mount([item({ kind: "toggle", collapsed: true }, "summary", ["child"])]);
    expect(toggleLi(view).getAttribute("data-collapsed")).toBe("true");
    expect(chevron(view).getAttribute("aria-expanded")).toBe("false");
    // Children stay in the DOM — the fold is CSS-only.
    expect(toggleLi(view).querySelector("ul")).not.toBeNull();
  });
});

describe("ListItemView collapse", () => {
  it("an editable chevron click dispatches setNodeMarkup and touches no other attr", () => {
    const view = mount([item({ kind: "toggle" }, "summary", ["child"])]);
    chevron(view).click();
    expect(firstItem(view).attrs).toEqual({ kind: "toggle", collapsed: true });
    expect(toggleLi(view).getAttribute("data-collapsed")).toBe("true");
    expect(chevron(view).getAttribute("aria-expanded")).toBe("false");
    // And back.
    chevron(view).click();
    expect(firstItem(view).attrs).toEqual({ kind: "toggle", collapsed: false });
    expect(toggleLi(view).hasAttribute("data-collapsed")).toBe(false);
  });

  it("a read-only chevron click dispatches NOTHING and folds locally", () => {
    // Load-bearing: SSE is gated on paper-view, not paper-edit, so a viewer
    // handed a collapsed toggle must be able to open it without a step.
    const view = mount([item({ kind: "toggle", collapsed: true }, "summary", ["child"])]);
    view.setProps({ editable: () => false });
    const before = view.state;
    const spy = vi.spyOn(view, "dispatch");

    chevron(view).click();

    expect(spy).not.toHaveBeenCalled();
    expect(view.state).toBe(before);
    expect(firstItem(view).attrs.collapsed).toBe(true); // shared attr untouched
    // …but this viewer now sees it expanded.
    expect(toggleLi(view).hasAttribute("data-collapsed")).toBe(false);
    expect(chevron(view).getAttribute("aria-expanded")).toBe("true");
    spy.mockRestore();
  });

  it("a remote collapse flip re-renders the SAME element (no rebuild)", () => {
    const view = mount([item({ kind: "toggle" }, "summary", ["child"])]);
    const before = toggleLi(view);
    const beforeChevron = chevron(view);

    // Simulate a peer's step arriving.
    view.dispatch(
      view.state.tr.setNodeMarkup(FIRST_ITEM_POS, undefined, {
        ...firstItem(view).attrs,
        collapsed: true,
      }),
    );

    expect(toggleLi(view)).toBe(before);
    expect(chevron(view)).toBe(beforeChevron);
    expect(before.getAttribute("data-collapsed")).toBe("true");
    expect(beforeChevron.getAttribute("aria-expanded")).toBe("false");
  });

  it("a remote update does not clobber a read-only viewer's local override", () => {
    // applyClasses() runs off isCollapsed() (override ?? attr), so an unrelated
    // remote update must not re-fold a viewer who expanded locally.
    const view = mount([item({ kind: "toggle", collapsed: true }, "summary", ["child"])]);
    view.setProps({ editable: () => false });
    chevron(view).click(); // local expand
    expect(toggleLi(view).hasAttribute("data-collapsed")).toBe(false);

    view.dispatch(
      view.state.tr.setNodeMarkup(FIRST_ITEM_POS, undefined, {
        ...firstItem(view).attrs,
        collapsed: true,
      }),
    );
    expect(firstItem(view).attrs.collapsed).toBe(true);
    expect(toggleLi(view).hasAttribute("data-collapsed")).toBe(false);
  });

  it("a kind flip re-renders through the one applyClasses path", () => {
    // Only two kinds exist and `bullet` is chrome-less, so a kind flip swaps
    // DOM shapes (update() returns false, PM rebuilds). What must hold is that
    // kind and collapse always render together — never one clobbering the
    // other, which is why there is a single applyClasses().
    const view = mount([item({ kind: "toggle", collapsed: true }, "summary", ["child"])]);
    view.dispatch(
      view.state.tr.setNodeMarkup(FIRST_ITEM_POS, undefined, {
        kind: "bullet",
        collapsed: true,
      }),
    );
    expect(view.dom.querySelector(".pm-list-toggle")).toBeNull();
    expect(view.dom.querySelector("li")!.hasAttribute("data-collapsed")).toBe(false);

    view.dispatch(
      view.state.tr.setNodeMarkup(FIRST_ITEM_POS, undefined, {
        kind: "toggle",
        collapsed: true,
      }),
    );
    expect(toggleLi(view).getAttribute("data-collapsed")).toBe("true");
    expect(chevron(view).getAttribute("aria-expanded")).toBe("false");
  });

  it("rescues the caret out of a child list that is about to be hidden", () => {
    const view = mount([item({ kind: "toggle" }, "summary", ["child"])]);
    // Selection.atEnd puts the caret in the nested child's paragraph.
    expect(view.state.selection.$from.parent.textContent).toBe("child");

    chevron(view).click();

    expect(firstItem(view).attrs.collapsed).toBe(true);
    // Moved onto the item's own (still-visible) paragraph.
    expect(view.state.selection.$from.parent.textContent).toBe("summary");
  });

  it("leaves a caret already in the summary alone when collapsing", () => {
    const view = mount([item({ kind: "toggle" }, "summary", ["child"])]);
    const summaryEnd = FIRST_ITEM_POS + 1 + "summary".length;
    view.dispatch(
      view.state.tr.setSelection(Selection.near(view.state.doc.resolve(summaryEnd), -1)),
    );
    const before = view.state.selection.from;

    chevron(view).click();

    expect(view.state.selection.from).toBe(before);
    expect(view.state.selection.$from.parent.textContent).toBe("summary");
  });
});

describe("ListItemView ignoreMutation", () => {
  it("ignores mutations on the NodeView root itself, not just the chevron", () => {
    // Deny-list regression (calloutView.ts:344-356): applyClasses() mutates
    // `this.dom`'s className/data attrs, which the chevron does not *contain*.
    // An allow-list form would let PM's observer see an unexplained change on
    // the root and self-heal by destroying + rebuilding the view.
    mount([item({ kind: "toggle" }, "summary", ["child"])]);
    const nv = instances.find((v) => v.contentDOM !== v.dom)!;
    const record = (target: Node) =>
      ({ type: "attributes", target, attributeName: "class" }) as unknown as ViewMutationRecord;

    expect(nv.ignoreMutation(record(nv.dom))).toBe(true);
    expect(nv.ignoreMutation(record(nv.dom.querySelector(".pm-list-toggle")!))).toBe(true);
    // Real PM-managed content is NOT ignored.
    expect(nv.ignoreMutation(record(nv.contentDOM))).toBe(false);
    expect(nv.ignoreMutation(record(nv.contentDOM.querySelector("p")!))).toBe(false);
  });

  it("ignores nothing on the bullet fast path (dom === contentDOM)", () => {
    const view = mount([item(null, "plain")]);
    const nv = instances[0];
    expect(nv.contentDOM).toBe(nv.dom);
    expect(
      nv.ignoreMutation({
        type: "attributes",
        target: nv.dom,
        attributeName: "class",
      } as unknown as ViewMutationRecord),
    ).toBe(false);
    expect(view.dom.querySelector(".pm-list-toggle")).toBeNull();
  });
});

describe("ListItemView stopEvent", () => {
  it("swallows chevron events only", () => {
    mount([item({ kind: "toggle" }, "summary")]);
    const nv = instances.find((v) => v.contentDOM !== v.dom)!;
    const ev = (target: Node) => ({ target }) as unknown as Event;
    expect(nv.stopEvent(ev(nv.dom.querySelector(".pm-list-toggle")!))).toBe(true);
    expect(nv.stopEvent(ev(nv.contentDOM))).toBe(false);
  });

  it("swallows nothing on a bullet", () => {
    mount([item(null, "plain")]);
    const nv = instances[0];
    expect(nv.stopEvent({ target: nv.dom } as unknown as Event)).toBe(false);
  });
});
