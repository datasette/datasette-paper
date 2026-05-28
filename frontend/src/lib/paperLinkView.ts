/**
 * NodeView for `paper_link`: an inline atom that renders a cross-document
 * link by its `docId` alone. The view subscribes to the per-connection
 * LinkResolver, which resolves the id to a title + state (active / archived /
 * trashed) or to a denied / not_found status, and re-renders on each update.
 *
 * Render states:
 *   loading   → "Paper #<id>", no href
 *   ok/active → title, href set
 *   archived  → archive icon + title, muted, href set
 *   trashed   → trash icon + "<title> (in trash)", muted, href set
 *   denied    → lock icon + "Permission denied" (NEVER a title — XSS/leak)
 *   not_found → "Paper #<id>", strike-through, no href (NEVER a title)
 *
 * The TITLE is user content: it is rendered via a text node, never innerHTML.
 * Icon SVGs come from TOOLBAR_ICONS — trusted constants, safe for innerHTML.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import { TOOLBAR_ICONS } from "./icons";
import type { LinkResolver, LinkStatus } from "./linkResolver";

export class PaperLinkView implements NodeView {
  dom: HTMLAnchorElement;
  private docId: number | null;
  private resolver: LinkResolver;
  private unsubscribe: (() => void) | null = null;

  constructor(
    node: PMNode,
    _view: EditorView,
    _getPos: () => number | undefined,
    resolver: LinkResolver,
  ) {
    this.resolver = resolver;
    this.dom = document.createElement("a");
    this.dom.className = "pm-paper-link";
    this.docId = node.attrs.docId ?? null;
    this.subscribe();
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.docId == null) {
      this.renderStatus({ status: "not_found" });
      return;
    }
    this.unsubscribe = this.resolver.request(this.docId, (s) =>
      this.renderStatus(s),
    );
  }

  private setBody(iconName: string | null, text: string): void {
    this.dom.replaceChildren();
    if (iconName) {
      const span = document.createElement("span");
      span.className = "pm-paper-link-icon";
      span.setAttribute("aria-hidden", "true");
      span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${TOOLBAR_ICONS[iconName as keyof typeof TOOLBAR_ICONS]}</svg>`;
      this.dom.appendChild(span);
    }
    this.dom.appendChild(document.createTextNode(text));
  }

  private renderStatus(status: LinkStatus): void {
    // Reset modifier classes each render.
    this.dom.className = "pm-paper-link";
    const id = this.docId;
    if (status.status === "loading") {
      this.dom.removeAttribute("href");
      this.setBody(null, `Paper #${id ?? "?"}`);
      this.dom.classList.add("pm-paper-link--loading");
    } else if (status.status === "denied") {
      this.dom.removeAttribute("href");
      this.dom.classList.add("pm-paper-link--denied");
      this.setBody("lock", "Permission denied"); // NEVER render a title here
    } else if (status.status === "not_found") {
      this.dom.removeAttribute("href");
      this.dom.classList.add("pm-paper-link--missing");
      this.setBody(null, `Paper #${id ?? "?"}`); // NEVER render a title here
    } else {
      // status.status === "ok"
      this.dom.setAttribute("href", status.href);
      if (status.state === "archived") {
        this.dom.classList.add("pm-paper-link--archived");
        this.setBody("archive", status.title);
      } else if (status.state === "trashed") {
        this.dom.classList.add("pm-paper-link--trashed");
        this.setBody("trash3", `${status.title} (in trash)`);
      } else {
        this.setBody(null, status.title);
      }
    }
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "paper_link") return false;
    const next = node.attrs.docId ?? null;
    if (next !== this.docId) {
      this.docId = next;
      this.subscribe();
    }
    return true;
  }

  // It's a leaf atom we fully own — keep PM out of its internals and let
  // anchor clicks behave natively (view-mode navigation).
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
