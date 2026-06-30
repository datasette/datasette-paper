/**
 * NodeView for `inline_embed`: an inline atom that renders a reference to a
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
import { embedIconMarkup, iconMarkup, safeHref } from "./datasetteEmbed";
import type { DatasetteResolver, DatasetteStatus } from "./datasetteResolver";

/**
 * Display label for a resolved ref, built from its path identity so the pill
 * reads the same way as the resource's address:
 *   table / view → `database/table`   (e.g. transcript/entries)
 *   row          → `database/table/pk` (e.g. transcript/entries/2)
 *   database     → just its name (the label already *is* the db name)
 * Falls back to the server-supplied label when a piece is missing.
 */
export function inlineEmbedLabel(status: Extract<DatasetteStatus, { status: "ok" }>): string {
  if (status.kind === "row" && status.db && status.table && status.pk) {
    return `${status.db}/${status.table}/${status.pk}`;
  }
  if ((status.kind === "table" || status.kind === "view") && status.db) {
    return `${status.db}/${status.label}`;
  }
  return status.label;
}

// @feat inline-embed: NodeView — resolve ref to label/kind, render pill states
export class InlineEmbedView implements NodeView {
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
    this.dom.className = "pm-inline-embed";
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

  private setBody(iconSvg: string | null, text: string): void {
    this.dom.replaceChildren();
    if (iconSvg) {
      const span = document.createElement("span");
      span.className = "pm-inline-embed-icon";
      span.setAttribute("aria-hidden", "true");
      span.innerHTML = iconSvg; // bundled icon, or a provider's raw `<svg>`
      this.dom.appendChild(span);
    }
    this.dom.appendChild(document.createTextNode(text));
  }

  private renderStatus(status: DatasetteStatus): void {
    this.dom.className = "pm-inline-embed";
    const raw = this.ref ?? "?";
    if (status.status === "loading") {
      this.dom.removeAttribute("href");
      this.dom.classList.add("pm-inline-embed--loading");
      this.setBody(null, raw);
    } else if (status.status === "denied") {
      this.dom.removeAttribute("href");
      this.dom.classList.add("pm-inline-embed--denied");
      this.setBody(iconMarkup("lock"), "Permission denied"); // NEVER a label here
    } else if (status.status === "not_found") {
      this.dom.removeAttribute("href");
      this.dom.classList.add("pm-inline-embed--missing");
      this.setBody(null, raw); // NEVER a label here
    } else {
      this.dom.setAttribute("href", safeHref(status.href));
      this.setBody(embedIconMarkup(status), inlineEmbedLabel(status));
    }
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "inline_embed") return false;
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
