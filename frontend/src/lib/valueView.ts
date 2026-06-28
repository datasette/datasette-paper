/**
 * NodeView for `value`: an inline atom that renders a single live SQL value
 * spliced into prose. It holds only a reference — `source` (a `source` node's
 * name) + `column` + an optional `format` — and subscribes to the per-editor
 * SourceStore, which runs the source's query once and hands back the first row.
 *
 * Render states (all text-only — cell values are DB content, never innerHTML):
 *   loading        → "…"            (.pm-value--loading)
 *   ok + column    → formatValue(cell, format) (null/empty → the fallback "—")
 *   ok, no column  → "${{src.?}}"   (.pm-value--error)
 *   missing source → "${{?src}}"    (.pm-value--error)
 *   denied         → "no access"    (.pm-value--denied)
 *   error          → "error"        (.pm-value--error, title = message)
 *
 * Clicking the chip opens a small popover (anchored, outside-click teardown —
 * same open/close pattern as sqlBlockView's export menu) to edit the column +
 * `format`. Edits dispatch a `setNodeMarkup` so they flow through collab.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import { cellFor, type SourceStore, type SourceState } from "./sourceStore";
import { formatValue, type ValueFormat, type ValueFormatKind } from "./formatValue";

export class ValueView implements NodeView {
  dom: HTMLSpanElement;
  private textNode: Text;
  private source: string | null;
  private column: string | null;
  private format: ValueFormat;
  private unsubscribe: (() => void) | null = null;
  private popoverEl: HTMLElement | null = null;

  constructor(
    node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private store: SourceStore,
  ) {
    this.dom = document.createElement("span");
    this.dom.className = "pm-value";
    // Value text lives in a Text node (not dom.textContent) so the popover can
    // be appended as an element child without being wiped on re-render — and so
    // `dom.children` stays empty when closed (the XSS / no-HTML guarantee).
    this.textNode = document.createTextNode("");
    this.dom.appendChild(this.textNode);
    this.source = node.attrs.source ?? null;
    this.column = node.attrs.column ?? null;
    this.format = (node.attrs.format as ValueFormat) ?? null;
    this.dom.addEventListener("mousedown", this.onChipMouseDown);
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
    this.textNode.nodeValue = text;
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
        this.set("pm-value", formatValue(cell, this.format));
        return;
      }
    }
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "value") return false;
    const nextSource = node.attrs.source ?? null;
    const nextColumn = node.attrs.column ?? null;
    const nextFormat = (node.attrs.format as ValueFormat) ?? null;
    this.format = nextFormat;
    if (nextSource !== this.source) {
      this.source = nextSource;
      this.column = nextColumn;
      this.subscribe();
    } else {
      this.column = nextColumn;
      this.render(this.store.getState(this.source ?? ""));
    }
    return true;
  }

  // ── Popover (click-to-edit column + format) ────────────────────────────────

  private onChipMouseDown = (e: MouseEvent): void => {
    // A click on the popover itself must not toggle it shut.
    if (this.popoverEl && this.popoverEl.contains(e.target as Node)) return;
    e.preventDefault();
    if (this.popoverEl) this.closePopover();
    else this.openPopover();
  };

  private openPopover(): void {
    const pop = document.createElement("div");
    pop.className = "pm-value-popover";

    const state = this.source ? this.store.getState(this.source) : { status: "missing" as const };
    const columns = state.status === "ok" ? state.columns : [];

    // Column <select> — the source's columns, plus the current one if absent.
    const colRow = this.field("Column");
    const colSel = document.createElement("select");
    colSel.className = "pm-value-popover-select";
    const colNames = [...columns];
    if (this.column && !colNames.includes(this.column)) colNames.unshift(this.column);
    if (colNames.length === 0 && this.column == null) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(no columns)";
      colSel.appendChild(opt);
    }
    for (const name of colNames) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name; // DB-derived → text only
      if (name === this.column) opt.selected = true;
      colSel.appendChild(opt);
    }
    colRow.appendChild(colSel);
    pop.appendChild(colRow);

    // Format kind <select>.
    const kindRow = this.field("Format");
    const kindSel = document.createElement("select");
    kindSel.className = "pm-value-popover-select";
    const kinds: { value: string; label: string }[] = [
      { value: "", label: "Raw" },
      { value: "number", label: "Number" },
      { value: "currency", label: "Currency" },
      { value: "percent", label: "Percent" },
      { value: "date", label: "Date" },
      { value: "text", label: "Text" },
    ];
    const currentKind = this.format?.kind ?? "";
    for (const k of kinds) {
      const opt = document.createElement("option");
      opt.value = k.value;
      opt.textContent = k.label;
      if (k.value === currentKind) opt.selected = true;
      kindSel.appendChild(opt);
    }
    kindRow.appendChild(kindSel);
    pop.appendChild(kindRow);

    // Kind-specific options (rebuilt when the kind changes).
    const optsRow = document.createElement("div");
    optsRow.className = "pm-value-popover-opts";
    pop.appendChild(optsRow);

    // Fallback input (shared across kinds).
    const fbRow = this.field("Fallback");
    const fbInput = document.createElement("input");
    fbInput.type = "text";
    fbInput.className = "pm-value-popover-input";
    fbInput.placeholder = "—";
    fbInput.value = this.format?.fallback ?? "";
    fbRow.appendChild(fbInput);
    pop.appendChild(fbRow);

    // Reads the current UI into a ValueFormat + dispatches setNodeMarkup.
    const apply = (): void => {
      const kind = kindSel.value as ValueFormatKind | "";
      let format: ValueFormat = null;
      if (kind !== "") {
        const f: Record<string, unknown> = { kind };
        const dec = optsRow.querySelector<HTMLInputElement>("[data-opt=decimals]");
        const cur = optsRow.querySelector<HTMLInputElement>("[data-opt=currency]");
        const sty = optsRow.querySelector<HTMLSelectElement>("[data-opt=style]");
        if (dec && dec.value !== "") f.decimals = Number(dec.value);
        if (cur && cur.value.trim() !== "") f.currency = cur.value.trim();
        if (sty) f.style = sty.value;
        const fb = fbInput.value;
        if (fb !== "") f.fallback = fb;
        format = f as ValueFormat;
      } else if (fbInput.value !== "") {
        // Raw kind but a custom fallback → keep it on a text format.
        format = { kind: "text", fallback: fbInput.value };
      }
      const column = colSel.value || null;
      this.commit(column, format);
    };

    const renderOpts = (): void => {
      optsRow.replaceChildren();
      const kind = kindSel.value;
      if (kind === "number" || kind === "percent") {
        const wrap = this.field("Decimals");
        const inp = document.createElement("input");
        inp.type = "number";
        inp.min = "0";
        inp.className = "pm-value-popover-input";
        inp.dataset.opt = "decimals";
        inp.value = this.format?.kind === kind && this.format.decimals != null
          ? String(this.format.decimals)
          : "";
        inp.addEventListener("input", apply);
        wrap.appendChild(inp);
        optsRow.appendChild(wrap);
      } else if (kind === "currency") {
        const wrap = this.field("Currency");
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "pm-value-popover-input";
        inp.dataset.opt = "currency";
        inp.placeholder = "USD";
        inp.value = this.format?.kind === "currency" ? (this.format.currency ?? "") : "";
        inp.addEventListener("input", apply);
        wrap.appendChild(inp);
        optsRow.appendChild(wrap);
      } else if (kind === "date") {
        const wrap = this.field("Style");
        const sel = document.createElement("select");
        sel.className = "pm-value-popover-select";
        sel.dataset.opt = "style";
        for (const s of ["medium", "long", "iso"]) {
          const opt = document.createElement("option");
          opt.value = s;
          opt.textContent = s;
          if (this.format?.kind === "date" && (this.format.style ?? "medium") === s) {
            opt.selected = true;
          }
          sel.appendChild(opt);
        }
        sel.addEventListener("change", apply);
        wrap.appendChild(sel);
        optsRow.appendChild(wrap);
      }
    };

    colSel.addEventListener("change", apply);
    kindSel.addEventListener("change", () => {
      renderOpts();
      apply();
    });
    fbInput.addEventListener("input", apply);
    renderOpts();

    this.dom.appendChild(pop);
    this.popoverEl = pop;
    document.addEventListener("mousedown", this.onOutsideClick, true);
    document.addEventListener("keydown", this.onPopoverKeydown, true);
  }

  /** A labelled row inside the popover. */
  private field(label: string): HTMLElement {
    const row = document.createElement("label");
    row.className = "pm-value-popover-row";
    const span = document.createElement("span");
    span.className = "pm-value-popover-label";
    span.textContent = label;
    row.appendChild(span);
    return row;
  }

  private closePopover(): void {
    if (!this.popoverEl) return;
    this.popoverEl.remove();
    this.popoverEl = null;
    document.removeEventListener("mousedown", this.onOutsideClick, true);
    document.removeEventListener("keydown", this.onPopoverKeydown, true);
  }

  private onOutsideClick = (e: MouseEvent): void => {
    if (!this.dom.contains(e.target as Node)) this.closePopover();
  };

  private onPopoverKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.closePopover();
  };

  private commit(column: string | null, format: ValueFormat): void {
    const pos = this.getPos();
    if (pos == null) return;
    const attrs = { source: this.source, column, format };
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, attrs));
  }

  // Leaf atom we fully own.
  ignoreMutation(): boolean {
    return true;
  }

  /** Swallow events inside the popover so PM doesn't treat them as editor
   *  input; let everything else through. */
  stopEvent(event?: Event): boolean {
    if (!event) return false;
    return !!this.popoverEl && this.popoverEl.contains(event.target as Node);
  }

  destroy(): void {
    this.closePopover();
    this.dom.removeEventListener("mousedown", this.onChipMouseDown);
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
