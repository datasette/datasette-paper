/**
 * Table-of-contents block: a NodeView + a driver plugin.
 *
 * `TocView` renders the `toc` atom as a card listing the document's
 * top-level headings (filtered by config), each clickable to scroll to the
 * heading at its live doc position — there are no persisted anchor IDs.
 *
 * A NodeView's `update()` only fires when its *own* node changes, so a
 * heading edited elsewhere would never reach it. `tocPlugin` is the driver:
 * a `Plugin.view` (same pattern as tableInsertTooltip.ts / linkTooltip.ts)
 * whose `update()` recomputes a cheap heading "signature" on every doc
 * change and re-renders every mounted TocView when it changes. Mounted
 * views are tracked in a module-level Set (the sourceStore.ts dedup idiom).
 *
 * Heading walk is top-level children only, mirroring foldHeadings.ts.
 *
 * XSS rule (load-bearing): heading text is user-derived and goes into the
 * DOM as TEXT NODES only — never innerHTML. Only the constant icon SVGs use
 * innerHTML.
 */
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, type Command, TextSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { schema } from "./schema";
import { TOOLBAR_ICONS } from "./icons";

export interface TocEntry {
  text: string;
  level: number;
  pos: number;
}

/** Top-level headings as {text, level, pos}, in document order. */
export function extractHeadings(doc: PMNode): TocEntry[] {
  const out: TocEntry[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name !== "heading") return;
    out.push({
      text: node.textContent,
      level: node.attrs.level as number,
      pos: offset,
    });
  });
  return out;
}

/** Cheap change-detector: re-render only when this string changes. */
export function headingSignature(doc: PMNode): string {
  return extractHeadings(doc)
    .map((h) => `${h.level}:${h.pos}:${h.text}`)
    .join("\n");
}

export interface TocConfig {
  minLevel: number;
  maxLevel: number;
  ordered: boolean;
}

/**
 * Read the toc node's `config` attr into a fully-defaulted TocConfig,
 * coercing/clamping defensively so a hand-edited markdown fence can never
 * produce a broken render (mirrors block_embed's defensive config reads).
 */
export function readTocConfig(raw: unknown): TocConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(v) : d;
  const minLevel = Math.min(Math.max(num(c.minLevel, 1), 1), 6);
  const maxLevel = Math.min(Math.max(num(c.maxLevel, 3), minLevel), 6);
  return { minLevel, maxLevel, ordered: c.ordered !== false };
}

/** Headings filtered to the config's [minLevel, maxLevel] range. */
export function tocEntries(doc: PMNode, config: TocConfig): TocEntry[] {
  return extractHeadings(doc).filter(
    (h) => h.level >= config.minLevel && h.level <= config.maxLevel,
  );
}

/** Insert a new (empty-config) table-of-contents block at the selection. */
export const insertToc: Command = (state, dispatch) => {
  if (dispatch) {
    dispatch(state.tr.replaceSelectionWith(schema.nodes.toc.create()).scrollIntoView());
  }
  return true;
};

function svgIcon(name: keyof typeof TOOLBAR_ICONS): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "pm-toc-icon";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${TOOLBAR_ICONS[name] ?? ""}</svg>`;
  return span;
}

// Every mounted TocView — the driver plugin re-renders these on doc change.
const mounted = new Set<TocView>();

export class TocView implements NodeView {
  dom: HTMLElement;
  private node: PMNode;
  private view: EditorView;
  private getPos: () => number | undefined;
  private menuEl: HTMLElement | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.dom = document.createElement("div");
    this.dom.className = "pm-toc";
    mounted.add(this);
    this.render();
  }

  private config(): TocConfig {
    return readTocConfig(this.node.attrs.config);
  }

  /** Re-render from the live doc. Called by the NodeView lifecycle and by
   *  tocPlugin whenever the heading structure changes. */
  render(): void {
    this.closeMenu();
    this.dom.replaceChildren();
    this.dom.appendChild(this.header());

    const config = this.config();
    const entries = tocEntries(this.view.state.doc, config);
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pm-toc-empty";
      empty.textContent = "No headings yet";
      this.dom.appendChild(empty);
      return;
    }

    this.dom.appendChild(this.buildList(entries, config.ordered));
  }

  /**
   * Build a genuinely nested list from the flat, level-tagged heading entries,
   * so an ordered list numbers per level (1, then nested 1/2/3) rather than
   * running 1..N flat across indent levels, and an unordered list indents
   * naturally. A stack tracks the open list at each level; child lists are
   * created lazily so leaf items carry no empty sublist. Level jumps (e.g. H1
   * straight to H3) are tolerated — the deeper item just nests under the
   * nearest shallower open item.
   */
  private buildList(entries: TocEntry[], ordered: boolean): HTMLElement {
    const tag = ordered ? "ol" : "ul";
    const root = document.createElement(tag);
    root.className = "pm-toc-list";
    const stack: { level: number; listEl: HTMLElement | null; li: HTMLElement | null }[] = [
      { level: 0, listEl: root, li: null },
    ];
    for (const entry of entries) {
      while (stack.length > 1 && stack[stack.length - 1].level >= entry.level) {
        stack.pop();
      }
      const top = stack[stack.length - 1];
      if (!top.listEl && top.li) {
        const sub = document.createElement(tag);
        sub.className = "pm-toc-list";
        top.li.appendChild(sub);
        top.listEl = sub;
      }
      const li = document.createElement("li");
      li.className = "pm-toc-item";
      const link = document.createElement("a");
      link.className = "pm-toc-link";
      link.href = "#";
      link.textContent = entry.text || "Untitled heading"; // text node — XSS rule
      link.addEventListener("click", (e) => {
        e.preventDefault();
        this.scrollToHeading(entry.pos);
      });
      li.appendChild(link);
      top.listEl!.appendChild(li);
      stack.push({ level: entry.level, listEl: null, li });
    }
    return root;
  }

  /** Header: title + refresh + overflow (config) menu. */
  private header(): HTMLElement {
    const head = document.createElement("div");
    head.className = "pm-toc-head";
    head.appendChild(svgIcon("listNested"));

    const title = document.createElement("span");
    title.className = "pm-toc-title";
    title.textContent = "Table of contents";
    head.appendChild(title);

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "pm-toc-refresh";
    refresh.title = "Refresh";
    refresh.setAttribute("aria-label", "Refresh");
    refresh.appendChild(svgIcon("redo"));
    refresh.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.render();
    });
    head.appendChild(refresh);
    head.appendChild(this.overflowMenu());
    return head;
  }

  /** "⋮" menu wrapping the config panel (min/max level + ordered toggle). */
  private overflowMenu(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "pm-toc-menu-wrap";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pm-toc-menu-btn";
    btn.title = "Options";
    btn.setAttribute("aria-label", "Options");
    btn.appendChild(svgIcon("threeDotsVertical"));
    const menu = document.createElement("div");
    menu.className = "pm-toc-menu";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleMenu(menu);
    });
    wrap.appendChild(btn);

    this.buildConfigPanel(menu);
    wrap.appendChild(menu);
    return wrap;
  }

  private buildConfigPanel(menu: HTMLElement): void {
    const config = this.config();
    menu.replaceChildren();

    const levelRow = (
      label: string,
      value: number,
      onChange: (n: number) => void,
    ): HTMLElement => {
      const row = document.createElement("label");
      row.className = "pm-toc-menu-row";
      const span = document.createElement("span");
      span.textContent = label;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = "6";
      input.value = String(value);
      input.className = "pm-toc-menu-num";
      input.addEventListener("change", () => onChange(Number(input.value)));
      row.appendChild(span);
      row.appendChild(input);
      return row;
    };

    let next: Record<string, unknown> = { ...(this.node.attrs.config ?? {}) };
    const apply = () => this.setConfig(next);

    menu.appendChild(
      levelRow("From level", config.minLevel, (n) => {
        next = { ...next, minLevel: n };
        apply();
      }),
    );
    menu.appendChild(
      levelRow("To level", config.maxLevel, (n) => {
        next = { ...next, maxLevel: n };
        apply();
      }),
    );

    const orderedRow = document.createElement("label");
    orderedRow.className = "pm-toc-menu-row";
    const orderedSpan = document.createElement("span");
    orderedSpan.textContent = "Numbered";
    const orderedInput = document.createElement("input");
    orderedInput.type = "checkbox";
    orderedInput.checked = config.ordered;
    orderedInput.addEventListener("change", () => {
      next = { ...next, ordered: orderedInput.checked };
      apply();
    });
    orderedRow.appendChild(orderedSpan);
    orderedRow.appendChild(orderedInput);
    menu.appendChild(orderedRow);
  }

  /**
   * Write `config` back to the node. Stores keys minimally — a value equal to
   * its default is dropped, so an all-default TOC keeps an empty `{}` config
   * (and thus a clean empty markdown fence). setNodeMarkup produces a step that
   * collaborates + persists + triggers update() → render().
   */
  private setConfig(raw: Record<string, unknown>): void {
    const pos = this.getPos();
    if (pos == null) return;
    const parsed = readTocConfig(raw);
    const config: Record<string, unknown> = {};
    if (parsed.minLevel !== 1) config.minLevel = parsed.minLevel;
    if (parsed.maxLevel !== 3) config.maxLevel = parsed.maxLevel;
    if (parsed.ordered !== true) config.ordered = false;
    const { state, dispatch } = this.view;
    dispatch(state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, config }));
  }

  private toggleMenu(menu: HTMLElement): void {
    if (this.menuEl === menu) {
      this.closeMenu();
      return;
    }
    this.closeMenu();
    this.buildConfigPanel(menu); // reflect current attrs each open
    menu.classList.add("pm-toc-menu--open");
    this.menuEl = menu;
    document.addEventListener("mousedown", this.onOutsideClick, true);
    document.addEventListener("keydown", this.onKeydown, true);
  }

  private closeMenu(): void {
    if (!this.menuEl) return;
    this.menuEl.classList.remove("pm-toc-menu--open");
    this.menuEl = null;
    document.removeEventListener("mousedown", this.onOutsideClick, true);
    document.removeEventListener("keydown", this.onKeydown, true);
  }

  private onOutsideClick = (e: MouseEvent): void => {
    const wrap = this.menuEl?.parentElement;
    if (wrap && !wrap.contains(e.target as Node)) this.closeMenu();
  };

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.closeMenu();
  };

  /** Scroll the editor to the heading at `pos` and place the cursor in it. */
  private scrollToHeading(pos: number): void {
    try {
      const { node } = this.view.domAtPos(pos + 1);
      const el = node instanceof HTMLElement ? node : node.parentElement;
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      /* jsdom: domAtPos/scrollIntoView may be unimplemented — no-op */
    }
    try {
      const { state, dispatch } = this.view;
      const sel = TextSelection.create(state.doc, pos + 1);
      dispatch(state.tr.setSelection(sel));
      this.view.focus();
    } catch {
      /* selection target may be invalid mid-edit — scrolling already done */
    }
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "toc") return false;
    this.node = node;
    this.render();
    return true;
  }

  destroy(): void {
    this.closeMenu();
    mounted.delete(this);
  }

  // We own the whole managed subtree — keep PM out of it, but let the
  // interactive controls handle their own events.
  ignoreMutation(): boolean {
    return true;
  }
  stopEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return !!target && !!target.closest("a, button, select, input, label");
  }
}

/**
 * Driver: re-render every mounted TocView when the doc's top-level heading
 * signature changes. This is what makes the TOC auto-sync to heading edits
 * happening anywhere in the document.
 */
export const tocPlugin = new Plugin({
  view() {
    let lastSig: string | null = null;
    return {
      update(view: EditorView, prevState) {
        if (view.state.doc === prevState.doc) return;
        const sig = headingSignature(view.state.doc);
        if (sig === lastSig) return;
        lastSig = sig;
        for (const v of mounted) v.render();
      },
    };
  },
});
