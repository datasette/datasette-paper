/**
 * NodeView for `datasette_ref`: an inline atom that renders a reference to a
 * Datasette resource by its `ref` path alone. Subscribes to the per-connection
 * DatasetteResolver, which resolves the path to a kind + display label (or a
 * denied / not_found status), and re-renders on each update. Mirrors
 * paperLinkView.ts.
 *
 * Render states:
 *   loading   → the raw ref path, muted, no href
 *   ok        → kind icon + label, href set (native click navigates)
 *   denied    → lock icon + "Permission denied"  (NEVER a label — leak guard)
 *   not_found → raw ref, strike-through, no href  (NEVER a label)
 *
 * XSS rule: the label is data-derived and goes in via a text node, never
 * innerHTML. Icon SVGs come from TOOLBAR_ICONS — trusted constants.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import { TOOLBAR_ICONS } from "./icons";
import { kindIcon } from "./datasetteEmbed";
import type { DatasetteResolver, DatasetteStatus } from "./datasetteResolver";

/**
 * Display label for a resolved ref, built from its path identity so the pill
 * reads the same way as the resource's address:
 *   table / view → `database/table`   (e.g. transcript/entries)
 *   row          → `database/table/pk` (e.g. transcript/entries/2)
 *   database     → just its name (the label already *is* the db name)
 * Falls back to the server-supplied label when a piece is missing.
 */
export function refLabel(status: Extract<DatasetteStatus, { status: "ok" }>): string {
  if (status.kind === "row" && status.db && status.table && status.pk) {
    return `${status.db}/${status.table}/${status.pk}`;
  }
  if ((status.kind === "table" || status.kind === "view") && status.db) {
    return `${status.db}/${status.label}`;
  }
  return status.label;
}

export class DatasetteRefView implements NodeView {
  dom: HTMLAnchorElement;
  private ref: string | null;
  private resolver: DatasetteResolver;
  private unsubscribe: (() => void) | null = null;

  constructor(
    node: PMNode,
    _view: EditorView,
    _getPos: () => number | undefined,
    resolver: DatasetteResolver,
  ) {
    this.resolver = resolver;
    this.dom = document.createElement("a");
    this.dom.className = "pm-datasette-ref";
    this.ref = node.attrs.ref ?? null;
    this.subscribe();
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.ref == null) {
      this.renderStatus({ status: "not_found" });
      return;
    }
    this.dom.setAttribute("title", this.ref);
    this.unsubscribe = this.resolver.request(this.ref, (s) =>
      this.renderStatus(s),
    );
  }

  private setBody(iconName: string | null, text: string): void {
    this.dom.replaceChildren();
    if (iconName) {
      const span = document.createElement("span");
      span.className = "pm-datasette-ref-icon";
      span.setAttribute("aria-hidden", "true");
      span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${TOOLBAR_ICONS[iconName as keyof typeof TOOLBAR_ICONS] ?? ""}</svg>`;
      this.dom.appendChild(span);
    }
    this.dom.appendChild(document.createTextNode(text));
  }

  private renderStatus(status: DatasetteStatus): void {
    this.dom.className = "pm-datasette-ref";
    const raw = this.ref ?? "?";
    if (status.status === "loading") {
      this.dom.removeAttribute("href");
      this.dom.classList.add("pm-datasette-ref--loading");
      this.setBody(null, raw);
    } else if (status.status === "denied") {
      this.dom.removeAttribute("href");
      this.dom.classList.add("pm-datasette-ref--denied");
      this.setBody("lock", "Permission denied"); // NEVER a label here
    } else if (status.status === "not_found") {
      this.dom.removeAttribute("href");
      this.dom.classList.add("pm-datasette-ref--missing");
      this.setBody(null, raw); // NEVER a label here
    } else {
      this.dom.setAttribute("href", status.href);
      this.setBody(kindIcon(status.kind), refLabel(status));
    }
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "datasette_ref") return false;
    const next = node.attrs.ref ?? null;
    if (next !== this.ref) {
      this.ref = next;
      this.subscribe();
    }
    return true;
  }

  // Leaf atom we fully own — keep PM out of its internals and let anchor
  // clicks behave natively (view-mode navigation).
  ignoreMutation(): boolean {
    return true;
  }
  stopEvent(): boolean {
    return false;
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
