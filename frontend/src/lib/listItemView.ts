/**
 * NodeView for `list_item`, branching on the `kind` attr (schema.ts).
 *
 * **bullet** (the default, and every list item in every pre-existing document)
 * is the hot path: `dom === contentDOM === <li>`, byte-identical to what
 * `toDOM` emits, with no chrome, no listeners and no attributes written. Since
 * `dom` *is* `contentDOM` here, writing anything onto it would be writing into
 * PM-managed DOM — the re-parse → redraw → re-stamp live-lock documented at
 * calloutView.ts:1-29 — so the bullet path deliberately touches nothing.
 *
 * **toggle** renders a chevron `<button>` OUTSIDE `contentDOM` (the
 * taskItemView/calloutView chrome shape) plus a `.pm-list-item-content`
 * wrapper that PM fills. Collapsing hides the item's *child lists* only via
 * CSS (`li[data-kind="toggle"][data-collapsed="true"]`); the item's own
 * paragraph stays visible and the children stay in `contentDOM` — PM-managed,
 * never detached — so positions and selection stay sane.
 *
 * The fold is a direct port of `CalloutView`'s callout-fold behaviour, which
 * already solved the two hard parts:
 *
 *  - `localCollapsed` is a per-viewer override of the shared `collapsed` attr.
 *    Read-only viewers receive the shared state over SSE (gated on
 *    `paper-view`, docs/PERMISSIONS.md §6) but cannot dispatch a step, so
 *    without a local-only fold a viewer handed a collapsed toggle could never
 *    open it. Editors clear the override on every toggle and converge on the
 *    shared attr.
 *  - `ignoreMutation` is the DENY-list form. The allow-list form (fencing only
 *    the chrome elements) misses mutations on the NodeView's own root — see
 *    the postmortem at calloutView.ts:344-356, where PM's MutationObserver saw
 *    an unexplained change on `this.dom` and self-healed by destroying and
 *    rebuilding the view.
 *
 * `applyClasses()` is the single restyle path: className, `data-kind`,
 * `data-collapsed`, the chevron icon and its aria all rebuild together.
 * Callout's earlier split `applyKind()` reset `className` wholesale and
 * dropped the collapsed state on a remote kind change; do not reintroduce
 * that shape.
 */
import { Selection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";
import { iconMarkup } from "./datasetteEmbed";
import { clampListItemKind, type ListItemKind } from "./schema";

// @feat toggle-list: NodeView — chevron in the marker slot, collapse over
// collab (setNodeMarkup), per-viewer local fold for read-only viewers; bullets
// take a bare-<li> fast path with no chrome
export class ListItemView implements NodeView {
  dom: HTMLLIElement;
  contentDOM: HTMLElement;
  private view: EditorView;
  private getPos: () => number | undefined;
  private node: PMNode;
  private kind: ListItemKind;
  /** Only built for `kind: "toggle"` — the bullet path has no chrome at all. */
  private chevron: HTMLButtonElement | null = null;
  // Per-viewer fold override. `null` = follow the shared `collapsed` attr; a
  // boolean wins over it. See the class docstring (and calloutView.ts:73-79).
  private localCollapsed: boolean | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.view = view;
    this.getPos = getPos;
    this.node = node;
    this.kind = clampListItemKind(node.attrs.kind);

    this.dom = document.createElement("li");

    if (this.kind === "bullet") {
      // Fast path: the <li> is the contentDOM. Nothing else is allocated, and
      // nothing is ever written onto it.
      this.contentDOM = this.dom;
      return;
    }

    this.chevron = document.createElement("button");
    this.chevron.type = "button";
    this.chevron.className = "pm-list-toggle";
    this.chevron.setAttribute("contenteditable", "false");
    // Keep the click from moving the PM selection into the chrome.
    this.chevron.addEventListener("mousedown", (e) => e.preventDefault());
    this.chevron.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleCollapsed();
    });

    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "pm-list-item-content";

    this.dom.appendChild(this.chevron);
    this.dom.appendChild(this.contentDOM);

    this.applyClasses();
  }

  // ── Styling ─────────────────────────────────────────────────────────────────

  /** Effective fold state — the local override if set, else the shared attr. */
  private isCollapsed(): boolean {
    return this.localCollapsed ?? this.node.attrs.collapsed === true;
  }

  /**
   * Rebuild the <li>'s classes + data attrs + chevron chrome from the current
   * kind and fold state, in one path. Never touches `contentDOM`.
   */
  private applyClasses(): void {
    if (!this.chevron) return; // bullet: no chrome, no attributes, by design
    const collapsed = this.isCollapsed();
    this.dom.className =
      "pm-list-item pm-list-item--toggle" + (collapsed ? " pm-list-item--collapsed" : "");
    this.dom.setAttribute("data-kind", this.kind);
    if (collapsed) this.dom.setAttribute("data-collapsed", "true");
    else this.dom.removeAttribute("data-collapsed");
    this.chevron.innerHTML = iconMarkup(collapsed ? "chevronRight" : "chevronDown"); // trusted constant SVG
    this.chevron.setAttribute("aria-label", collapsed ? "Expand toggle" : "Collapse toggle");
    this.chevron.setAttribute("aria-expanded", String(!collapsed));
  }

  // ── Fold toggle ─────────────────────────────────────────────────────────────

  /**
   * Flip the fold state. Editable viewers dispatch a collab `setNodeMarkup` so
   * the fold is shared; read-only viewers (who can't dispatch) flip a
   * per-viewer local override instead and dispatch nothing at all.
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
    // Collapsing hides the child lists; if the caret is inside one of them,
    // move it onto the end of the item's own (still-visible) paragraph so it
    // doesn't vanish into display:none content.
    if (next && this.node.childCount > 0) {
      const { from } = this.view.state.selection;
      const end = pos + this.node.nodeSize;
      // pos+1 opens the item; the first child spans [pos+1, firstChildEnd).
      const firstChildEnd = pos + 1 + this.node.child(0).nodeSize;
      if (from >= firstChildEnd && from < end) {
        const firstChildContentEnd = pos + 2 + this.node.child(0).content.size;
        tr = tr.setSelection(Selection.near(tr.doc.resolve(firstChildContentEnd), -1));
      }
    }
    this.view.dispatch(tr);
    this.view.focus();
  }

  // ── NodeView lifecycle ──────────────────────────────────────────────────────

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    // A kind flip swaps the whole DOM shape (bare <li> ↔ chevron + content
    // wrapper), so let PM rebuild the view. A `collapsed` flip must NOT
    // rebuild: re-rendering in place keeps the element identity, so a remote
    // fold lands on the same node the local user is looking at.
    if (clampListItemKind(node.attrs.kind) !== this.kind) return false;
    this.node = node;
    this.applyClasses();
    return true;
  }

  // Chrome (the chevron) and the <li> root itself are not part of the doc:
  // hide their mutations from PM. DENY-list, not allow-list — `applyClasses`
  // mutates `this.dom`'s className and data attrs, which no chrome element
  // *contains*, so an allow-list would leave PM's MutationObserver seeing an
  // unexplained change on the NodeView root and self-healing by destroying and
  // rebuilding the view (calloutView.ts:344-356). On the bullet path
  // `contentDOM === dom`, so this correctly ignores nothing.
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target as Node);
  }

  stopEvent(event: Event): boolean {
    return this.chevron ? this.chevron.contains(event.target as Node | null) : false;
  }
}
