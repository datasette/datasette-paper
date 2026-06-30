/**
 * Hover-driven tooltip for inline `<a>` link marks in edit mode.
 *
 * In edit mode this plugin watches `mouseover` on the editor host, finds the
 * closest plain `a[href]` link mark, and floats a tooltip beneath it showing
 * the URL plus Edit / Open / Copy actions. Following the link is also possible
 * by clicking it directly (`linkOpen.ts` opens it in a new tab); the tooltip's
 * Open button does the same. Edit swaps the bar for a small dialog (Text + URL
 * fields) that rewrites the link's range in one transaction. Only class-less
 * link marks qualify — NodeView / embed anchors are skipped (see
 * `onMouseOver`).
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
import type { Mark, MarkType, ResolvedPos } from "prosemirror-model";
import { isSafeHref } from "./safeHref";

const HIDE_DELAY_MS = 120;

interface LinkSpan {
  from: number;
  to: number;
  href: string;
  text: string;
}

/**
 * Contiguous range of the link mark covering `$pos`, plus the mark itself.
 * Walks left/right over inline children sharing the *same* mark instance
 * (same attrs), so adjacent links with different hrefs aren't merged. This is
 * the standard ProseMirror getMarkRange shape — core ships no equivalent.
 */
function markRange(
  $pos: ResolvedPos,
  type: MarkType,
): { from: number; to: number; mark: Mark } | null {
  const parent = $pos.parent;
  if (!parent.inlineContent) return null;
  // `posAtDOM(a, 0)` lands at the link's left edge → childAfter is the link
  // text. If the position sits at the link's right edge instead, childAfter is
  // the *next* (unlinked) node, so fall back to childBefore.
  let res = parent.childAfter($pos.parentOffset);
  if (!res.node || !type.isInSet(res.node.marks)) {
    res = parent.childBefore($pos.parentOffset);
  }
  if (!res.node) return null;
  const mark = type.isInSet(res.node.marks);
  if (!mark) return null;
  let startIndex = res.index;
  let endIndex = res.index + 1;
  let startPos = $pos.start() + res.offset;
  let endPos = startPos + res.node.nodeSize;
  while (startIndex > 0 && mark.isInSet(parent.child(startIndex - 1).marks)) {
    startIndex -= 1;
    startPos -= parent.child(startIndex).nodeSize;
  }
  while (
    endIndex < parent.childCount &&
    mark.isInSet(parent.child(endIndex).marks)
  ) {
    endPos += parent.child(endIndex).nodeSize;
    endIndex += 1;
  }
  return { from: startPos, to: endPos, mark };
}

/** Resolve the doc range + current text/href for a rendered `<a>` link mark. */
function findLinkSpan(
  view: EditorView,
  link: HTMLAnchorElement,
): LinkSpan | null {
  const linkType = view.state.schema.marks.link;
  if (!linkType) return null;
  let pos: number;
  try {
    pos = view.posAtDOM(link, 0);
  } catch {
    // posAtDOM throws if the node isn't in the document map (e.g. mid-teardown).
    return null;
  }
  const range = markRange(view.state.doc.resolve(pos), linkType);
  if (!range) return null;
  return {
    from: range.from,
    to: range.to,
    href: (range.mark.attrs.href as string) ?? "",
    text: view.state.doc.textBetween(range.from, range.to),
  };
}

class LinkTooltipView {
  private host: HTMLElement;
  private root: HTMLDivElement;
  private urlEl: HTMLSpanElement;
  private editBtn: HTMLButtonElement;
  private openBtn: HTMLAnchorElement;
  private copyBtn: HTMLButtonElement;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private currentLink: HTMLAnchorElement | null = null;
  // Edit dialog. Only built when `host` exists; in the detached branch these
  // stay dummy elements and no handlers are bound, so they're never used.
  private dialog: HTMLDivElement;
  // Assigned in buildDialog() / the detached-branch fallback — `!` because
  // TS doesn't track the helper-method assignment as definite.
  private labelInput!: HTMLInputElement;
  private urlInput!: HTMLInputElement;
  private errEl!: HTMLDivElement;
  private editSpan: LinkSpan | null = null;
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
      this.editBtn = document.createElement("button");
      this.openBtn = document.createElement("a");
      this.copyBtn = document.createElement("button");
      this.dialog = document.createElement("div");
      this.labelInput = document.createElement("input");
      this.urlInput = document.createElement("input");
      this.errEl = document.createElement("div");
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

    this.editBtn = document.createElement("button");
    this.editBtn.type = "button";
    this.editBtn.className = "pm-link-tooltip-btn pm-link-tooltip-edit";
    this.editBtn.textContent = "Edit";
    this.editBtn.title = "Edit link text and URL";
    bar.appendChild(this.editBtn);

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

    this.dialog = this.buildDialog();
    host.appendChild(this.dialog);

    this.bind(host, "mouseover", this.onMouseOver);
    this.bind(host, "mouseout", this.onMouseOut);
    this.bind(this.copyBtn, "click", this.onCopyClick);
    this.bind(this.editBtn, "click", this.onEditClick);
  }

  /**
   * Build the floating edit dialog (Text + URL fields, Save / Cancel). Kept
   * hidden until the Edit button opens it. Plain DOM, like the tooltip bar.
   */
  private buildDialog(): HTMLDivElement {
    const dialog = document.createElement("div");
    dialog.className = "pm-link-edit-dialog";
    dialog.style.display = "none";

    const makeField = (
      labelText: string,
      placeholder: string,
    ): HTMLInputElement => {
      const field = document.createElement("label");
      field.className = "pm-link-edit-field";
      const span = document.createElement("span");
      span.className = "pm-link-edit-label";
      span.textContent = labelText;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "pm-link-edit-input";
      input.placeholder = placeholder;
      field.appendChild(span);
      field.appendChild(input);
      dialog.appendChild(field);
      return input;
    };

    this.labelInput = makeField("Text", "Link text");
    this.urlInput = makeField("URL", "https://…");

    this.errEl = document.createElement("div");
    this.errEl.className = "pm-link-edit-err";
    dialog.appendChild(this.errEl);

    const actions = document.createElement("div");
    actions.className = "pm-link-edit-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pm-link-tooltip-btn pm-link-edit-cancel";
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "pm-link-tooltip-btn pm-link-edit-save";
    save.textContent = "Save";
    actions.appendChild(cancel);
    actions.appendChild(save);
    dialog.appendChild(actions);

    this.bind(save, "click", this.onSaveClick);
    this.bind(cancel, "click", this.onCancelClick);
    this.bind(this.labelInput, "keydown", this.onDialogKeydown);
    this.bind(this.urlInput, "keydown", this.onDialogKeydown);
    return dialog;
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
      // Only plain `<a>` link marks get the tooltip. NodeView / embed anchors
      // (`pm-tag`, `pm-paper-link`, the `pm-block-embed` title link, …) carry a
      // `pm-*` class and own their own affordances — a hover popup there was
      // noise. Same class-less discriminator linkOpen.ts uses.
      if (link.className.trim() !== "") return;
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
    this.position(link, this.root);
    this.root.style.display = "block";
  }

  private position(link: HTMLAnchorElement, el: HTMLElement): void {
    // Use the link's last client rect so a wrapping link anchors the
    // popup under its visual end instead of jumping back to line 1.
    const rects = link.getClientRects();
    const rect = rects[rects.length - 1] ?? link.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    const top = rect.bottom - hostRect.top + 4;
    let left = rect.left - hostRect.left;
    // Keep the popup within the host horizontally so it doesn't shoot
    // off into the page margin on very long URLs.
    const maxLeft = Math.max(0, this.host.clientWidth - el.offsetWidth);
    if (left > maxLeft) left = maxLeft;
    if (left < 0) left = 0;
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }

  // ── Edit dialog ────────────────────────────────────────────────────────────

  private onEditClick = (): void => {
    if (!this.currentLink || !this.view.editable) return;
    const span = findLinkSpan(this.view, this.currentLink);
    if (!span) return;
    this.editSpan = span;
    this.labelInput.value = span.text;
    this.urlInput.value = span.href;
    this.errEl.textContent = "";
    // Swap the hover bar for the dialog, anchored at the same link.
    this.cancelHide();
    this.position(this.currentLink, this.dialog);
    this.root.style.display = "none";
    this.dialog.style.display = "block";
    document.addEventListener("mousedown", this.onOutsideMouseDown, true);
    this.urlInput.focus();
    this.urlInput.select();
  };

  private onSaveClick = (): void => {
    const span = this.editSpan;
    if (!span) return;
    const href = this.urlInput.value.trim();
    // Empty label → fall back to the URL so we never build an empty text node.
    const text = this.labelInput.value.trim() || href;
    if (!href) {
      this.errEl.textContent = "Enter a URL.";
      return;
    }
    if (!isSafeHref(href)) {
      this.errEl.textContent =
        "Only http, https, mailto, tel, and # links are allowed.";
      return;
    }
    this.applyEdit(span, text, href);
    this.closeEditor();
    this.view.focus();
  };

  private onCancelClick = (): void => {
    this.closeEditor();
    this.view.focus();
  };

  private onDialogKeydown = (e: Event): void => {
    const ev = e as KeyboardEvent;
    if (ev.key === "Enter") {
      ev.preventDefault();
      this.onSaveClick();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      this.onCancelClick();
    }
  };

  private onOutsideMouseDown = (e: Event): void => {
    const target = e.target as Node | null;
    if (target && this.dialog.contains(target)) return;
    this.closeEditor();
  };

  /**
   * Replace the link's range with a fresh text node carrying the new label and
   * the new href. Non-link marks on the range's first node (bold/italic/…) are
   * preserved; any mixed formatting *inside* the link collapses to that node's
   * marks — an acceptable trade for a single-field edit.
   */
  private applyEdit(span: LinkSpan, text: string, href: string): void {
    const state = this.view.state;
    const linkType = state.schema.marks.link;
    const node = state.doc.nodeAt(span.from);
    const base = (node ? node.marks : []).filter((m) => m.type !== linkType);
    const marks = linkType.create({ href }).addToSet(base);
    const tr = state.tr.replaceWith(
      span.from,
      span.to,
      state.schema.text(text, marks),
    );
    this.view.dispatch(tr);
  }

  private closeEditor(): void {
    this.dialog.style.display = "none";
    this.editSpan = null;
    document.removeEventListener("mousedown", this.onOutsideMouseDown, true);
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
    // If the view flipped to read-only while the tooltip/dialog was open
    // (rare but possible), close them.
    if (!this.view.editable) {
      if (this.currentLink) this.hide();
      if (this.editSpan) this.closeEditor();
    }
  }

  destroy(): void {
    this.cancelHide();
    this.closeEditor();
    for (const { target, type, fn } of this.listeners) {
      target.removeEventListener(type, fn);
    }
    this.listeners = [];
    this.root.remove();
    this.dialog.remove();
  }
}

export function linkTooltipPlugin(): Plugin {
  return new Plugin({
    view(editorView) {
      return new LinkTooltipView(editorView);
    },
  });
}
