/**
 * Shared cell-value rendering for result tables — the `block_embed`
 * table/view render, the `sql_block` results table, and the row card's
 * field values. One choke point so truncation, blob display, and the
 * expand affordance can't drift between the three (the `tableExport.ts`
 * spirit, for display instead of serialization).
 *
 * Collapsed display is one line: everything before the first newline,
 * capped at CELL_DISPLAY_CAP chars, "…"-suffixed when anything was cut.
 * A truncated cell grows a hover-revealed button that expands the full
 * value in place (multi-line, scrollable, capped at CELL_EXPAND_CAP).
 * Blob envelopes render as "<binary — 12.3 KB>" — the base64 payload
 * never enters the DOM.
 *
 * Expansion is per-viewer ephemeral view state (like the SQL block's
 * page number): it does not collaborate, is not persisted, and any
 * re-render (page change, refresh, editability flip) resets it.
 *
 * XSS rule (load-bearing, inherited from blockEmbedView.ts): every cell
 * value goes into the DOM as a TEXT NODE only — never innerHTML. Only
 * the trusted constant icon SVGs use innerHTML.
 */
import { iconMarkup, type CellValue } from "./datasetteEmbed";

/** Max chars of a value entering the collapsed cell DOM. */
export const CELL_DISPLAY_CAP = 200;
/** Max chars of a value entering an expanded cell. */
export const CELL_EXPAND_CAP = 50_000;
/** Full values shorter than this also ride the host's `title` for hover-peek. */
const TITLE_CAP = 1_000;

export type CellDisplay = {
  /** Collapsed display text (first line, capped, "…" when cut). */
  text: string;
  /** True when `text` differs from the full value. */
  truncated: boolean;
  kind: "text" | "binary" | "null";
};

/** "999 B", "12.3 KB", "1.2 MB" — deterministic, one decimal above bytes. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  for (const unit of units) {
    v /= 1024;
    if (v < 1024 || unit === "TB") return `${v.toFixed(1)} ${unit}`;
  }
  return `${n} B`; // unreachable; keeps TS happy
}

/** Decoded byte size of a base64 string (length ÷ 4 × 3, minus padding). */
export function blobSize(encoded: string): number {
  if (!encoded.length) return 0;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, (encoded.length / 4) * 3 - padding);
}

/** Collapsed display info for a cell value. */
export function cellDisplay(value: CellValue): CellDisplay {
  if (value === null) return { text: "", truncated: false, kind: "null" };
  if (typeof value === "object") {
    // The {$base64, encoded} blob envelope — size only, never the payload.
    return {
      text: `<binary — ${formatBytes(blobSize(value.encoded ?? ""))}>`,
      truncated: false,
      kind: "binary",
    };
  }
  const full = String(value);
  const newline = full.search(/[\r\n]/);
  const firstLine = newline < 0 ? full : full.slice(0, newline);
  const cut = firstLine.slice(0, CELL_DISPLAY_CAP);
  const truncated = cut !== full;
  return { text: truncated ? `${cut}…` : full, truncated, kind: "text" };
}

/**
 * Fill `host` (a `<td>` or `<dd>`) with the collapsed rendering: a
 * `.pm-result-cell` span plus — when the display was truncated — the
 * expand/collapse toggle button. The full value lives in this closure,
 * never in a data attribute (no megabyte attrs).
 *
 * The toggle is a `<button>` on purpose: both NodeViews' `stopEvent`
 * already stop buttons, while a plain-`<td>` click falls through to
 * ProseMirror node selection in the block embed.
 */
// @feat result-cells: collapsed one-line cell + expand-in-place toggle
export function renderResultValue(host: HTMLElement, value: CellValue): void {
  const display = cellDisplay(value);
  const span = document.createElement("span");
  span.className = "pm-result-cell";
  span.dataset.kind = display.kind;
  span.textContent = display.text; // text node — data-derived
  host.appendChild(span);
  if (!display.truncated || display.kind !== "text") return;

  const full = String(value);
  if (full.length <= TITLE_CAP) host.title = full;
  host.appendChild(expandToggle(host, span, display, full));
}

/** The expand/collapse button for a JS-truncated cell. */
function expandToggle(
  host: HTMLElement,
  span: HTMLElement,
  display: CellDisplay,
  full: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pm-result-cell-expand";
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = iconMarkup("chevronDown"); // trusted constant SVG
  btn.appendChild(icon);
  const setState = (expanded: boolean): void => {
    btn.title = expanded ? "Collapse" : "Show full value";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-expanded", String(expanded));
  };
  setState(false);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const expanded = host.classList.toggle("is-expanded");
    setState(expanded);
    span.replaceChildren();
    if (!expanded) {
      span.textContent = display.text;
      return;
    }
    span.textContent = full.slice(0, CELL_EXPAND_CAP); // text node
    if (full.length > CELL_EXPAND_CAP) {
      const note = document.createElement("span");
      note.className = "pm-result-cell-note";
      note.textContent = " … value truncated — use export or open in Datasette";
      span.appendChild(note);
    }
  });
  return btn;
}

/**
 * After a table render lands in the document, give cells that ellipsized
 * purely by CSS (short value, wider than the column clamp) the same
 * toggle. Their full text is already in the DOM, so expanding is just
 * the class flip. One rAF pass per render — never per-frame.
 */
// @feat result-cells: CSS-overflow pass — expand toggle for wide-but-short cells
export function markOverflowingCells(root: HTMLElement): void {
  requestAnimationFrame(() => {
    for (const span of root.querySelectorAll<HTMLElement>(".pm-result-cell")) {
      if (span.dataset.kind !== "text") continue;
      const host = span.parentElement;
      if (!host || host.querySelector(".pm-result-cell-expand")) continue;
      if (span.scrollWidth <= span.clientWidth) continue;
      const full = span.textContent ?? "";
      if (full.length <= TITLE_CAP && !host.title) host.title = full;
      host.appendChild(
        expandToggle(host, span, { text: full, truncated: true, kind: "text" }, full),
      );
    }
  });
}

/**
 * Wrap-and-fade furniture for a horizontal result-table scroll box:
 * toggles `has-overflow-left/right` on `wrap` so CSS can paint edge
 * fades that say "more columns this way". Passive listener on the
 * scroll element itself — dies with the DOM, nothing to clean up.
 */
// @feat result-cells: h-scroll edge-fade classes on the result scrollwrap
export function attachScrollFades(wrap: HTMLElement, scroll: HTMLElement): void {
  const sync = (): void => {
    const max = scroll.scrollWidth - scroll.clientWidth;
    wrap.classList.toggle("has-overflow-left", scroll.scrollLeft > 1);
    wrap.classList.toggle("has-overflow-right", scroll.scrollLeft < max - 1);
  };
  scroll.addEventListener("scroll", sync, { passive: true });
  requestAnimationFrame(sync);
}
