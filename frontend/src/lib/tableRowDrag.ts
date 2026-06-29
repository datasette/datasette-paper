/**
 * Hover-and-drag row reordering for tables.
 *
 * Mousemove on the editor parks a floating grip button at the left edge
 * of the hovered `<tr>`. The drag itself runs on Pointer Events with
 * `setPointerCapture`: pointermove/pointerup are routed straight to the
 * handle regardless of where the pointer is, which sidesteps the
 * document-level mouse listeners prosemirror-tables installs for
 * cell-selection drag (they call stopPropagation in bubble phase and
 * otherwise eat our move/up events).
 *
 * On drop we dispatch a single `replaceWith` transaction that rebuilds
 * the table with rows reordered. The resulting ReplaceStep rides
 * through collab like any other content edit (mirrors `setTableName`).
 *
 * Header rows are pinned at the top:
 *   - A row whose every cell is a `table_header` is "header"; the grip
 *     does not appear over it.
 *   - The drop boundary is clamped so a body row cannot land above the
 *     last leading header row.
 *
 * Drag state is keyed by table pos + row index, NOT the live `<tr>` DOM
 * element — PM may re-render the table mid-drag (e.g. when the
 * pointerdown's focus change triggers a selection-cleared transaction)
 * and detach the original TR. The position+index pair stays valid as
 * long as no intervening edit restructures the table, which suffices
 * for the single-user case; collab edits could shift indices, in which
 * case the drop applies to whichever row is at that index now (or
 * silently no-ops if the index is no longer valid).
 */

import { Plugin } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "./schema";
import { iconMarkup } from "./datasetteEmbed";

interface RowResolved {
  tableNode: PMNode;
  tablePos: number;
  rowIndex: number;
  rowNode: PMNode;
}

/** True iff every cell in `row` is a `table_header` node. */
export function isHeaderRow(row: PMNode): boolean {
  if (row.childCount === 0) return false;
  for (let i = 0; i < row.childCount; i++) {
    if (row.child(i).type !== schema.nodes.table_header) return false;
  }
  return true;
}

/** Number of leading header rows in the table (the "pinned" prefix). */
export function leadingHeaderCount(table: PMNode): number {
  let n = 0;
  for (let i = 0; i < table.childCount; i++) {
    if (isHeaderRow(table.child(i))) n++;
    else break;
  }
  return n;
}

/**
 * Resolve the table_row enclosing the DOM `tr` element to PM coords.
 * Returns null if the element is no longer mapped (e.g. remote edit
 * removed it, or the cursor is outside the editor entirely).
 */
function resolveRow(view: EditorView, tr: HTMLElement): RowResolved | null {
  const pos = view.posAtDOM(tr, 0);
  if (pos < 0) return null;
  const $pos = view.state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type === schema.nodes.table_row) {
      const tableDepth = d - 1;
      const tableNode = $pos.node(tableDepth);
      if (tableNode.type !== schema.nodes.table) return null;
      return {
        tableNode,
        tablePos: $pos.before(tableDepth),
        rowIndex: $pos.index(tableDepth),
        rowNode: $pos.node(d),
      };
    }
  }
  return null;
}

/**
 * Build a transaction that moves the row at `fromIdx` to insertion
 * boundary `toIdx` (range 0..childCount). Returns null if it would be a
 * no-op or if the move is blocked by leading header rows.
 */
export function buildReorderTr(
  state: EditorState,
  tablePos: number,
  fromIdx: number,
  toIdx: number,
): ReturnType<EditorState["tr"]["replaceWith"]> | null {
  const table = state.doc.nodeAt(tablePos);
  if (!table || table.type !== schema.nodes.table) return null;
  if (fromIdx < 0 || fromIdx >= table.childCount) return null;
  const headerCount = leadingHeaderCount(table);
  // Header rows can't move; body rows can't cross the header boundary.
  if (fromIdx < headerCount) return null;
  const clampedTo = Math.max(headerCount, Math.min(table.childCount, toIdx));
  const insertAt = clampedTo > fromIdx ? clampedTo - 1 : clampedTo;
  if (insertAt === fromIdx) return null;
  const rows: PMNode[] = [];
  for (let i = 0; i < table.childCount; i++) rows.push(table.child(i));
  const [moved] = rows.splice(fromIdx, 1);
  rows.splice(insertAt, 0, moved);
  const newTable = schema.nodes.table.create(table.attrs, rows);
  return state.tr.replaceWith(tablePos, tablePos + table.nodeSize, newTable);
}

class TableRowDragView {
  private view: EditorView;
  private host: HTMLElement | null;
  private handle: HTMLButtonElement;
  private indicator: HTMLDivElement;

  // The row the handle is currently anchored to. Persists across
  // mouseleave events (e.g. when the cursor crosses from the row into
  // the handle itself, which lives outside view.dom) so mousedown on
  // the handle can still resolve a source row.
  private hoverTr: HTMLTableRowElement | null = null;

  // Active drag state (null when not dragging).
  //
  // We store the *initial* table pos + row index rather than tracking the
  // source TR DOM element, because PM may re-render the table mid-drag
  // (e.g. on focus change → selection-cleared transaction → DOM redraw),
  // detaching the original TR. The table-pos + index pair is stable as
  // long as no intervening edits restructure the table.
  private drag: {
    sourceTablePos: number;
    sourceRowIndex: number;
    sourceTrAtStart: HTMLTableRowElement; // for the .pm-row-dragging visual
    targetIdx: number;
  } | null = null;

  // Bound handlers we need to detach on destroy.
  private viewMouseMove = (e: MouseEvent) => this.onViewMouseMove(e);
  private hostMouseMove = (e: MouseEvent) => this.onHostMouseMove(e);
  private hostMouseLeave = (e: MouseEvent) => this.onHostMouseLeave(e);
  private handlePointerMove = (e: PointerEvent) => this.onHandlePointerMove(e);
  private handlePointerUp = (e: PointerEvent) => this.onHandlePointerUp(e);
  private handlePointerCancel = (_e: PointerEvent) => this.cleanupDrag();
  private docKeyDown = (e: KeyboardEvent) => this.onDocKeyDown(e);

  constructor(view: EditorView) {
    this.view = view;
    this.host = (view.dom.parentNode as HTMLElement | null) ?? null;

    this.handle = document.createElement("button");
    this.handle.type = "button";
    this.handle.className = "pm-row-drag-handle";
    this.handle.title = "Drag to reorder row";
    this.handle.setAttribute("aria-label", "Drag to reorder row");
    this.handle.style.display = "none";
    this.handle.innerHTML = iconMarkup("gripVertical");
    // Pointer events with setPointerCapture: subsequent move/up events
    // are routed straight to the handle regardless of pointer position
    // and capture-phase routing, so prosemirror-tables' own document
    // listeners can't swallow them.
    this.handle.addEventListener("pointerdown", (e) => this.onHandlePointerDown(e));
    this.handle.addEventListener("pointermove", this.handlePointerMove);
    this.handle.addEventListener("pointerup", this.handlePointerUp);
    // pointercancel = system-cancelled gesture (touch preempt, page hidden,
    // etc.). Don't apply the drop in that case — just clean up.
    this.handle.addEventListener("pointercancel", this.handlePointerCancel);

    this.indicator = document.createElement("div");
    this.indicator.className = "pm-row-drop-indicator";
    this.indicator.style.display = "none";

    if (this.host) {
      this.host.appendChild(this.handle);
      this.host.appendChild(this.indicator);
    }

    view.dom.addEventListener("mousemove", this.viewMouseMove);
    if (this.host) {
      // Host-level listeners catch the area immediately left of the
      // table where the handle sits — without these, moving the cursor
      // out of view.dom toward the handle triggers no mousemove and the
      // last-shown handle disappears as soon as `viewMouseMove` stops
      // firing. We deliberately listen on the host (not the document)
      // so leaving the editor area entirely still hides the handle.
      this.host.addEventListener("mousemove", this.hostMouseMove);
      this.host.addEventListener("mouseleave", this.hostMouseLeave);
    }
  }

  // ── Hover handle ──────────────────────────────────────────────────────────

  private onViewMouseMove(event: MouseEvent) {
    if (this.drag) return; // drag owns the handle while active
    const tr = (event.target as HTMLElement | null)?.closest?.("tr") as
      | HTMLTableRowElement
      | null;
    if (!tr || !this.view.dom.contains(tr)) {
      this.hideHandle();
      return;
    }
    if (tr === this.hoverTr) {
      // Same row — handle is already positioned.
      return;
    }
    const resolved = resolveRow(this.view, tr);
    if (!resolved) {
      this.hideHandle();
      return;
    }
    if (isHeaderRow(resolved.rowNode)) {
      // Header rows are pinned; no grip.
      this.hideHandle();
      return;
    }
    this.hoverTr = tr;
    this.positionHandle(tr);
  }

  /**
   * Host-level mousemove. Catches the buffer zone left of the table
   * (where the handle floats) plus anywhere else inside the host. If
   * the cursor is in a row's vertical range and within ~32px to the
   * left of the row's left edge, show the handle for that row.
   *
   * When cursor is over view.dom, `viewMouseMove` already does the
   * work — this handler only fires for areas outside view.dom but
   * inside the host (handle area, gutter, host padding).
   */
  private onHostMouseMove(event: MouseEvent) {
    if (this.drag) return;
    // If the event is coming from inside view.dom, viewMouseMove has it.
    if (this.view.dom.contains(event.target as Node | null)) return;
    // If cursor is over the handle itself (or its descendants), the
    // handle is already visible — leave it alone.
    if (this.handle.contains(event.target as Node | null)) return;

    const HOT = 32;
    const tables = this.view.dom.querySelectorAll("table");
    for (const table of Array.from(tables)) {
      const tableRect = table.getBoundingClientRect();
      // Quick reject: only consider tables whose left-buffer the cursor
      // is currently in (and within the table's vertical extent).
      if (event.clientX < tableRect.left - HOT) continue;
      if (event.clientX > tableRect.left) continue;
      if (event.clientY < tableRect.top || event.clientY > tableRect.bottom) continue;
      const rows = table.querySelectorAll("tr");
      for (const trEl of Array.from(rows) as HTMLTableRowElement[]) {
        const rect = trEl.getBoundingClientRect();
        if (event.clientY < rect.top || event.clientY >= rect.bottom) continue;
        if (trEl === this.hoverTr) return; // already correct
        const resolved = resolveRow(this.view, trEl);
        if (!resolved) return;
        if (isHeaderRow(resolved.rowNode)) {
          this.hideHandle();
          return;
        }
        this.hoverTr = trEl;
        this.positionHandle(trEl);
        return;
      }
    }
    // Not in any row's hot zone — hide.
    this.hideHandle();
  }

  private onHostMouseLeave(_event: MouseEvent) {
    if (this.drag) return;
    this.hideHandle();
  }

  private positionHandle(tr: HTMLTableRowElement) {
    if (!this.host) return;
    const trRect = tr.getBoundingClientRect();
    const hostRect = this.host.getBoundingClientRect();
    this.handle.style.display = "";
    this.handle.style.top = `${trRect.top - hostRect.top + trRect.height / 2}px`;
    this.handle.style.left = `${trRect.left - hostRect.left}px`;
  }

  private hideHandle() {
    this.handle.style.display = "none";
    // Deliberately do NOT clear hoverTr — see field comment.
  }

  // ── Drag ──────────────────────────────────────────────────────────────────

  private onHandlePointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    if (!this.hoverTr) return;
    if (!this.view.editable) return;
    event.preventDefault();
    event.stopPropagation();

    const sourceTr = this.hoverTr;
    const resolved = resolveRow(this.view, sourceTr);
    if (!resolved) return;
    if (isHeaderRow(resolved.rowNode)) return;

    this.drag = {
      sourceTablePos: resolved.tablePos,
      sourceRowIndex: resolved.rowIndex,
      sourceTrAtStart: sourceTr,
      targetIdx: resolved.rowIndex,
    };
    this.handle.classList.add("pm-row-drag-handle-grabbing");
    sourceTr.classList.add("pm-row-dragging");
    document.body.style.cursor = "grabbing";

    // setPointerCapture routes ALL further pointer events for this
    // pointerId straight to the handle — bypasses prosemirror-tables'
    // document-level mouse listeners (which call stopPropagation
    // during cell-selection drag and otherwise eat our move/up).
    this.handle.setPointerCapture(event.pointerId);
    document.addEventListener("keydown", this.docKeyDown, true);

    this.updateIndicatorAt(sourceTr, "above");
  }

  private onHandlePointerMove(event: PointerEvent) {
    if (!this.drag || !this.host) return;
    const drag = this.drag;
    // The handle has the pointer capture, so elementFromPoint is the
    // only way to learn what's actually under the cursor.
    const el = document.elementFromPoint(event.clientX, event.clientY);
    const tr = (el as HTMLElement | null)?.closest?.("tr") as
      | HTMLTableRowElement
      | null;
    if (!tr || !this.view.dom.contains(tr)) return;
    const resolved = resolveRow(this.view, tr);
    if (!resolved) return;
    if (resolved.tablePos !== drag.sourceTablePos) {
      // Different table — refuse, hide indicator.
      this.indicator.style.display = "none";
      drag.targetIdx = -1;
      return;
    }
    const headerCount = leadingHeaderCount(resolved.tableNode);
    const trRect = tr.getBoundingClientRect();
    const above = event.clientY < trRect.top + trRect.height / 2;
    let boundary = above ? resolved.rowIndex : resolved.rowIndex + 1;
    // Body rows can't land above the leading header block.
    boundary = Math.max(headerCount, Math.min(resolved.tableNode.childCount, boundary));
    drag.targetIdx = boundary;
    this.updateIndicatorAt(tr, above ? "above" : "below");
  }

  private updateIndicatorAt(tr: HTMLTableRowElement, side: "above" | "below") {
    if (!this.host) return;
    const hostRect = this.host.getBoundingClientRect();
    const trRect = tr.getBoundingClientRect();
    const top = (side === "above" ? trRect.top : trRect.bottom) - hostRect.top;
    this.indicator.style.display = "";
    this.indicator.style.top = `${top}px`;
    this.indicator.style.left = `${trRect.left - hostRect.left}px`;
    this.indicator.style.width = `${trRect.width}px`;
  }

  private onHandlePointerUp(_event: PointerEvent) {
    if (!this.drag) return;
    const drag = this.drag;
    this.cleanupDrag();

    if (drag.targetIdx < 0) return;

    // Use the stored table-pos + row-index. The TR DOM may have been
    // detached by an intervening render, but as long as the table's
    // structure hasn't shifted, the index points at the same row.
    const tr = buildReorderTr(
      this.view.state,
      drag.sourceTablePos,
      drag.sourceRowIndex,
      drag.targetIdx,
    );
    if (!tr) return;
    this.view.dispatch(tr);
    this.view.focus();
  }

  private onDocKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && this.drag) {
      event.preventDefault();
      this.cleanupDrag();
    }
  }

  private cleanupDrag() {
    if (this.drag) {
      // Remove the visual dragging class. The TR may have been detached
      // already; classList on a detached node is harmless.
      this.drag.sourceTrAtStart.classList.remove("pm-row-dragging");
    }
    this.drag = null;
    this.handle.classList.remove("pm-row-drag-handle-grabbing");
    document.body.style.cursor = "";
    this.indicator.style.display = "none";
    this.hideHandle();
    document.removeEventListener("keydown", this.docKeyDown, true);
  }

  // ── PM plugin lifecycle ──────────────────────────────────────────────────

  update(view: EditorView, _prev: EditorState) {
    // If the doc changed and the hovered row's DOM is gone, hide the
    // handle so it doesn't point at thin air.
    if (this.hoverTr && !view.dom.contains(this.hoverTr)) {
      this.hideHandle();
    }
    // Deliberately do NOT cancel drag here based on DOM containment —
    // PM regularly re-renders the table TR (e.g. focus-change selection
    // updates), detaching `sourceTrAtStart` mid-drag. drag state is
    // referenced by table-pos + row-index, not the live DOM, so this
    // is fine. Drag is canceled on Escape, pointercancel, or destroy().
  }

  destroy() {
    this.cleanupDrag();
    this.view.dom.removeEventListener("mousemove", this.viewMouseMove);
    if (this.host) {
      this.host.removeEventListener("mousemove", this.hostMouseMove);
      this.host.removeEventListener("mouseleave", this.hostMouseLeave);
    }
    this.handle.remove();
    this.indicator.remove();
  }
}

export function tableRowDragPlugin(): Plugin {
  return new Plugin({
    view(editorView) {
      return new TableRowDragView(editorView);
    },
  });
}
