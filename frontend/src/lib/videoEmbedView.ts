/**
 * NodeView for the `video_embed` atom — a "lite" YouTube facade modelled on
 * paulirish/lite-youtube-embed. It paints a thumbnail + play button and only
 * injects the real (privacy-enhanced, youtube-nocookie) iframe once clicked, so
 * a document with many embeds costs one <img> apiece instead of N live players.
 * Identity lives entirely in the node attrs (provider / videoId / start);
 * nothing is fetched at mount.
 *
 * XSS note: `videoId` is validated against the 11-char id grammar upstream
 * (youtube.ts on paste, youtube.py on markdown import) before it can reach a
 * node, and is only ever interpolated into a URL — never innerHTML.
 *
 * @feat video-embed: facade NodeView (thumbnail -> click-to-iframe) for video_embed
 */
import type { Node as PMNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import { youtubeEmbedUrl, youtubeThumbnailUrl } from "./youtube";

export class VideoEmbedView implements NodeView {
  dom: HTMLElement;
  private node: PMNode;
  private activated = false;

  constructor(node: PMNode) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "pm-video-embed";
    this.render();
  }

  private render(): void {
    this.activated = false;
    const provider = String(this.node.attrs.provider ?? "youtube");
    const videoId = this.node.attrs.videoId as string | null;
    if (provider !== "youtube" || !videoId) {
      const fallback = document.createElement("div");
      fallback.className = "pm-video-embed-fallback";
      fallback.textContent = "Unsupported video embed";
      this.dom.replaceChildren(fallback);
      return;
    }
    this.dom.replaceChildren(this.facade(videoId));
  }

  /** Thumbnail + play button; clicking swaps in the real iframe. */
  private facade(videoId: string): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pm-video-embed-facade";
    btn.setAttribute("aria-label", "Play video");

    const img = document.createElement("img");
    img.className = "pm-video-embed-thumb";
    img.loading = "lazy";
    img.alt = "";
    img.src = youtubeThumbnailUrl(videoId);
    btn.appendChild(img);

    const play = document.createElement("span");
    play.className = "pm-video-embed-play";
    play.setAttribute("aria-hidden", "true");
    btn.appendChild(play);

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      this.activate(videoId);
    });
    return btn;
  }

  private activate(videoId: string): void {
    if (this.activated) return;
    this.activated = true;
    const start = this.node.attrs.start as number | null;
    const iframe = document.createElement("iframe");
    iframe.className = "pm-video-embed-iframe";
    iframe.src = youtubeEmbedUrl(videoId, start);
    iframe.title = "YouTube video player";
    iframe.allow =
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.setAttribute("allowfullscreen", "true");
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    this.dom.replaceChildren(iframe);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "video_embed") return false;
    const sameVideo =
      node.attrs.provider === this.node.attrs.provider &&
      node.attrs.videoId === this.node.attrs.videoId &&
      node.attrs.start === this.node.attrs.start;
    this.node = node;
    // Only re-render (discarding an already-activated iframe) when the video
    // identity actually changed.
    if (!sameVideo) this.render();
    return true;
  }

  // We own the managed subtree; let the facade button + iframe handle their
  // own events, and keep PM from treating a click as a selection drag.
  stopEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return !!target && !!target.closest("button, iframe");
  }
  ignoreMutation(): boolean {
    return true;
  }
}
