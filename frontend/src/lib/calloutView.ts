/**
 * NodeView for `callout` (GitHub-style admonition).
 *
 * Structure follows the taskItemView/codeBlockView precedent: `dom` is the
 * `.pm-callout` wrapper holding three pieces of chrome (an icon button that
 * opens the kind picker, the picker popup, and a fold chevron) plus a separate
 * `contentDOM` that PM fills with the `callout_title` child and the body
 * blocks. Collapsing hides every body block via CSS (`.pm-callout--collapsed`
 * → `display:none` on `.pm-callout-content > :not(.pm-callout-title)`) — the
 * body stays in `contentDOM` (PM-managed, never detached). Keeping the chrome
 * OUT of `contentDOM` (rather than injecting it into a `dom === contentDOM`
 * outer div) means PM's child reconciliation never trips over DOM it doesn't
 * own — `ignoreMutation` / `stopEvent` fence the chrome off.
 *
 * `update(node)` re-styles in place on a `kind` change (class + `data-callout`
 * + icon path), so a remote or local kind flip never rebuilds the view. The
 * empty-title placeholder is pure CSS: the `pm-callout--{kind}` wrapper class
 * sets a `--callout-label` custom property ("Note"/"Tip"/…) alongside the
 * accent, and `.pm-callout-title:empty::before { content: var(--callout-label) }`
 * (editor.css) renders it. The view must NOT write into `contentDOM` (the
 * earlier design stamped a `data-kind-label` attribute on the title): any
 * mutation there is one PM's observer doesn't ignore, and the resulting DOM
 * re-parse → redraw → re-stamp cycle live-locked the page on docs with 2+
 * callouts.
 *
 * The kind picker mirrors codeBlockView's language popup chrome: 5 kind rows
 * (icon + label, current kind checked) then a divider and the "Quote" /
 * "Remove callout" rows, which run the calloutToQuote / unwrapCallout commands.
 */
import { Selection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";
import { iconMarkup } from "./datasetteEmbed";
import { clampCalloutKind, type CalloutKind } from "./schema";
import { calloutToQuote, unwrapCallout } from "./callout";

// @feat callout: NodeView — icon button + kind picker (setNodeMarkup over
// collab) + Quote/Remove rows; restyles on kind change; empty-title placeholder

/** Bootstrap-icon slot per kind (icons.ts). */
const KIND_ICON: Record<CalloutKind, string> = {
  note: "infoCircle",
  tip: "lightbulb",
  important: "exclamationSquare",
  warning: "exclamationTriangle",
  caution: "exclamationOctagon",
};

/** Human label per kind — the picker row text and the empty-title placeholder. */
const KIND_LABEL: Record<CalloutKind, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

const KIND_ORDER: CalloutKind[] = ["note", "tip", "important", "warning", "caution"];

export class CalloutView implements NodeView {
  dom: HTMLDivElement;
  contentDOM: HTMLDivElement;
  private view: EditorView;
  private getPos: () => number | undefined;
  private node: PMNode;
  private kind: CalloutKind;

  private iconBtn: HTMLButtonElement;
  private popupEl: HTMLDivElement;
  private popupOpen = false;

  private foldBtn: HTMLButtonElement;
  // Per-viewer fold override. `null` = follow the shared `collapsed` attr;
  // a boolean wins over it. Read-only viewers (who receive the shared state
  // over SSE but can't dispatch a step to change it) toggle this instead, so
  // they can still expand a callout an editor collapsed. Editors clear it on
  // every toggle so they converge on the shared attr. See plans/callout/
  // 03-collapse-fold.md.
  private localCollapsed: boolean | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.view = view;
    this.getPos = getPos;
    this.node = node;
    this.kind = clampCalloutKind(node.attrs.kind);

    this.dom = document.createElement("div");
    this.dom.className = "pm-callout";

    // Icon button — opens the kind picker. Non-editable chrome; a mousedown
    // preventDefault keeps the click from moving the PM selection into it.
    this.iconBtn = document.createElement("button");
    this.iconBtn.type = "button";
    this.iconBtn.className = "pm-callout-kind";
    this.iconBtn.setAttribute("contenteditable", "false");
    this.iconBtn.addEventListener("mousedown", (e) => e.preventDefault());
    this.iconBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.togglePicker();
    });

    this.popupEl = document.createElement("div");
    this.popupEl.className = "pm-callout-kind-popup";
    this.popupEl.setAttribute("contenteditable", "false");

    // Fold toggle — top-right chrome. Hides the body (all but the title) when
    // collapsed. Same non-editable-chrome pattern as the icon button.
    this.foldBtn = document.createElement("button");
    this.foldBtn.type = "button";
    this.foldBtn.className = "pm-callout-fold";
    this.foldBtn.setAttribute("contenteditable", "false");
    this.foldBtn.addEventListener("mousedown", (e) => e.preventDefault());
    this.foldBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleCollapsed();
    });

    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "pm-callout-content";

    this.dom.appendChild(this.iconBtn);
    this.dom.appendChild(this.popupEl);
    this.dom.appendChild(this.foldBtn);
    this.dom.appendChild(this.contentDOM);

    this.applyClasses();
  }

  // ── Styling ───────────────────────────────────────────────────────────────

  /** Effective fold state — the local override if set, else the shared attr. */
  private isCollapsed(): boolean {
    return this.localCollapsed ?? this.node.attrs.collapsed === true;
  }

  /**
   * Rebuild the wrapper's classes + attrs + chrome from the current kind and
   * fold state. Wholesale so a `kind` change and a `collapsed` change share one
   * path — the old `applyKind()` reset `className` and would have dropped the
   * `--collapsed` / `--picker-open` classes on any restyle.
   */
  private applyClasses(): void {
    const collapsed = this.isCollapsed();
    this.dom.className =
      `pm-callout pm-callout--${this.kind}` +
      (collapsed ? " pm-callout--collapsed" : "") +
      (this.popupOpen ? " pm-callout--picker-open" : "");
    this.dom.setAttribute("data-callout", this.kind);
    if (collapsed) this.dom.setAttribute("data-collapsed", "true");
    else this.dom.removeAttribute("data-collapsed");
    this.iconBtn.innerHTML = iconMarkup(KIND_ICON[this.kind]); // trusted constant SVG
    this.iconBtn.setAttribute("aria-label", `Callout kind: ${KIND_LABEL[this.kind]}`);
    // @feat callout: chevron reflects (and toggles) the fold state
    this.foldBtn.innerHTML = iconMarkup(collapsed ? "chevronRight" : "chevronDown");
    this.foldBtn.setAttribute("aria-label", collapsed ? "Expand callout" : "Collapse callout");
    this.foldBtn.setAttribute("aria-expanded", String(!collapsed));
  }

  // ── Fold toggle ─────────────────────────────────────────────────────────────

  /**
   * Flip the fold state. Editable viewers dispatch a collab `setNodeMarkup` so
   * the fold is shared + round-trips to markdown; read-only viewers (who can't
   * dispatch) flip a per-viewer local override instead.
   */
  private toggleCollapsed(): void {
    const next = !this.isCollapsed();
    if (!this.view.editable) {
      // Read-only: local-only fold, no step.
      this.localCollapsed = next;
      this.applyClasses();
      return;
    }
    const pos = this.getPos();
    if (pos == null) return;
    // Editors converge on the shared attr — drop any stale local override.
    this.localCollapsed = null;
    let tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
      ...this.node.attrs,
      collapsed: next,
    });
    // Collapsing hides the body; if the caret is inside it, move it onto the
    // (still-visible) title so it doesn't vanish into display:none content.
    if (next) {
      const { from } = this.view.state.selection;
      const end = pos + this.node.nodeSize;
      if (from > pos && from < end) {
        const titleContentEnd = pos + 2 + this.node.child(0).content.size;
        tr = tr.setSelection(Selection.near(tr.doc.resolve(titleContentEnd), -1));
      }
    }
    this.view.dispatch(tr);
    this.view.focus();
  }

  // ── Kind picker ─────────────────────────────────────────────────────────────

  private togglePicker(): void {
    // In view mode the icon is just a static kind indicator — no picker.
    if (!this.view.editable) return;
    if (this.popupOpen) this.closePicker();
    else this.openPicker();
  }

  private openPicker(): void {
    if (this.popupOpen) return;
    this.popupOpen = true;
    this.dom.classList.add("pm-callout--picker-open");
    this.popupEl.classList.add("pm-callout-kind-popup--open");
    this.renderRows();
    document.addEventListener("mousedown", this.onOutsideClick, true);
    document.addEventListener("keydown", this.onDocKeydown, true);
  }

  private closePicker(): void {
    if (!this.popupOpen) return;
    this.popupOpen = false;
    this.dom.classList.remove("pm-callout--picker-open");
    this.popupEl.classList.remove("pm-callout-kind-popup--open");
    document.removeEventListener("mousedown", this.onOutsideClick, true);
    document.removeEventListener("keydown", this.onDocKeydown, true);
  }

  private onOutsideClick = (e: MouseEvent): void => {
    if (!this.dom.contains(e.target as Node)) this.closePicker();
  };

  private onDocKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      this.closePicker();
      this.view.focus();
    }
  };

  private renderRows(): void {
    this.popupEl.replaceChildren();
    for (const kind of KIND_ORDER) {
      this.popupEl.appendChild(
        this.makeRow(KIND_ICON[kind], KIND_LABEL[kind], kind === this.kind, () =>
          this.selectKind(kind),
        ),
      );
    }
    const divider = document.createElement("div");
    divider.className = "pm-callout-kind-divider";
    this.popupEl.appendChild(divider);
    this.popupEl.appendChild(
      this.makeRow("quote", "Quote", false, () => this.runCommand(calloutToQuote)),
    );
    this.popupEl.appendChild(
      this.makeRow("x", "Remove callout", false, () => this.runCommand(unwrapCallout)),
    );
  }

  private makeRow(
    icon: string,
    label: string,
    checked: boolean,
    onSelect: () => void,
  ): HTMLButtonElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pm-callout-kind-item";
    if (checked) row.classList.add("pm-callout-kind-item--checked");

    const iconEl = document.createElement("span");
    iconEl.className = "pm-callout-kind-item-icon";
    iconEl.setAttribute("aria-hidden", "true");
    iconEl.innerHTML = iconMarkup(icon); // trusted constant SVG
    row.appendChild(iconEl);

    const labelEl = document.createElement("span");
    labelEl.className = "pm-callout-kind-item-label";
    labelEl.textContent = label; // text node
    row.appendChild(labelEl);

    if (checked) {
      const tick = document.createElement("span");
      tick.className = "pm-callout-kind-item-check";
      tick.setAttribute("aria-hidden", "true");
      tick.innerHTML = iconMarkup("check");
      row.appendChild(tick);
    }

    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onSelect();
    });
    return row;
  }

  /** Change the callout's kind via a collaborating setNodeMarkup. */
  private selectKind(kind: CalloutKind): void {
    this.closePicker();
    if (kind === this.kind) {
      this.view.focus();
      return;
    }
    const pos = this.getPos();
    if (pos == null) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, kind }),
    );
    this.view.focus();
  }

  private runCommand(command: typeof calloutToQuote): void {
    this.closePicker();
    const pos = this.getPos();
    if (pos == null) return;
    // The picker click leaves the caret wherever it was; drop it into THIS
    // callout first so the selection-based command always acts on this block.
    this.view.dispatch(
      this.view.state.tr.setSelection(
        Selection.near(this.view.state.doc.resolve(pos + 1), 1),
      ),
    );
    command(this.view.state, this.view.dispatch, this.view);
    this.view.focus();
  }

  // ── NodeView lifecycle ──────────────────────────────────────────────────────

  update(node: PMNode): boolean {
    if (node.type.name !== "callout") return false;
    this.node = node;
    this.kind = clampCalloutKind(node.attrs.kind);
    // Restyle unconditionally — cheap, and covers both a remote `kind` flip and
    // a remote `collapsed` flip in one path.
    this.applyClasses();
    if (this.popupOpen) this.renderRows();
    return true;
  }

  destroy(): void {
    this.closePicker();
  }

  // Chrome (button + popup) is not part of the doc: hide its mutations from PM
  // and swallow its events so clicks don't move the PM selection. Bug fixed
  // here (found via e2e, plans/callout/tickets/04): the allow-list form (only
  // iconBtn/popupEl fenced) missed mutations on `this.dom` itself — e.g.
  // openPicker's own `this.dom.classList.add("pm-callout--picker-open")`.
  // `Node.contains(self)` is true, but a class change ON `this.dom` isn't
  // "contained" by either iconBtn or popupEl (both are children, not
  // ancestors), so PM's MutationObserver saw an "unexplained" DOM change on
  // the NodeView's own root and self-healed by destroying + rebuilding it —
  // instantly closing the picker that had just opened. Mirrors
  // codeBlockView.ts's `ignoreMutation`: deny-list everything outside the
  // real PM-managed surface (`contentDOM`, the title + body) instead of
  // allow-listing specific chrome nodes.
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target as Node);
  }

  stopEvent(event: Event): boolean {
    const target = event.target as Node | null;
    return (
      this.iconBtn.contains(target) ||
      this.popupEl.contains(target) ||
      this.foldBtn.contains(target)
    );
  }
}
