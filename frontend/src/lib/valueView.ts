/**
 * NodeView for `value`: an inline atom that renders a single live SQL value
 * spliced into prose. It holds only a reference — `source` (a `source` node's
 * name) + `column` + an optional `format` — and subscribes to the per-editor
 * SourceStore, which runs the source's query once and hands back the first row.
 *
 * Render states (all text-only — cell values are DB content, never innerHTML):
 *   loading        → "…"            (.pm-value--loading)
 *   ok + column    → the cell value (null/empty → the fallback "—")
 *   ok, no column  → "${{src.?}}"   (.pm-value--error)
 *   missing source → "${{?src}}"    (.pm-value--error)
 *   denied         → "no access"    (.pm-value--denied)
 *   error          → "error"        (.pm-value--error, title = message)
 *
 * Formatting (the `format` attr) is applied in a later ticket; for now the raw
 * cell is stringified.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import { cellFor, type SourceStore, type SourceState } from "./sourceStore";
import type { CellValue } from "./datasetteEmbed";

const FALLBACK = "—";

function stringifyCell(cell: CellValue): string {
  if (cell === null || cell === "") return FALLBACK;
  if (typeof cell === "object") return "[binary]";
  return String(cell);
}

export class ValueView implements NodeView {
  dom: HTMLSpanElement;
  private source: string | null;
  private column: string | null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    node: PMNode,
    _view: EditorView,
    _getPos: () => number | undefined,
    private store: SourceStore,
  ) {
    this.dom = document.createElement("span");
    this.dom.className = "pm-value";
    this.source = node.attrs.source ?? null;
    this.column = node.attrs.column ?? null;
    this.subscribe();
  }

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.source == null) {
      this.render({ status: "missing" });
      return;
    }
    this.dom.setAttribute("data-source", this.source);
    this.dom.setAttribute("data-column", this.column ?? "");
    this.unsubscribe = this.store.subscribe(this.source, (s) => this.render(s));
  }

  private set(cls: string, text: string, title?: string): void {
    this.dom.className = cls;
    this.dom.textContent = text;
    if (title) this.dom.title = title;
    else this.dom.removeAttribute("title");
  }

  private render(state: SourceState): void {
    const src = this.source ?? "?";
    const col = this.column ?? "?";
    switch (state.status) {
      case "loading":
        this.set("pm-value pm-value--loading", "…");
        return;
      case "missing":
        this.set("pm-value pm-value--error", `\${{?${src}}}`, `Unknown source "${src}"`);
        return;
      case "denied":
        this.set("pm-value pm-value--denied", "no access", "You can't run this query");
        return;
      case "error":
        this.set("pm-value pm-value--error", "error", state.error);
        return;
      case "ok": {
        if (this.column == null) {
          this.set("pm-value pm-value--error", `\${{${src}.?}}`, "No column selected");
          return;
        }
        const cell = cellFor(state, this.column);
        if (cell === undefined) {
          this.set(
            "pm-value pm-value--error",
            `\${{${src}.${col}}}`,
            `Source "${src}" has no column "${col}"`,
          );
          return;
        }
        this.set("pm-value", stringifyCell(cell));
        return;
      }
    }
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "value") return false;
    const nextSource = node.attrs.source ?? null;
    const nextColumn = node.attrs.column ?? null;
    if (nextSource !== this.source) {
      this.source = nextSource;
      this.column = nextColumn;
      this.subscribe();
    } else if (nextColumn !== this.column) {
      this.column = nextColumn;
      this.render(this.store.getState(this.source ?? ""));
    }
    return true;
  }

  // Leaf atom we fully own.
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
