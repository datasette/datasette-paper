// Page stabilization + navigation + capture helpers shared by every shot.
import { PAPER, VIEWPORT } from "./config.mjs";

// Per-page stabilization, injected on the context (see runner) so it survives
// navigation. Hides the blinking caret + the installed debug bar and disables
// transitions/animations.
export const STABILITY_CSS = `*, *::before, *::after {
  caret-color: transparent !important;
  transition: none !important;
  animation: none !important;
}`;

// Rewrite the moving text — relative timestamps, the "N users online" count,
// "Deletes in N days" — to fixed strings so a re-run with no UI change produces
// no binary diff. Applied right before each capture.
export async function freezeVolatile(page) {
  await page.evaluate(() => {
    const set = (sel, text) =>
      document.querySelectorAll(sel).forEach((el) => (el.textContent = text));
    // Editor header.
    set(".updated-at", "edited just now");
    set(".users", "3 users online");
    // Index list: Updated column (3rd cell) + trash "Deletes in N days".
    document
      .querySelectorAll(".paper-index tbody tr td:nth-child(3)")
      .forEach((el) => (el.textContent = "2 hours ago"));
    set(".delete-at", "Deletes in 7 days");
  });
}

export async function gotoEditor(page, id) {
  await page.goto(`${PAPER}/doc/${id}`);
  const pm = page.locator(".ProseMirror");
  await pm.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(
    () => document.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "true",
    { timeout: 10_000 },
  );
  // Header metadata loads via a follow-up fetch; wait for it so the freeze
  // has something to rewrite and the avatar/title aren't mid-render.
  await page.locator(".doc-header .meta").waitFor({ state: "visible", timeout: 10_000 });
}

// Screenshot the bounding-box union of several selectors, padded — used to
// frame a feature plus its detached floating UI (the table action bar lives in
// a body-appended root, so an element shot of the table alone would clip it).
export async function shotUnion(page, selectors, file, pad = 16) {
  const boxes = [];
  for (const sel of selectors) {
    const box = await page.locator(sel).first().boundingBox();
    if (box) boxes.push(box);
  }
  if (!boxes.length) throw new Error(`no boxes for ${selectors.join(", ")}`);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const clip = {
    x: Math.max(0, x - pad),
    y: Math.max(0, y - pad),
    width: Math.min(VIEWPORT.width, right - x + pad * 2),
    height: bottom - y + pad * 2,
  };
  await page.screenshot({ path: file, clip });
}

// ---------------------------------------------------------------------------
// Shared "wait until the live content settled" prepares for the embed / SQL /
// value shots, whose NodeViews fetch per-viewer after mount.

// Inline `inline_embed` pill: wait for its resolver fetch to settle (leaves
// the `--loading` class).
export async function waitInlineEmbed(page) {
  await page.locator(".pm-inline-embed").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".pm-inline-embed");
      return !!el && !el.classList.contains("pm-inline-embed--loading");
    },
    { timeout: 10_000 },
  );
}

// Block `block_embed`: wait for the NodeView's per-viewer fetch to replace the
// loading skeleton with real content (asserted via `needle`, a string the
// rendered payload must contain).
export async function waitBlockEmbed(page, needle) {
  await page.locator(".pm-block-embed").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    (text) => {
      const el = document.querySelector(".pm-block-embed");
      if (!el || el.querySelector(".pm-block-embed-skeleton")) return false;
      return (el.innerText || "").includes(text);
    },
    needle,
    { timeout: 10_000 },
  );
}

// SQL query block: wait for the NodeView's auto-run (on mount) to render the
// results table.
export async function waitSqlBlock(page) {
  await page.locator(".pm-sql-block").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator(".pm-sql-block table").waitFor({ state: "visible", timeout: 10_000 });
}

// Inline SQL value chips: wait for the source store to resolve them (leave the
// loading state).
export async function waitInlineValues(page) {
  await page.locator(".pm-value").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const els = document.querySelectorAll(".pm-value");
      return (
        els.length > 0 &&
        [...els].every((e) => !e.classList.contains("pm-value--loading"))
      );
    },
    { timeout: 10_000 },
  );
}

// Open the `/` slash menu in a guaranteed-empty top-level paragraph. The
// slash-menu shots share one seeded doc, and typing "/" persists — so a doc may
// already hold a leftover "/" from an earlier shot. Select-all + Backspace
// clears it (a no-op on an already-empty doc) so the trigger fires cleanly.
export async function openFreshSlashMenu(page) {
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/");
  await page.locator(".pm-slash-menu").waitFor({ state: "visible", timeout: 10_000 });
}

// Move the `/` slash menu's keyboard highlight (ArrowDown) onto the item whose
// label is `label`. The popup rebuilds its DOM on every editor update (cursor
// reporter transactions fire periodically), each time re-scrolling the *active*
// item into view — so directly setting scrollTop is wiped, but the persisted
// active index is not. Highlighting a section's LAST item therefore keeps that
// whole section framed at the bottom of the scrollable popup across re-renders,
// which an element screenshot of `.pm-slash-menu` then captures stably.
// DOM-checked (not a fixed press count) so it survives command-list changes.
export async function highlightSlashItem(page, label) {
  for (let i = 0; i < 50; i++) {
    const active = await page
      .locator(".pm-slash-item--active")
      .textContent()
      .catch(() => null);
    if (active && active.trim() === label) {
      // Let one more render settle the active-item scroll, then it's stable.
      await page.locator(".pm-slash-item--active", { hasText: label }).waitFor({
        state: "visible",
        timeout: 5_000,
      });
      return;
    }
    await page.keyboard.press("ArrowDown");
  }
  throw new Error(`slash menu never highlighted "${label}"`);
}
