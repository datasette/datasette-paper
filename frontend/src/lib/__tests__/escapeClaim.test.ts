/**
 * Escape claim for NodeView menus (plans/shortcuts ticket 06). Each menu's
 * capture-phase document keydown listener must *claim* the Escape that closes
 * it: `preventDefault()` so ProseMirror's `Escape: selectParentNode` doesn't
 * also run (focus in editor content — WebKit doesn't focus a clicked button),
 * and `stopPropagation()` so page-level window listeners (the Sidebar panel)
 * don't close too (focus on the menu's own control). Browser-verified leaks;
 * see calloutView.ts for the pattern these mirror.
 *
 * Every view is mounted in a real EditorView attached to document.body with a
 * keymap binding Escape to selectParentNode, as buildKeymap does in the app.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { EditorView, type NodeViewConstructor } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { selectParentNode } from "prosemirror-commands";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import { TocView } from "../tocView";
import { CodeBlockView } from "../codeBlockView";
import { BlockEmbedView } from "../blockEmbedView";
import { SqlBlockView } from "../sqlBlockView";
import { ValueView } from "../valueView";
import type { SourceStore, SourceState } from "../sourceStore";

type AnyView = { destroy(): void };

interface Case {
  name: string;
  nodeName: string;
  node: () => PMNode;
  inline?: boolean;
  make: (node: PMNode, view: EditorView, getPos: () => number | undefined) => AnyView;
  /** Open the menu; returns the control focus sits on in Chromium (null = none). */
  open: (view: EditorView) => HTMLElement | null;
  isOpen: (view: EditorView) => boolean;
  closeMethod: string;
  /** A focusable control *inside* the open menu (hidden once it closes). */
  inner: (view: EditorView) => HTMLElement | null;
}

const okStore: SourceStore = {
  subscribe(_name: string, cb: (s: SourceState) => void) {
    cb({ status: "ok", columns: ["n"], row: [30] } as SourceState);
    return () => {};
  },
  getState: () => ({ status: "ok", columns: ["n"], row: [30] }) as SourceState,
  sourceNames: () => ["vendors"],
  sync() {},
} as unknown as SourceStore;

const q = <T extends Element>(view: EditorView, sel: string) =>
  view.dom.querySelector(sel) as T;

const CASES: Case[] = [
  {
    name: "toc ⋮ menu",
    nodeName: "toc",
    node: () => schema.nodes.toc.create(),
    make: (n, v, p) => new TocView(n, v, p),
    open: (view) => {
      const btn = q<HTMLButtonElement>(view, ".pm-toc-menu-btn");
      btn.click();
      return btn;
    },
    isOpen: (view) => !!view.dom.querySelector(".pm-toc-menu--open"),
    closeMethod: "closeMenu",
    inner: (view) => q<HTMLInputElement>(view, ".pm-toc-menu input"),
  },
  {
    name: "code block language picker",
    nodeName: "code_block",
    node: () => schema.nodes.code_block.create({ language: "python" }, schema.text("x = 1")),
    make: (n, v, p) => new CodeBlockView(n, v, p),
    open: (view) => {
      q<HTMLButtonElement>(view, ".pm-code-block-lang-btn").click();
      return q<HTMLInputElement>(view, ".pm-code-block-lang-input");
    },
    isOpen: (view) => !!view.dom.querySelector(".pm-code-block-lang-popup--open"),
    closeMethod: "closePicker",
    inner: (view) => q<HTMLInputElement>(view, ".pm-code-block-lang-input"),
  },
  {
    name: "block embed ⋮ menu",
    nodeName: "block_embed",
    node: () => schema.nodes.block_embed.create({ ref: "/data/vendors" }),
    make: (n, v, p) => new BlockEmbedView(n, v, p),
    open: (view) => {
      const btn = q<HTMLButtonElement>(view, ".pm-block-embed-menu-btn");
      btn.click();
      return btn;
    },
    isOpen: (view) => !!view.dom.querySelector(".pm-block-embed-menu--open"),
    closeMethod: "closeMenu",
    inner: (view) => q<HTMLButtonElement>(view, ".pm-block-embed-menu-item"),
  },
  {
    name: "SQL block ⋮ menu",
    nodeName: "sql_block",
    node: () => schema.nodes.sql_block.create({ db: "data" }, schema.text("select 1")),
    make: (n, v, p) => new SqlBlockView(n, v, p),
    open: (view) => {
      const btn = q<HTMLButtonElement>(view, ".pm-sql-block-menu-btn");
      btn.click();
      return btn;
    },
    isOpen: (view) => !!view.dom.querySelector(".pm-sql-block-menu--open"),
    closeMethod: "closeMenu",
    inner: (view) => q<HTMLButtonElement>(view, ".pm-sql-block-menu-item"),
  },
  {
    name: "value popover",
    nodeName: "value",
    inline: true,
    node: () => schema.nodes.value.create({ source: "vendors", column: "n" }),
    make: (n, v, p) => new ValueView(n, v, p, okStore),
    open: (view) => {
      q<HTMLElement>(view, ".pm-value").dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
      return q<HTMLSelectElement>(view, ".pm-value-popover select");
    },
    isOpen: (view) => !!view.dom.querySelector(".pm-value-popover"),
    closeMethod: "closePopover",
    inner: (view) => q<HTMLSelectElement>(view, ".pm-value-popover select"),
  },
];

const mounted: EditorView[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).startsWith("/.json")
          ? { databases: [{ name: "data" }] }
          : { columns: ["id"], rows: [[1]], count: 1, ok: true },
    })),
  );
}

async function mount(c: Case) {
  stubFetch();
  const instances: AnyView[] = [];
  const intro = schema.nodes.paragraph.create(null, schema.text("Intro paragraph"));
  const blocks = c.inline
    ? [intro, schema.nodes.paragraph.create(null, [schema.text("We have "), c.node()])]
    : [intro, c.node()];
  const doc = schema.node("doc", null, blocks);
  const place = document.createElement("div");
  document.body.appendChild(place);
  const factory: NodeViewConstructor = (node, v, getPos) => {
    const inst = c.make(node, v, getPos as () => number | undefined);
    instances.push(inst);
    return inst as never;
  };
  const view = new EditorView(place, {
    state: EditorState.create({
      doc,
      // Caret inside "Intro paragraph" — the app state when a menu is clicked.
      selection: TextSelection.create(doc, 3),
      plugins: [keymap({ Escape: selectParentNode })],
    }),
    nodeViews: { [c.nodeName]: factory },
  });
  mounted.push(view);
  // Let async loads (block embed / SQL fetch) settle and render their chrome.
  await new Promise((r) => setTimeout(r, 0));
  return { view, instances };
}

function escape(target: EventTarget): KeyboardEvent {
  const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

let windowSpy: ReturnType<typeof vi.fn<(e: KeyboardEvent) => void>>;

afterEach(() => {
  window.removeEventListener("keydown", windowSpy);
  for (const v of mounted.splice(0)) {
    v.destroy();
    v.dom.parentElement?.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(CASES)("$name: Escape is claimed", (c) => {
  function spyWindow() {
    windowSpy = vi.fn<(e: KeyboardEvent) => void>();
    window.addEventListener("keydown", windowSpy);
  }

  it("focus in editor content: closes, preventDefaults, no NodeSelection, no window listener", async () => {
    const { view } = await mount(c);
    c.open(view);
    expect(c.isOpen(view)).toBe(true);
    spyWindow();

    const ev = escape(view.dom);

    expect(c.isOpen(view)).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
    expect(view.state.selection).not.toBeInstanceOf(NodeSelection);
    expect(windowSpy).not.toHaveBeenCalled();
  });

  it("focus on the menu's control: closes, preventDefaults, no window listener", async () => {
    const { view } = await mount(c);
    const control = c.open(view);
    expect(control).toBeTruthy();
    control!.focus();
    spyWindow();

    const ev = escape(control!);

    expect(c.isOpen(view)).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
    expect(view.state.selection).not.toBeInstanceOf(NodeSelection);
    expect(windowSpy).not.toHaveBeenCalled();
  });

  it("focus inside the menu: closes and returns focus to the editor", async () => {
    const { view } = await mount(c);
    c.open(view);
    const inner = c.inner(view);
    expect(inner).toBeTruthy();
    inner!.focus();
    expect(document.activeElement).toBe(inner);

    const ev = escape(inner!);

    expect(c.isOpen(view)).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
    expect(view.dom.contains(document.activeElement)).toBe(true);
    expect(c.isOpen(view) || !inner!.isConnected || document.activeElement !== inner).toBe(true);
  });

  it("teardown: destroying the NodeView with its menu open removes the listener", async () => {
    const { view, instances } = await mount(c);
    c.open(view);
    expect(c.isOpen(view)).toBe(true);
    const inst = instances[instances.length - 1];

    // Delete the node: PM destroys the NodeView.
    const { doc } = view.state;
    let from = -1;
    let to = -1;
    doc.descendants((n, pos) => {
      if (n.type.name === c.nodeName) {
        from = pos;
        to = pos + n.nodeSize;
      }
    });
    view.dispatch(view.state.tr.delete(from, to));
    expect(view.dom.querySelector(`.pm-${c.nodeName.replace("_", "-")}`)).toBeNull();

    const close = vi.spyOn(inst as never, c.closeMethod as never);
    let ev!: KeyboardEvent;
    expect(() => (ev = escape(document))).not.toThrow();
    expect(close).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});
