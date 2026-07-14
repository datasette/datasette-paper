/**
 * Caret guard for NodeView chrome rendered inside ProseMirror's
 * contenteditable root.
 *
 * CSS `user-select: none` alone cannot make a chrome click a no-op: Chromium
 * still moves the selection on mousedown, and with the clicked region
 * unselectable it anchors at the *nearest editable text* instead — dropping a
 * blinking caret into the block's code content or the surrounding paragraph.
 * A nested `contenteditable=false` island doesn't prevent that either. The
 * only reliable no-op is `preventDefault()` on the mousedown itself, which
 * stops the browser from touching the selection at all.
 *
 * The guard exempts:
 *  - interactive controls (buttons, selects, inputs, labels, links) — they
 *    need the default mousedown for focus / dropdown / navigation;
 *  - any `allow`-matched region — the genuinely selectable/editable surfaces
 *    (a result table, the query code). Callers must keep `allow` in lock-step
 *    with the `user-select: text` opt-ins in editor.css: an allowed region
 *    that stays `user-select: none` reintroduces the nearest-editable caret.
 *
 * The listener lives and dies with `root`; there is nothing to clean up.
 */

const INTERACTIVE_SELECTOR = "a, button, select, input, textarea, label";

export function guardChromeMousedown(root: HTMLElement, allow?: string): void {
  root.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target || target.closest(INTERACTIVE_SELECTOR)) return;
    if (allow && target.closest(allow)) return;
    e.preventDefault();
  });
}
