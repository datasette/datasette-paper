/**
 * Hover-driven tooltip for inline `<a>` link marks in edit mode.
 *
 * In edit mode ProseMirror eats anchor clicks (the `<a>` is just rendered
 * markup over text), so the user has no built-in way to see or follow a
 * link's URL. This plugin watches `mouseover` on the editor host, finds
 * the closest `a[href]` ancestor, and floats a tooltip beneath the link
 * with the URL plus Open / Copy actions.
 *
 * View mode short-circuits — the browser handles link clicks natively
 * there, so a hover tooltip would just duplicate browser UI.
 *
 * Position: tooltip is appended to `view.dom.parentElement` (the
 * `.editor-host`), positioned absolutely from the link's bounding rect.
 * The host is already `position: relative` for the table tooltip, so we
 * piggy-back on the same coordinate space.
 *
 * Hide timing: a small `HIDE_DELAY_MS` window lets the user move from the
 * link onto the tooltip without it flicker-disappearing. The window is
 * cancelled on re-enter and re-armed on leave; cleared synchronously on
 * destroy so a stale timer doesn't fire into a torn-down view.
 */

import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

const HIDE_DELAY_MS = 120;

class LinkTooltipView {
  private host: HTMLElement;
  private root: HTMLDivElement;
  private urlEl: HTMLSpanElement;
  private openBtn: HTMLAnchorElement;
  private copyBtn: HTMLButtonElement;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private currentLink: HTMLAnchorElement | null = null;
  // Bound listeners so destroy() can detach exactly what was attached.
  private listeners: Array<{
    target: EventTarget;
    type: string;
    fn: EventListenerOrEventListenerObject;
  }> = [];

  constructor(private view: EditorView) {
    const host = view.dom.parentElement;
    if (!host) {
      // EditorView mounted detached from any parent — there's nothing to
      // anchor the tooltip to. Bail; destroy() is a no-op.
      this.host = document.createElement("div");
      this.root = document.createElement("div");
      this.urlEl = document.createElement("span");
      this.openBtn = document.createElement("a");
      this.copyBtn = document.createElement("button");
      return;
    }
    this.host = host;
    this.root = document.createElement("div");
    this.root.className = "pm-link-tooltip-root";
    this.root.style.display = "none";

    const bar = document.createElement("div");
    bar.className = "pm-link-tooltip-bar";
    this.root.appendChild(bar);

    this.urlEl = document.createElement("span");
    this.urlEl.className = "pm-link-tooltip-url";
    bar.appendChild(this.urlEl);

    this.openBtn = document.createElement("a");
    this.openBtn.className = "pm-link-tooltip-btn pm-link-tooltip-open";
    this.openBtn.target = "_blank";
    this.openBtn.rel = "noreferrer noopener";
    this.openBtn.textContent = "Open";
    this.openBtn.title = "Open link in a new tab";
    bar.appendChild(this.openBtn);

    this.copyBtn = document.createElement("button");
    this.copyBtn.type = "button";
    this.copyBtn.className = "pm-link-tooltip-btn pm-link-tooltip-copy";
    this.copyBtn.textContent = "Copy";
    this.copyBtn.title = "Copy link to clipboard";
    bar.appendChild(this.copyBtn);

    host.appendChild(this.root);

    this.bind(host, "mouseover", this.onMouseOver);
    this.bind(host, "mouseout", this.onMouseOut);
    this.bind(this.copyBtn, "click", this.onCopyClick);
  }

  private bind(
    target: EventTarget,
    type: string,
    fn: (e: Event) => void,
  ): void {
    const listener = fn as EventListenerOrEventListenerObject;
    target.addEventListener(type, listener);
    this.listeners.push({ target, type, fn: listener });
  }

  private onMouseOver = (e: Event): void => {
    const target = e.target as Element | null;
    if (!target) return;
    const link = target.closest?.("a[href]") as HTMLAnchorElement | null;
    if (link && this.host.contains(link)) {
      // A link the user might want to open/copy. Edit-mode only; in view
      // mode the browser already handles the click.
      if (!this.view.editable) return;
      // Skip our own internal Open anchor — it lives inside the tooltip.
      if (link.closest(".pm-link-tooltip-root")) {
        this.cancelHide();
        return;
      }
      this.cancelHide();
      this.show(link);
      return;
    }
    if (target.closest?.(".pm-link-tooltip-root")) {
      // Mouse moved onto the tooltip itself — keep it open so the user
      // can click the buttons.
      this.cancelHide();
    }
  };

  private onMouseOut = (e: Event): void => {
    if (!this.currentLink) return;
    const target = e.target as Element | null;
    const related = (e as MouseEvent).relatedTarget as Element | null;
    // We only care about leaving the link or the tooltip — other mouseouts
    // (e.g. moving between children of the editor body) shouldn't hide.
    const wasInLink = target?.closest?.("a[href]");
    const wasInTooltip = target?.closest?.(".pm-link-tooltip-root");
    if (!wasInLink && !wasInTooltip) return;
    if (
      related?.closest?.("a[href]") &&
      this.host.contains(related) &&
      !related.closest(".pm-link-tooltip-root")
    ) {
      // Moved to another (non-tooltip) link — let the mouseover handler
      // swap the target instead of flicker-hiding first.
      return;
    }
    if (related?.closest?.(".pm-link-tooltip-root")) return;
    this.scheduleHide();
  };

  private onCopyClick = (): void => {
    const href = this.currentLink?.getAttribute("href");
    if (!href) return;
    // navigator.clipboard is undefined in jsdom; ignore failures so the
    // unit test environment doesn't error here.
    void navigator.clipboard?.writeText(href);
    const prev = this.copyBtn.textContent;
    this.copyBtn.textContent = "Copied";
    setTimeout(() => {
      // Only restore if the tooltip hasn't been re-targeted to a different
      // link since the click — otherwise we'd overwrite a fresh label.
      if (this.copyBtn.textContent === "Copied") {
        this.copyBtn.textContent = prev ?? "Copy";
      }
    }, 1200);
  };

  private show(link: HTMLAnchorElement): void {
    this.currentLink = link;
    const href = link.getAttribute("href") ?? "";
    this.urlEl.textContent = href;
    this.openBtn.href = href;
    this.position(link);
    this.root.style.display = "block";
  }

  private position(link: HTMLAnchorElement): void {
    // Use the link's last client rect so a wrapping link anchors the
    // tooltip under its visual end instead of jumping back to line 1.
    const rects = link.getClientRects();
    const rect = rects[rects.length - 1] ?? link.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    const top = rect.bottom - hostRect.top + 4;
    let left = rect.left - hostRect.left;
    // Keep the tooltip within the host horizontally so it doesn't shoot
    // off into the page margin on very long URLs.
    const maxLeft = Math.max(0, this.host.clientWidth - this.root.offsetWidth);
    if (left > maxLeft) left = maxLeft;
    if (left < 0) left = 0;
    this.root.style.top = `${top}px`;
    this.root.style.left = `${left}px`;
  }

  private scheduleHide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.hide();
    }, HIDE_DELAY_MS);
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private hide(): void {
    this.root.style.display = "none";
    this.currentLink = null;
  }

  update(): void {
    // If the view flipped to read-only while the tooltip was open
    // (rare but possible), hide it.
    if (!this.view.editable && this.currentLink) this.hide();
  }

  destroy(): void {
    this.cancelHide();
    for (const { target, type, fn } of this.listeners) {
      target.removeEventListener(type, fn);
    }
    this.listeners = [];
    this.root.remove();
  }
}

export function linkTooltipPlugin(): Plugin {
  return new Plugin({
    view(editorView) {
      return new LinkTooltipView(editorView);
    },
  });
}
