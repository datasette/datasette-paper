/**
 * NodeView for the inline `tag` atom (`#slug`). Renders the `.pm-tag` chip as
 * an anchor pointing at the tag-search results page (`/-/paper/tag/<slug>`).
 *
 * Unlike `paper_link` / `mention` there is no async resolver — the slug is its
 * own label, so the view is fully synchronous.
 *
 * Click behaviour mirrors `paperLinkView`: in VIEW mode the anchor navigates
 * natively (`stopEvent` returns false, the browser follows the href). In EDIT
 * mode a plain click should place the selection rather than navigate, so we
 * suppress the default navigation there; a modifier-click still opens the
 * results page (in a new tab), matching the link UX.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";

export function tagHref(slug: string): string {
  return `/-/paper/tag/${encodeURIComponent(slug)}`;
}

// @feat tag: NodeView — render .pm-tag anchor to the tag-search page
export class TagView implements NodeView {
  dom: HTMLAnchorElement;
  private view: EditorView;
  private slug: string;

  constructor(node: PMNode, view: EditorView) {
    this.view = view;
    this.slug = String(node.attrs.tag ?? "");
    this.dom = document.createElement("a");
    this.dom.className = "pm-tag";
    this.dom.setAttribute("data-tag", this.slug);
    this.render();
    this.dom.addEventListener("click", (event) => {
      // In edit mode a bare click should select, not navigate. A modifier
      // click still opens the results page (new tab/window via the browser).
      if (this.view.editable && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
      }
    });
  }

  private render(): void {
    this.dom.setAttribute("href", tagHref(this.slug));
    this.dom.textContent = `#${this.slug || "?"}`;
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "tag") return false;
    const next = String(node.attrs.tag ?? "");
    if (next !== this.slug) {
      this.slug = next;
      this.dom.setAttribute("data-tag", this.slug);
      this.render();
    }
    return true;
  }

  // Leaf atom we fully own — keep PM out of its internals and let anchor
  // clicks reach our handler / the browser (view-mode navigation).
  ignoreMutation(): boolean {
    return true;
  }
  stopEvent(): boolean {
    return false;
  }
}
