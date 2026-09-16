/**
 * Selection bubble — the docked toolbar's floating twin.
 *
 * Select text and the formatting controls come to the selection instead of the
 * selection going to the strip: `Text ▾ │ B I S <> (dot) Link ▾`, the strip's own
 * order, built from the strip's own `.tb-*` classes (lifted into `editor.css`
 * for exactly this reason — a `Plugin.view` owns vanilla DOM and cannot reach a
 * Svelte-scoped rule). Undo/redo, List ▾ and ＋ Insert stay on the strip: they
 * are not selection-scoped. The commands are the same ones `Toolbar.svelte`
 * runs, imported from `textCommands.ts` / `highlight.ts` / `callout.ts` rather
 * than re-derived.
 *
 * Anchor state lives in plugin state, not in a DOM rect: a remote step moves
 * the text the bubble points at, so `apply()` maps the range (bias 1 / -1) and
 * drops it when a collaborator deletes the span out from under us — the #84
 * fix `linkTooltip.ts`'s `linkEditKey` carries, in miniature. An explicit
 * `setMeta(selectionBubbleKey, null)` is a dismiss; an absent meta is "no
 * opinion", which is why `apply` tests it with `!== undefined`.
 *
 * Positioning: centred above the selection's visual end (the last line for a
 * multi-line range), clamped to the editor host, flipped below via
 * `.pm-sb-below` when sitting above would collide with the sticky toolbar —
 * the `tableInsertTooltip.ts` idiom. Desktop only, gated on the same
 * `(max-width: 640px)` query `Toolbar.svelte` uses so JS and CSS agree on what
 * mobile means; phones keep the bottom strip.
 *
 * Triggers are explicit, and `update()` is not one of them: it repositions an
 * already-open bubble and hides it when the gate closes, but only a settled
 * selection (`mouseup` on the next tick, shift/arrow `keyup`) or a
 * `contextmenu` over a non-empty selection ever *opens* one. "Open" is the
 * stored anchor, and `apply` drops it the moment a transaction leaves the
 * selection collapsed — which is exactly what typing over the selected range
 * does, so typing hides.
 *
 * `shouldShowBubble` is the whole suppression matrix in one pure function —
 * exported so the truth table is testable without a view.
 */

import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import type { Command, EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { MarkType, NodeType } from "prosemirror-model";
import { lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { iconMarkup } from "./datasetteEmbed";
import { HIGHLIGHT_COLORS, schema, type HighlightColor } from "./schema";
import { activeHighlightColor, clearHighlight, setHighlight } from "./highlight";
import { blockTypeLabel } from "./blockTypeLabel";
import { unwrapCallout, wrapSelectionInCallout } from "./callout";
import {
  markActive,
  nodeActive,
  setHeading,
  startWikiLink,
  toggleLink,
} from "./textCommands";
import {
  SHORTCUTS,
  ariaKeyshortcuts,
  formatShortcut,
  titleWithShortcut,
  type ShortcutId,
} from "./shortcuts";

/** The doc range the bubble points at. Mapped through remote steps in `apply`. */
export interface BubbleAnchor {
  from: number;
  to: number;
}

export const selectionBubbleKey = new PluginKey<BubbleAnchor | null>(
  "selectionBubble",
);

/** Same breakpoint (and same contract) as `Toolbar.svelte`'s mobile strip. */
const MOBILE_QUERY = "(max-width: 640px)";

/** Gap between the selection's line box and the bubble, above or below. */
const GAP = 6;

/**
 * Surfaces CodeMirror owns (`code-cm-focus`). A mark menu is meaningless in
 * them, and `Text ▾` would offer to turn a SQL block into a heading.
 */
const CODE_NODES = new Set(["code_block", "sql_block", "source"]);

/**
 * `tableInsertTooltip.ts` owns *all* in-table UI, and
 * `plans/toolbar-redesign/design.md:165` makes "the toolbar keeps zero
 * in-table actions" an invariant — the bubble inherits it.
 */
const CELL_NODES = new Set(["table_cell", "table_header"]);

/**
 * The suppression matrix (`plans/selection-bubble/design.md` §Suppression
 * matrix), as one pure predicate over the state plus the two facts that live
 * on the view rather than in it.
 *
 * `instanceof TextSelection` is what keeps `NodeSelection` (an embed, an
 * image, a date atom — each with its own chrome) and `CellSelection` out;
 * note `CellSelection` is *not* a `TextSelection`, so the cell check below is
 * the belt-and-braces case of a plain text selection inside a single cell,
 * which a `CellSelection` never covers.
 *
 * Both ends are walked, innermost-first, the shape `blockTypeLabel.ts:15-25`
 * uses. A selection that starts in a paragraph and ends in a code block is
 * therefore suppressed: half the range is a surface the controls can't act on,
 * and a menu that silently applies to only part of what's highlighted is worse
 * than no menu.
 */
export function shouldShowBubble(
  state: EditorState,
  opts: { editable: boolean; mobile: boolean },
): boolean {
  if (!opts.editable) return false; // read-only viewers can't dispatch
  if (opts.mobile) return false; // phones keep the docked strip
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || sel.empty) return false;
  for (const $pos of [sel.$from, sel.$to]) {
    for (let d = $pos.depth; d > 0; d--) {
      const name = $pos.node(d).type.name;
      if (CODE_NODES.has(name) || CELL_NODES.has(name)) return false;
    }
  }
  return true;
}

/**
 * The bubble view mounted on an `EditorView`. ProseMirror doesn't expose
 * plugin views, and the Escape keymap below (a `Command`, which only gets
 * `state` / `dispatch` / `view`) has to reach the instance to read whether a
 * popover or the bubble is open.
 */
const bubbleViews = new WeakMap<EditorView, SelectionBubbleView>();

/** The bubble attached to `view`, if any. Used by the keymap and by tests. */
export function selectionBubbleViewFor(
  view: EditorView,
): SelectionBubbleView | undefined {
  return bubbleViews.get(view);
}

type MenuName = "text" | "highlight" | "link";

interface MenuParts {
  wrap: HTMLDivElement;
  trigger: HTMLButtonElement;
  menu: HTMLDivElement;
}

/**
 * The plugin view. Exported for unit tests, which drive it directly rather
 * than reaching into `EditorView`'s private plugin-view list.
 */
export class SelectionBubbleView {
  private host: HTMLElement | null;
  private root: HTMLDivElement | null;

  // Bound listeners so destroy() detaches exactly what was attached. `opts` is
  // carried because removeEventListener only matches when the capture flag
  // matches — the window `scroll` listener below is capture-phase.
  private listeners: Array<{
    target: EventTarget;
    type: string;
    fn: EventListenerOrEventListenerObject;
    opts?: AddEventListenerOptions | boolean;
  }> = [];

  // ── control refs, all re-read in sync() ──────────────────────────────────
  private menus = new Map<MenuName, MenuParts>();
  private openMenu: MenuName | null = null;
  private blockLabel: HTMLSpanElement | null = null;
  private markButtons: Array<{ btn: HTMLButtonElement; type: MarkType }> = [];
  private blockRows: Array<{
    row: HTMLButtonElement;
    active: (state: EditorState) => boolean;
  }> = [];
  private hlDot: HTMLSpanElement | null = null;
  private hlSwatches: Array<{
    btn: HTMLButtonElement;
    color: HighlightColor | null;
  }> = [];

  // Bound-while-a-menu-is-open handlers (outside click + roving keys). Not in
  // `listeners`: they come and go with the popover, and are dropped again in
  // dismiss() / destroy().
  private whileOpenBound = false;
  private menuIndex = 0;

  private mq: MediaQueryList | null = null;

  // Set by the right-click trigger: place at the pointer instead of the
  // selection's visual end, until the next open or dismiss.
  private pointer: { x: number; y: number } | null = null;

  // The mouseup settle tick, cleared on teardown so it can't fire into a
  // destroyed view.
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private view: EditorView) {
    const host = view.dom.parentElement;
    if (!host) {
      // EditorView mounted detached from any parent — nothing to anchor to.
      // Null the refs; every method below no-ops and destroy() is harmless.
      this.host = null;
      this.root = null;
      return;
    }
    this.host = host;
    this.root = this.build();
    host.appendChild(this.root);
    bubbleViews.set(view, this);

    // Without this a click on any control collapses the very selection being
    // formatted: the browser moves the selection on mousedown, before the
    // click lands. `slashMenu.ts` guards its rows the same way, and
    // `caretGuard.ts` documents why chrome over a live selection needs it.
    this.on(this.root, "mousedown", (e) => e.preventDefault());

    if (typeof window.matchMedia === "function") {
      this.mq = window.matchMedia(MOBILE_QUERY);
      // Crossing 640px re-runs the gate: `update()` hides when it now fails.
      this.on(this.mq, "change", () => this.update(this.view, null));
    }

    this.bindTriggers(view);
    this.update(view, null);
  }

  // ── triggers ──────────────────────────────────────────────────────────────

  /**
   * The two show gestures and the hide gestures that aren't transactions.
   * Everything goes through the tracked `listeners` array, so `destroy()`
   * drains them.
   */
  private bindTriggers(view: EditorView): void {
    // The selection isn't final while `mouseup` is dispatching — the browser
    // settles it after the event — so re-read it on the next tick.
    this.on(view.dom, "mouseup", () => {
      if (this.settleTimer !== null) clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        this.showFromSelection();
      }, 0);
    });

    // Keyboard selection: shift-anything, or a bare arrow (which collapses,
    // and so takes the close branch of showFromSelection).
    this.on(view.dom, "keyup", (e) => {
      const ev = e as KeyboardEvent;
      if (ev.shiftKey || ev.key.startsWith("Arrow")) this.showFromSelection();
    });

    // The first `contextmenu` handler in the frontend. It claims the event
    // *only* over a live text selection; over an embed, an image, empty space
    // or a collapsed cursor the native menu survives, because spellcheck and
    // "search with…" are worth more than uniformity. Unlike `caretGuard.ts`'s
    // mousedown guard there is no caret to protect here — the browser leaves
    // the selection alone on right-click — so this preventDefault is purely
    // "don't open the native menu".
    this.on(view.dom, "contextmenu", (e) => {
      if (!shouldShowBubble(this.view.state, this.gate())) return;
      const ev = e as MouseEvent;
      ev.preventDefault();
      this.showAt(ev.clientX, ev.clientY);
    });

    // Focus leaving the editor takes the bubble with it.
    this.on(view.dom, "blur", () => this.close());

    // `scroll` doesn't bubble, but a capture-phase listener on window still
    // sees it from any scrolling ancestor of the editor. Skip our own
    // popovers, which scroll internally.
    this.on(
      window,
      "scroll",
      (e) => {
        const target = e.target as Node | null;
        if (target && this.root?.contains(target)) return;
        this.close();
      },
      true,
    );
  }

  /** `editable` / `mobile` — the two gate inputs that aren't in the state. */
  private gate(): { editable: boolean; mobile: boolean } {
    return { editable: this.view.editable, mobile: this.mq?.matches ?? false };
  }

  /**
   * Open on the current selection, or close when the gate says no. Storing the
   * range as plugin state is what "open" means; `update()` renders it.
   */
  private showFromSelection(): void {
    if (!this.root || this.view.isDestroyed) return;
    const state = this.view.state;
    if (!shouldShowBubble(state, this.gate())) {
      this.close();
      return;
    }
    this.pointer = null;
    const { from, to } = state.selection;
    this.view.dispatch(state.tr.setMeta(selectionBubbleKey, { from, to }));
  }

  /** Open at a viewport point (the right-click trigger). */
  private showAt(x: number, y: number): void {
    if (!this.root || this.view.isDestroyed) return;
    const state = this.view.state;
    this.pointer = { x, y };
    const { from, to } = state.selection;
    this.view.dispatch(state.tr.setMeta(selectionBubbleKey, { from, to }));
  }

  /**
   * The Escape ladder, in order: an open popover first, then the bubble,
   * then nothing. Returning false is the case that protects the Sidebar —
   * `Sidebar.svelte:59-69` skips an Escape that is already `defaultPrevented`,
   * and ProseMirror `preventDefault()`s exactly when a keymap command returns
   * true, so consuming here leaves the rail panel open and declining here lets
   * the panel have it.
   */
  handleEscape(): boolean {
    if (!this.root) return false;
    if (this.openMenu) {
      this.setMenu(null);
      return true;
    }
    if (this.root.style.display === "none") return false;
    this.close();
    this.view.focus();
    return true;
  }

  // ── DOM ────────────────────────────────────────────────────────────────────

  private build(): HTMLDivElement {
    const root = document.createElement("div");
    root.className = "tb-shell pm-selection-bubble";
    root.setAttribute("role", "toolbar");
    root.setAttribute("aria-label", "Selection formatting");
    root.style.display = "none";

    root.append(this.buildTextMenu());
    root.append(separator());
    root.append(
      this.markButton("Bold", "bold", schema.marks.strong, "bold"),
      this.markButton("Italic", "italic", schema.marks.em, "italic"),
      this.markButton(
        "Strikethrough",
        "strikethrough",
        schema.marks.strike,
        "strike",
      ),
      this.markButton("Inline code", "code", schema.marks.code, "code"),
    );
    root.append(this.buildHighlightMenu());
    root.append(this.buildLinkMenu());
    return root;
  }

  /** One of the four mark toggles. `.active` + aria-pressed track the mark. */
  private markButton(
    label: string,
    icon: string,
    type: MarkType,
    shortcut: ShortcutId,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tb-btn";
    btn.setAttribute("aria-label", label);
    btn.title = titleWithShortcut(label, shortcut);
    btn.setAttribute("aria-keyshortcuts", ariaKeyshortcuts(SHORTCUTS[shortcut].key));
    btn.append(iconEl(icon, BTN_ICON_PX));
    this.on(btn, "click", (e) => {
      e.preventDefault();
      this.run(toggleMark(type));
    });
    this.markButtons.push({ btn, type });
    return btn;
  }

  /**
   * Text ▾ — the block-type "turn into" dropdown. The trigger is a bare label
   * (the current block type) plus a chevron: no icon, matching the strip.
   */
  private buildTextMenu(): HTMLDivElement {
    const { wrap, trigger, menu } = this.menuShell("text", "Turn into");
    trigger.classList.add("tb-trigger");
    trigger.title = "Turn into…";

    const label = document.createElement("span");
    label.className = "tb-trigger-label";
    label.textContent = "Text";
    this.blockLabel = label;
    trigger.append(label, chevron());

    menu.classList.add("tb-menu");
    menu.setAttribute("aria-label", "Turn into");

    const { heading, paragraph, blockquote, callout, code_block } = schema.nodes;
    // H4–H6 deliberately have no row (decided with #89); the trigger still
    // *reads* "H5" inside one, and Text is the way out.
    menu.append(
      this.menuRow(
        "Text",
        paragraphGlyph(),
        () => setBlockType(paragraph),
        (s) => blockTypeLabel(s) === "Text",
        "paragraph",
      ),
      this.menuRow(
        "Heading 1",
        iconEl("h1", ROW_ICON_PX),
        () => setHeading(1),
        (s) => nodeActive(s, heading, { level: 1 }),
        "heading1",
      ),
      this.menuRow(
        "Heading 2",
        iconEl("h2", ROW_ICON_PX),
        () => setHeading(2),
        (s) => nodeActive(s, heading, { level: 2 }),
        "heading2",
      ),
      this.menuRow(
        "Heading 3",
        iconEl("h3", ROW_ICON_PX),
        () => setHeading(3),
        (s) => nodeActive(s, heading, { level: 3 }),
        "heading3",
      ),
      menuSeparator(),
      this.menuRow(
        "Quote",
        iconEl("quote", ROW_ICON_PX),
        () => (hasAncestor(this.view.state, blockquote) ? lift : wrapIn(blockquote)),
        (s) => hasAncestor(s, blockquote),
        "blockquote",
      ),
      this.menuRow(
        "Callout",
        iconEl("infoCircle", ROW_ICON_PX),
        () =>
          hasAncestor(this.view.state, callout)
            ? unwrapCallout
            : wrapSelectionInCallout("note"),
        (s) => hasAncestor(s, callout),
      ),
      this.menuRow(
        "Code block",
        iconEl("codeBlock", ROW_ICON_PX),
        () => setBlockType(code_block),
        (s) => nodeActive(s, code_block),
        "codeBlock",
      ),
    );
    return wrap;
  }

  /**
   * One dropdown row. `command` is a thunk, not a `Command`: Quote and Callout
   * pick between wrap and unwrap from the state at click time. `active` is null
   * for rows that never paint a state of their own (the two link rows — their
   * trigger carries it).
   */
  private menuRow(
    label: string,
    glyph: Element,
    command: () => Command,
    active: ((state: EditorState) => boolean) | null,
    shortcut?: ShortcutId,
  ): HTMLButtonElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tb-menu-item";
    row.setAttribute("role", "menuitem");
    if (shortcut) {
      row.setAttribute("aria-keyshortcuts", ariaKeyshortcuts(SHORTCUTS[shortcut].key));
    }
    row.append(glyph);

    const text = document.createElement("span");
    text.className = "tb-menu-label";
    text.textContent = label;
    row.append(text);

    if (shortcut) {
      const hint = document.createElement("span");
      hint.className = "tb-menu-hint";
      hint.textContent = formatShortcut(SHORTCUTS[shortcut].key);
      row.append(hint);
    }

    this.on(row, "click", (e) => {
      e.preventDefault();
      this.setMenu(null);
      this.run(command());
    });
    if (active) this.blockRows.push({ row, active });
    return row;
  }

  /**
   * The highlight swatch popover. The trigger glyph *is* the state: filled
   * with the active slot colour, or the slashed "none" dot. No chevron; the
   * strip has none and one here would make the two look like different
   * components.
   */
  private buildHighlightMenu(): HTMLDivElement {
    const { wrap, trigger, menu } = this.menuShell("highlight", "Highlight");
    trigger.title = titleWithShortcut("Highlight", "highlight");
    trigger.setAttribute(
      "aria-keyshortcuts",
      ariaKeyshortcuts(SHORTCUTS.highlight.key),
    );

    const dot = document.createElement("span");
    dot.className = "tb-hl-swatch tb-hl-trigger-dot tb-hl-none";
    dot.setAttribute("aria-hidden", "true");
    this.hlDot = dot;
    trigger.append(dot);

    menu.classList.add("tb-hl-menu");
    menu.setAttribute("aria-label", "Highlight color");
    // Remove first, then hl1–hl4 — the strip's order (docs/screenshots/highlight.png).
    menu.append(this.swatch(null, "Remove highlight"));
    HIGHLIGHT_COLORS.forEach((color, i) => {
      menu.append(this.swatch(color, `Highlight color ${i + 1}`));
    });
    return wrap;
  }

  private swatch(color: HighlightColor | null, label: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = color ? "tb-hl-swatch" : "tb-hl-swatch tb-hl-none";
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("aria-label", label);
    btn.title = label;
    if (color) btn.dataset.color = color;
    this.on(btn, "click", (e) => {
      e.preventDefault();
      this.setMenu(null);
      this.run(color ? setHighlight(color) : clearHighlight);
    });
    this.hlSwatches.push({ btn, color });
    return btn;
  }

  /** Link ▾ — URL link and wiki-link on one trigger, as on the strip. */
  private buildLinkMenu(): HTMLDivElement {
    const { wrap, trigger, menu } = this.menuShell("link", "Link");
    trigger.classList.add("tb-trigger", "tb-trigger-icon");
    trigger.title = "Link";
    trigger.append(iconEl("link", BTN_ICON_PX), chevron());

    menu.classList.add("tb-menu");
    menu.setAttribute("aria-label", "Link");
    const linkRow = this.menuRow(
      "Link",
      iconEl("link", ROW_ICON_PX),
      () => toggleLink,
      null,
      "link",
    );
    const wikiRow = this.menuRow(
      "Link to a page",
      iconEl("wikilink", ROW_ICON_PX),
      () => startWikiLink,
      null,
    );
    // The wiki-link row's hint is the literal trigger, not a registry chord.
    const hint = document.createElement("span");
    hint.className = "tb-menu-hint";
    hint.textContent = "[[";
    wikiRow.append(hint);
    menu.append(linkRow, wikiRow);
    return wrap;
  }

  /** Trigger + popover wrapper shared by the three dropdowns. */
  private menuShell(name: MenuName, label: string): MenuParts {
    const wrap = document.createElement("div");
    wrap.className = "tb-menu-wrap";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "tb-btn";
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", label);

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.style.display = "none";

    this.on(trigger, "click", (e) => {
      e.preventDefault();
      this.setMenu(this.openMenu === name ? null : name);
    });

    wrap.append(trigger, menu);
    const parts = { wrap, trigger, menu };
    this.menus.set(name, parts);
    return parts;
  }

  // ── menus ─────────────────────────────────────────────────────────────────

  /** Open one popover (closing any other), or close them all with `null`. */
  private setMenu(name: MenuName | null): void {
    this.openMenu = name;
    this.paintMenus();
    if (name) {
      this.bindWhileOpen();
      // Start the roving highlight on the active row, as the strip does.
      const items = this.menuItems();
      this.menuIndex = Math.max(
        0,
        items.findIndex((el) => el.classList.contains("active")),
      );
      this.highlightMenuItem(this.menuIndex);
    } else {
      this.unbindWhileOpen();
    }
    this.sync(this.view.state);
  }

  /** DOM-only half of `setMenu(null)` — safe during teardown. */
  private paintMenus(): void {
    for (const [name, parts] of this.menus) {
      const open = name === this.openMenu;
      parts.menu.style.display = open ? "" : "none";
      parts.trigger.setAttribute("aria-expanded", open ? "true" : "false");
    }
  }

  private menuItems(): HTMLElement[] {
    const parts = this.openMenu ? this.menus.get(this.openMenu) : null;
    if (!parts) return [];
    return Array.from(
      parts.menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
    );
  }

  private highlightMenuItem(index: number): void {
    const items = this.menuItems();
    items.forEach((el, i) => el.classList.toggle("sel", i === index));
    const el = items[index];
    // jsdom doesn't implement scrollIntoView — guard the call.
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }

  private onOutsideMouseDown = (e: Event): void => {
    const target = e.target as Node | null;
    if (target && this.root?.contains(target)) return;
    this.setMenu(null);
  };

  private onMenuKeydown = (e: Event): void => {
    const ev = e as KeyboardEvent;
    const items = this.menuItems();
    if (!items.length) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      this.menuIndex = (this.menuIndex + 1) % items.length;
      this.highlightMenuItem(this.menuIndex);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      this.menuIndex = (this.menuIndex - 1 + items.length) % items.length;
      this.highlightMenuItem(this.menuIndex);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      items[this.menuIndex]?.click();
    }
    // Escape is deliberately not handled here: the ladder (popover first,
    // then the bubble) is `selectionBubbleKeymap()`, so it takes part in
    // ProseMirror's key ordering instead of racing this window listener.
  };

  private bindWhileOpen(): void {
    if (this.whileOpenBound) return;
    document.addEventListener("mousedown", this.onOutsideMouseDown, true);
    window.addEventListener("keydown", this.onMenuKeydown);
    this.whileOpenBound = true;
  }

  private unbindWhileOpen(): void {
    if (!this.whileOpenBound) return;
    document.removeEventListener("mousedown", this.onOutsideMouseDown, true);
    window.removeEventListener("keydown", this.onMenuKeydown);
    this.whileOpenBound = false;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Reposition and hide — never open. The stored anchor is the open flag, and
   * only a trigger writes it; without that rule every keystroke would re-summon
   * the bubble over the text being replaced.
   *
   * Hiding here is `dismiss()` (DOM only), not `close()`: this runs inside
   * `updateState`, where dispatching would re-enter it. The paths that clear
   * the anchor are all DOM handlers — `linkTooltip.ts:441-453` splits its two
   * closers for the same reason.
   */
  update(view: EditorView, lastState: EditorState | null): void {
    this.view = view;
    if (!this.root) return;
    const state = view.state;
    const anchor = selectionBubbleKey.getState(state);
    if (
      lastState &&
      lastState.doc.eq(state.doc) &&
      lastState.selection.eq(state.selection) &&
      anchor === selectionBubbleKey.getState(lastState)
    ) {
      return;
    }
    if (!anchor || !shouldShowBubble(state, this.gate())) {
      this.dismiss();
      return;
    }
    this.root.style.display = "";
    this.sync(state);
    this.position(view, anchor);
  }

  /**
   * Repaint pressed / current state. `Plugin.view.update()` *is* the
   * transaction hook, so unlike the strip there is no RAF `tick` poll here.
   */
  private sync(state: EditorState): void {
    for (const { btn, type } of this.markButtons) {
      const on = markActive(state, type);
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }

    if (this.blockLabel) this.blockLabel.textContent = blockTypeLabel(state);
    for (const { row, active } of this.blockRows) {
      row.classList.toggle("active", active(state));
    }

    const color = activeHighlightColor(state);
    if (this.hlDot) {
      this.hlDot.classList.toggle("tb-hl-none", color === null);
      if (color) this.hlDot.dataset.color = color;
      else delete this.hlDot.dataset.color;
    }
    for (const { btn, color: slot } of this.hlSwatches) {
      const current = slot !== null && slot === color;
      btn.classList.toggle("active", current);
      btn.classList.toggle("current", current);
    }

    const hl = this.menus.get("highlight");
    hl?.trigger.setAttribute("aria-pressed", color !== null ? "true" : "false");
    hl?.trigger.classList.toggle("active", this.openMenu === "highlight");

    const text = this.menus.get("text");
    text?.trigger.classList.toggle("active", this.openMenu === "text");

    const link = this.menus.get("link");
    link?.trigger.classList.toggle(
      "active",
      this.openMenu === "link" || markActive(state, schema.marks.link),
    );
  }

  /**
   * Centre above the selection's visual end — or above the pointer, for the
   * right-click trigger — clamped to the host, flipped below when the sticky
   * toolbar is in the way. The vertical offset itself is CSS
   * (`translateY(-100%)`, dropped by `.pm-sb-below`) so positioning never
   * depends on having measured our own height.
   */
  private position(view: EditorView, anchor: BubbleAnchor): void {
    const root = this.root;
    const host = this.host;
    if (!root || !host) return;
    let centerX: number;
    let lineTop: number;
    let lineBottom: number;
    if (this.pointer) {
      centerX = this.pointer.x;
      lineTop = this.pointer.y;
      lineBottom = this.pointer.y;
    } else {
      let start: { left: number; top: number; bottom: number };
      let end: { left: number; top: number; bottom: number };
      try {
        start = view.coordsAtPos(anchor.from);
        end = view.coordsAtPos(anchor.to);
      } catch {
        return; // jsdom: getClientRects unimplemented — skip positioning
      }
      // A wrapping selection anchors on its last line, so the bubble sits at
      // the visual end instead of floating over the middle (linkTooltip.ts
      // does the same with the link's last client rect).
      const oneLine = Math.abs(start.top - end.top) < 1;
      centerX = oneLine ? (start.left + end.left) / 2 : end.left;
      lineTop = oneLine ? Math.min(start.top, end.top) : end.top;
      lineBottom = end.bottom;
    }

    const hostRect = host.getBoundingClientRect();
    let left = centerX - hostRect.left - root.offsetWidth / 2;
    const maxLeft = Math.max(0, host.clientWidth - root.offsetWidth);
    if (left > maxLeft) left = maxLeft;
    if (left < 0) left = 0;
    root.style.left = `${left}px`;

    const toolbar = document.querySelector(".paper-toolbar");
    const toolbarBottom = toolbar ? toolbar.getBoundingClientRect().bottom : 0;
    // offsetHeight can be 0 on the very first render (root just appended); as
    // in tableInsertTooltip, prefer "above" then and re-flow next update.
    const height = root.offsetHeight;
    const collides = height > 0 && lineTop - height - GAP < toolbarBottom + 4;
    if (collides) {
      root.classList.add("pm-sb-below");
      root.style.top = `${lineBottom - hostRect.top + GAP}px`;
    } else {
      root.classList.remove("pm-sb-below");
      root.style.top = `${lineTop - hostRect.top - GAP}px`;
    }
  }

  /**
   * Hide the bubble and its popover. DOM only — safe during teardown, and from
   * a state the view can no longer be dispatched into.
   */
  dismiss(): void {
    this.openMenu = null;
    this.pointer = null;
    this.paintMenus();
    this.unbindWhileOpen();
    if (!this.root) return;
    this.root.style.display = "none";
    this.root.classList.remove("pm-sb-below");
  }

  /**
   * Dismiss *and* clear the anchor from plugin state, so a stale range can't
   * re-show the bubble. The explicit `null` is what `apply()` distinguishes
   * from "no opinion". Every hide that isn't `update()`'s goes through here.
   */
  close(): void {
    this.dismiss();
    if (!this.view.isDestroyed && selectionBubbleKey.getState(this.view.state)) {
      this.view.dispatch(this.view.state.tr.setMeta(selectionBubbleKey, null));
    }
  }

  destroy(): void {
    this.dismiss();
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    for (const { target, type, fn, opts } of this.listeners) {
      target.removeEventListener(type, fn, opts);
    }
    this.listeners = [];
    bubbleViews.delete(this.view);
    this.root?.remove();
    this.root = null;
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private run(cmd: Command): void {
    cmd(this.view.state, this.view.dispatch);
    this.view.focus();
  }

  private on(
    target: EventTarget,
    type: string,
    fn: (e: Event) => void,
    opts?: AddEventListenerOptions | boolean,
  ): void {
    const listener = fn as EventListenerOrEventListenerObject;
    target.addEventListener(type, listener, opts);
    this.listeners.push({ target, type, fn: listener, opts });
  }
}

// ── small DOM helpers ───────────────────────────────────────────────────────

function separator(): HTMLSpanElement {
  const sep = document.createElement("span");
  sep.className = "tb-sep";
  sep.setAttribute("aria-hidden", "true");
  return sep;
}

function menuSeparator(): HTMLSpanElement {
  const sep = document.createElement("span");
  sep.className = "tb-menu-sep";
  sep.setAttribute("role", "separator");
  return sep;
}

/**
 * An icon as an element, sized the way `Toolbar.svelte`'s snippets size theirs
 * (attributes, not CSS) so the two surfaces render the same glyph at the same
 * size: 16px in a button, 15px in a menu row, 12px for a chevron. `iconMarkup`
 * stamps 14px, hence the re-set.
 */
function iconEl(name: string, size: number, className?: string): Element {
  const holder = document.createElement("span");
  holder.innerHTML = iconMarkup(name);
  const svg = holder.firstElementChild as Element;
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  if (className) svg.setAttribute("class", className);
  return svg;
}

const BTN_ICON_PX = 16;
const ROW_ICON_PX = 15;
const CHEVRON_PX = 12;

function chevron(): Element {
  return iconEl("chevronDown", CHEVRON_PX, "tb-trigger-chevron");
}

/**
 * The Text row's glyph. `icons.ts` has no `paragraph` slot, so this is the same
 * `.tb-menu-glyph` "¶" fallback `Toolbar.svelte`'s `menuIcon` snippet renders;
 * when the bootstrap `text-paragraph` path lands, both become an icon.
 */
function paragraphGlyph(): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "tb-menu-glyph";
  span.setAttribute("aria-hidden", "true");
  span.textContent = "¶";
  return span;
}

/** Does any ancestor of the selection head have type `type`? */
function hasAncestor(state: EditorState, type: NodeType): boolean {
  const pos = state.selection.$from;
  for (let d = pos.depth; d > 0; d--) {
    if (pos.node(d).type === type) return true;
  }
  return false;
}

/**
 * Escape bindings for the bubble. Registered *after* `slashKeymap`, so a `/`
 * popup still wins the key, and *before* `buildKeymap` — which is where
 * Escape → `selectParentNode` lives (prosemirror-example-setup binds it;
 * `baseKeymap` binds no Escape at all). Behind buildKeymap this whole ladder
 * is dead code, so `collab.ts`'s registration point is part of the contract.
 *
 * The ladder is the point: an open popover closes first, then the bubble,
 * then nothing. Returning true is how the bubble consumes the key, which
 * makes ProseMirror `preventDefault()` the keydown; `Sidebar.svelte:59-69`
 * skips an already-`defaultPrevented` Escape, so one press never closes both
 * the bubble and the rail panel.
 *
 * Two things this deliberately does *not* claim. A `Command` gets no event,
 * so unlike `tocView.ts:393-400` there is nothing here to `stopPropagation()`
 * on — every window-level Escape listener in the frontend is either
 * `defaultPrevented`-guarded (Sidebar) or gated on its own open state, and
 * none of those can be open while focus sits in the editor. And returning
 * false does not hand the browser a live Escape: `captureKeyDown`
 * (prosemirror-view/src/capturekeys.ts:328) preventDefaults keyCode 27
 * unconditionally inside an editable view, so an Escape typed in the editor
 * is already consumed before the Sidebar sees it, bubble or no bubble. False
 * means "not mine" — it leaves the key to the plugins after us.
 */
export function selectionBubbleKeymap(): Record<string, Command> {
  return {
    Escape: (_state, _dispatch, view) =>
      (view && bubbleViews.get(view)?.handleEscape()) ?? false,
  };
}

// @feat selection-bubble: the plugin — anchor state (mapped through remote
// steps) plus the `Plugin.view` that builds, positions and syncs the bubble
export function selectionBubblePlugin(): Plugin<BubbleAnchor | null> {
  return new Plugin<BubbleAnchor | null>({
    key: selectionBubbleKey,
    state: {
      init: () => null,
      apply(tr, value) {
        const meta = tr.getMeta(selectionBubbleKey) as
          | BubbleAnchor
          | null
          | undefined;
        // `!== undefined` is what makes an explicit null a dismiss rather than
        // "this transaction has no opinion".
        if (meta !== undefined) return meta;
        if (!value) return value;
        // A collapsed selection ends the bubble outright, not just visually:
        // the anchor is what "open" means, and a range left behind by typing
        // (which replaces the selection, so the mapping below keeps it alive
        // as the inserted text) would let the next non-empty selection re-show
        // the bubble anchored to text nobody selected.
        if (tr.selectionSet && tr.selection.empty) return null;
        if (!tr.docChanged) return value;
        // Bias the ends inward so text inserted at either edge by a
        // collaborator doesn't silently grow the range the bubble formats.
        const from = tr.mapping.map(value.from, 1);
        const to = tr.mapping.map(value.to, -1);
        return from >= to ? null : { from, to };
      },
    },
    view(editorView) {
      return new SelectionBubbleView(editorView);
    },
  });
}
