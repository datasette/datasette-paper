/**
 * NodeView for `mention`: an inline atom that renders an @-mention by its
 * `actorId` alone. The view subscribes to the per-connection ActorResolver,
 * which resolves the id to a display name (+ optional avatar), and re-renders
 * on each update. The chip is an anchor to the actor's profile page
 * (`/-/profile/<actorId>`).
 *
 * Render states:
 *   loading   → "@<actorId>", muted until resolved
 *   ok        → "@<name>", with a small avatar <img> before the name when
 *               `avatarUrl` is present
 *
 * Click behaviour mirrors `tagView`: in VIEW mode the anchor navigates
 * natively (`stopEvent` returns false, the browser follows the href). In EDIT
 * mode a plain click should place the selection rather than navigate, so we
 * suppress the default navigation there; a modifier-click still opens the
 * profile (in a new tab), matching the link UX. Clicking a pill that is
 * ALREADY node-selected navigates too — first click selects, second click
 * opens the profile.
 *
 * The NAME is user content: it is rendered via a text node, never innerHTML.
 * The `actorId` rides in `data-mention` / `title` for hover + copy.
 */
import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import type { ActorResolver, ActorStatus } from "./actorResolver";

export function profileHref(actorId: string): string {
  return `/-/profile/${encodeURIComponent(actorId)}`;
}

// @feat mention: NodeView — resolve actorId to a name, render inline chip linking to the profile
export class MentionView implements NodeView {
  dom: HTMLAnchorElement;
  private actorId: string | null;
  private resolver: ActorResolver;
  private unsubscribe: (() => void) | null = null;

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    resolver: ActorResolver,
  ) {
    this.resolver = resolver;
    this.dom = document.createElement("a");
    this.dom.className = "pm-mention";
    this.actorId = node.attrs.actorId ?? null;
    // PM node-selects an atom on mousedown, so by click time the selection is
    // always on this node. Capture the PRE-mousedown state (our listener on
    // the inner dom fires before PM's on view.dom) to tell a first click
    // (select) from a click on an already-selected pill (navigate).
    let wasSelected = false;
    this.dom.addEventListener("mousedown", () => {
      const pos = getPos();
      const sel = view.state.selection;
      wasSelected =
        pos != null && sel instanceof NodeSelection && sel.from === pos;
    });
    this.dom.addEventListener("click", (event) => {
      // In edit mode a bare click should select, not navigate. A modifier
      // click, or a bare click on an already-selected pill, still opens the
      // profile via the browser.
      if (view.editable && !event.metaKey && !event.ctrlKey && !wasSelected) {
        event.preventDefault();
      }
    });
    this.subscribe();
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.actorId == null) {
      this.dom.removeAttribute("href");
      this.renderStatus({ status: "ok", name: "?", avatarUrl: null });
      return;
    }
    // Reflect the id for hover + copy regardless of resolution state.
    this.dom.setAttribute("data-mention", this.actorId);
    this.dom.setAttribute("title", this.actorId);
    this.dom.setAttribute("href", profileHref(this.actorId));
    this.unsubscribe = this.resolver.request(this.actorId, (s) =>
      this.renderStatus(s),
    );
  }

  private setBody(avatarUrl: string | null, text: string): void {
    this.dom.replaceChildren();
    if (avatarUrl) {
      const img = document.createElement("img");
      img.className = "pm-mention-avatar";
      img.src = avatarUrl;
      img.alt = "";
      img.setAttribute("aria-hidden", "true");
      this.dom.appendChild(img);
    }
    this.dom.appendChild(document.createTextNode(text));
  }

  private renderStatus(status: ActorStatus): void {
    // Reset modifier classes each render.
    this.dom.className = "pm-mention";
    const id = this.actorId;
    if (status.status === "loading") {
      this.dom.classList.add("pm-mention--loading");
      this.setBody(null, `@${id ?? "?"}`);
    } else {
      this.setBody(status.avatarUrl, `@${status.name}`);
    }
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "mention") return false;
    const next = node.attrs.actorId ?? null;
    if (next !== this.actorId) {
      this.actorId = next;
      this.subscribe();
    }
    return true;
  }

  // It's a leaf atom we fully own — keep PM out of its internals and let
  // anchor clicks reach our handler / the browser (view-mode navigation).
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
