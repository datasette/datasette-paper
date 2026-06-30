/**
 * NodeView for `mention`: an inline atom that renders an @-mention by its
 * `actorId` alone. The view subscribes to the per-connection ActorResolver,
 * which resolves the id to a display name (+ optional avatar), and re-renders
 * on each update.
 *
 * Render states:
 *   loading   → "@<actorId>", muted until resolved
 *   ok        → "@<name>", with a small avatar <img> before the name when
 *               `avatarUrl` is present
 *
 * The NAME is user content: it is rendered via a text node, never innerHTML.
 * The `actorId` rides in `data-mention` / `title` for hover + copy.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import type { ActorResolver, ActorStatus } from "./actorResolver";

// @feat mention: NodeView — resolve actorId to a name, render inline chip
export class MentionView implements NodeView {
  dom: HTMLSpanElement;
  private actorId: string | null;
  private resolver: ActorResolver;
  private unsubscribe: (() => void) | null = null;

  constructor(
    node: PMNode,
    _view: EditorView,
    _getPos: () => number | undefined,
    resolver: ActorResolver,
  ) {
    this.resolver = resolver;
    this.dom = document.createElement("span");
    this.dom.className = "pm-mention";
    this.actorId = node.attrs.actorId ?? null;
    this.subscribe();
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.actorId == null) {
      this.renderStatus({ status: "ok", name: "?", avatarUrl: null });
      return;
    }
    // Reflect the id for hover + copy regardless of resolution state.
    this.dom.setAttribute("data-mention", this.actorId);
    this.dom.setAttribute("title", this.actorId);
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

  // It's a leaf atom we fully own — keep PM out of its internals so editing
  // around the pill behaves and it selects/deletes as a unit.
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
