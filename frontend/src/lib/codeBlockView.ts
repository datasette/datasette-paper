/**
 * NodeView for `code_block`: the same `<pre><code>` rendering the stock
 * `toDOM` produced, plus edit-mode-only corner chrome showing the resolved
 * language ("python ▾" / "plain text ▾") that opens a type-to-filter popup
 * over the language registry (languages.ts).
 *
 * Unlike `sql_block`/`source`, `code_block` carries exactly one attr
 * (`language`, T01) and has no db/hidden chrome to keep in sync — the whole
 * NodeView exists to host this one picker. `dom` = a `.pm-code-block`
 * wrapper (position: relative, anchors the corner chrome); `contentDOM` =
 * the `<code>` inside a plain `<pre>`, so the existing plain-code-block CSS
 * (editor.css `.editor-host .ProseMirror pre`) keeps applying unchanged.
 * `ignoreMutation`/`stopEvent` keep ProseMirror out of the chrome — the
 * contentDOM-NodeView pattern from sqlBlockView.ts/taskItemView.ts.
 *
 * Chrome is edit-mode only: `view.editable` flips live via `setEditable`
 * (collab.ts) through `setProps`, which does not dispatch a transaction, so
 * `update()` alone never sees the flip. Watch the editor root's
 * `contenteditable` attribute instead (the blockEmbedView.ts T02 precedent)
 * and re-gate on that, in addition to `update()`'s own check.
 *
 * T05 rebuilds this NodeView's text surface into a live CodeMirror mount;
 * the chrome (button + popup + attr writes) is kept independent of the text
 * surface so it keeps working unchanged once that lands.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";
import { iconMarkup } from "./datasetteEmbed";
import { allLanguages, resolveLanguage } from "./languages";

/** The button label for a stored `language` attr. Unknown-but-set tokens
 * display their raw value (rather than hiding it) so nothing looks silently
 * broken; `null` is "plain text". Exported for tests. */
export function languageLabel(language: string | null): string {
  if (!language) return "plain text";
  return resolveLanguage(language)?.label ?? language;
}

/** One row of the picker list — `language: null` is the synthetic "Plain
 * text" row that clears the attr. */
export interface PickerRow {
  language: string | null;
  label: string;
}

const PLAIN_TEXT_ROW: PickerRow = { language: null, label: "Plain text" };

/**
 * Filter the language registry (+ the "Plain text" row) by substring match
 * against label/id/alias, case-insensitively. Factored out from the NodeView
 * so it's unit-testable without a DOM. An empty query returns every row,
 * "Plain text" first.
 */
export function filterLanguages(query: string): PickerRow[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [PLAIN_TEXT_ROW, ...allLanguages().map((l) => ({ language: l.id, label: l.label }))];
  }
  const rows: PickerRow[] = [];
  if ("plain text".includes(q)) rows.push(PLAIN_TEXT_ROW);
  for (const entry of allLanguages()) {
    const hit =
      entry.label.toLowerCase().includes(q) ||
      entry.id.toLowerCase().includes(q) ||
      entry.aliases.some((a) => a.toLowerCase().includes(q));
    if (hit) rows.push({ language: entry.id, label: entry.label });
  }
  return rows;
}

// @feat code-lang-picker: NodeView — corner button + type-to-filter popup writes code_block.language via setNodeMarkup
export class CodeBlockView implements NodeView {
  dom: HTMLDivElement;
  contentDOM: HTMLElement;
  private view: EditorView;
  private getPos: () => number | undefined;
  private node: PMNode;
  private langBtn: HTMLButtonElement;
  private langBtnLabel: HTMLSpanElement;
  private popupEl: HTMLDivElement;
  private inputEl: HTMLInputElement;
  private listEl: HTMLDivElement;
  private rows: PickerRow[] = [];
  private activeIndex = 0;
  private popupOpen = false;
  // The view/edit toggle flips PM's `editable` prop via setProps without
  // dispatching a transaction, so update() below never runs for it (PM only
  // re-runs a NodeView when its node or decorations change — the
  // blockEmbedView.ts T02 precedent). The flip DOES rewrite the editor
  // root's `contenteditable` attribute, so watch that instead of relying on
  // update() alone to catch a live editable flip.
  private editableObserver: MutationObserver;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.view = view;
    this.getPos = getPos;
    this.node = node;

    this.editableObserver = new MutationObserver(() => this.refreshEditable());
    this.editableObserver.observe(view.dom, {
      attributes: true,
      attributeFilter: ["contenteditable"],
    });

    this.dom = document.createElement("div");
    this.dom.className = "pm-code-block";

    const pre = document.createElement("pre");
    this.contentDOM = document.createElement("code");
    pre.appendChild(this.contentDOM);
    this.dom.appendChild(pre);

    this.langBtn = document.createElement("button");
    this.langBtn.type = "button";
    this.langBtn.className = "pm-code-block-lang-btn";
    this.langBtnLabel = document.createElement("span");
    this.langBtn.appendChild(this.langBtnLabel);
    const chevron = document.createElement("span");
    chevron.className = "pm-code-block-lang-icon";
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = iconMarkup("chevronDown"); // trusted constant SVG
    this.langBtn.appendChild(chevron);
    this.langBtn.addEventListener("mousedown", (e) => {
      // Prevent the click from moving the PM selection into the button.
      e.preventDefault();
    });
    this.langBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.togglePicker();
    });
    this.dom.appendChild(this.langBtn);

    this.popupEl = document.createElement("div");
    this.popupEl.className = "pm-code-block-lang-popup";

    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.className = "pm-code-block-lang-input";
    this.inputEl.placeholder = "Filter languages…";
    this.inputEl.addEventListener("input", () => this.renderRows(this.inputEl.value));
    this.inputEl.addEventListener("keydown", (e) => this.onInputKeydown(e));
    this.popupEl.appendChild(this.inputEl);

    this.listEl = document.createElement("div");
    this.listEl.className = "pm-code-block-lang-list";
    this.popupEl.appendChild(this.listEl);

    this.dom.appendChild(this.popupEl);

    this.refreshLangBtn();
    this.refreshEditable();
  }

  // ── Chrome label ────────────────────────────────────────────────────────

  private refreshLangBtn(): void {
    const label = languageLabel((this.node.attrs.language as string | null) ?? null);
    this.langBtnLabel.textContent = label;
    this.langBtn.setAttribute("aria-label", `Language: ${label}`);
  }

  private refreshEditable(): void {
    const editable = this.view.editable;
    this.dom.classList.toggle("pm-code-block--editable", editable);
    if (!editable) this.closePicker(false);
  }

  // ── Picker popup ────────────────────────────────────────────────────────

  private togglePicker(): void {
    if (this.popupOpen) this.closePicker(false);
    else this.openPicker();
  }

  private openPicker(): void {
    if (this.popupOpen) return;
    this.popupOpen = true;
    this.dom.classList.add("pm-code-block--picker-open");
    this.popupEl.classList.add("pm-code-block-lang-popup--open");
    this.inputEl.value = "";
    this.renderRows("");
    document.addEventListener("mousedown", this.onOutsideClick, true);
    document.addEventListener("keydown", this.onDocKeydown, true);
    this.inputEl.focus();
  }

  private closePicker(refocus: boolean): void {
    if (!this.popupOpen) return;
    this.popupOpen = false;
    this.dom.classList.remove("pm-code-block--picker-open");
    this.popupEl.classList.remove("pm-code-block-lang-popup--open");
    document.removeEventListener("mousedown", this.onOutsideClick, true);
    document.removeEventListener("keydown", this.onDocKeydown, true);
    if (refocus) this.view.focus();
  }

  private onOutsideClick = (e: MouseEvent): void => {
    if (!this.dom.contains(e.target as Node)) this.closePicker(false);
  };

  private onDocKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.closePicker(true);
  };

  private onInputKeydown(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.moveActive(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = this.rows[this.activeIndex];
      if (row) this.selectRow(row);
    }
  }

  private moveActive(delta: number): void {
    if (!this.rows.length) return;
    this.activeIndex = (this.activeIndex + delta + this.rows.length) % this.rows.length;
    this.highlightActive();
  }

  private renderRows(query: string): void {
    this.rows = filterLanguages(query);
    this.activeIndex = 0;
    this.listEl.replaceChildren();
    if (!this.rows.length) {
      const empty = document.createElement("div");
      empty.className = "pm-code-block-lang-empty";
      empty.textContent = "No matching languages";
      this.listEl.appendChild(empty);
      return;
    }
    for (const row of this.rows) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "pm-code-block-lang-item";
      item.textContent = row.label; // text node
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", (e) => {
        e.preventDefault();
        this.selectRow(row);
      });
      this.listEl.appendChild(item);
    }
    this.highlightActive();
  }

  private highlightActive(): void {
    const items = this.listEl.querySelectorAll(".pm-code-block-lang-item");
    items.forEach((el, i) => {
      el.classList.toggle("pm-code-block-lang-item--active", i === this.activeIndex);
    });
  }

  private selectRow(row: PickerRow): void {
    this.setAttr("language", row.language);
    this.closePicker(true);
  }

  // ── Attr mutation (collaborates via the step log) ──────────────────────

  private setAttr(key: "language", value: string | null): void {
    const pos = this.getPos();
    if (pos == null) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, [key]: value }),
    );
  }

  // ── NodeView lifecycle ──────────────────────────────────────────────────

  update(node: PMNode): boolean {
    if (node.type.name !== "code_block") return false;
    const languageChanged = node.attrs.language !== this.node.attrs.language;
    this.node = node;
    if (languageChanged) {
      this.refreshLangBtn();
      if (this.popupOpen) this.renderRows(this.inputEl.value);
    }
    this.refreshEditable();
    return true;
  }

  destroy(): void {
    this.editableObserver.disconnect();
    this.closePicker(false);
  }

  // Let PM manage the code text (contentDOM); everything else is ours.
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target as Node);
  }

  stopEvent(event: Event): boolean {
    return !this.contentDOM.contains(event.target as Node | null);
  }
}
