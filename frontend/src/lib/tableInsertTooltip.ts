/**
 * Floating table-controls tooltip — appears when the cursor is inside
 * a `table` node, anchored centered above the table. Hosts row/col +
 * delete buttons and the Name input (with live duplicate warning).
 *
 * The plugin follows the prosemirror-website tooltip pattern (Plugin.view
 * returns `{update, destroy}`). The tooltip DOM lives on
 * `view.dom.parentNode` so it can be absolutely positioned without
 * affecting doc layout — `.editor-host` is `position: relative`.
 *
 * Name editing model: a local draft string is kept on the view object,
 * synced from the doc only when the cursor enters a *different* table
 * (so the user can keep typing while remote changes land elsewhere) or
 * on initial focus into the input. Commits on blur and Enter; Escape
 * discards. We never call `view.focus()` from the input handlers — that
 * would steal focus away on every keystroke.
 */

import { Plugin } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  addColumnAfter,
  addRowAfter,
  deleteColumn,
  deleteRow,
  deleteTable,
} from "prosemirror-tables";
import type { Command } from "prosemirror-state";
import { TOOLBAR_ICONS } from "./icons";
import { countOtherTablesWithName, findTable, setTableName } from "./tables";

function svgButton(
  iconName: keyof typeof TOOLBAR_ICONS,
  label: string,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pm-tt-btn";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${TOOLBAR_ICONS[iconName]}</svg>`;
  return btn;
}

function textButton(label: string, title: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pm-tt-btn pm-tt-text";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.textContent = label;
  return btn;
}

class TableTooltipView {
  private root: HTMLDivElement;
  private nameInput!: HTMLInputElement;
  private warnEl!: HTMLSpanElement;
  private apiBtn!: HTMLButtonElement;
  private view: EditorView;
  private docId: string;

  // Name-edit state. `lastTablePos` lets us re-sync the draft from the
  // doc when the cursor enters a different table; while it stays in one
  // table, the input is the source of truth.
  private nameDraft = "";
  private lastTablePos = -1;

  // Bound listeners so destroy() can detach them cleanly.
  private listeners: Array<{
    target: EventTarget;
    type: string;
    fn: EventListenerOrEventListenerObject;
  }> = [];

  constructor(view: EditorView, docId: string) {
    this.view = view;
    this.docId = docId;

    this.root = document.createElement("div");
    this.root.className = "pm-table-tooltip-root";
    this.root.style.display = "none";
    this.root.append(this.buildInTableBar());

    const parent = view.dom.parentNode as HTMLElement | null;
    if (parent) parent.appendChild(this.root);

    this.update(view, null);
  }

  private buildInTableBar(): HTMLDivElement {
    const bar = document.createElement("div");
    bar.className = "pm-table-tooltip pm-tt-bar";

    const addRow = svgButton("rowAdd", "Add row below");
    const addCol = svgButton("colAdd", "Add column after");
    const delTable = svgButton("trashTable", "Delete table");
    const delRow = textButton("row−", "Delete row");
    const delCol = textButton("col−", "Delete column");

    this.wireCommand(addRow, addRowAfter);
    this.wireCommand(addCol, addColumnAfter);
    this.wireCommand(delTable, deleteTable);
    this.wireCommand(delRow, deleteRow);
    this.wireCommand(delCol, deleteColumn);

    const sep = document.createElement("span");
    sep.className = "pm-tt-sep";
    sep.setAttribute("aria-hidden", "true");

    this.nameInput = document.createElement("input");
    this.nameInput.type = "text";
    this.nameInput.className = "pm-tt-name";
    this.nameInput.placeholder = "Table name (for API)";
    this.nameInput.title =
      "API id used at /-/paper/api/docs/{id}/tables/{name}. Press Enter or click away to save.";

    this.on(this.nameInput, "input", () => {
      this.nameDraft = this.nameInput.value;
      this.refreshWarning();
    });
    this.on(this.nameInput, "blur", () => {
      this.commitName();
    });
    this.on(this.nameInput, "keydown", (event) => {
      const e = event as KeyboardEvent;
      if (e.key === "Enter") {
        e.preventDefault();
        this.commitName();
        this.nameInput.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        const found = findTable(this.view.state);
        const docName = (found?.node.attrs.name as string | null) ?? "";
        this.nameDraft = docName;
        this.nameInput.value = docName;
        this.refreshWarning();
        this.nameInput.blur();
      }
    });
    // Stop the editor from receiving keys while the input is focused —
    // PM listens at the contenteditable, but mousedown on the input
    // doesn't always blur the editor cleanly across browsers.
    this.on(this.nameInput, "mousedown", (event) => {
      event.stopPropagation();
    });

    this.warnEl = document.createElement("span");
    this.warnEl.className = "pm-tt-warn";
    this.warnEl.style.display = "none";

    // "API" button — opens /-/paper/api/docs/{docId}/tables/{name} in a
    // new tab. Disabled when the table has no committed name (the
    // endpoint would 404). We read state at click time, so when the user
    // clicks API right after typing, the input's blur fires first and
    // commits the draft before this handler runs.
    this.apiBtn = textButton("API", "Open this table's API URL in a new tab");
    this.apiBtn.classList.add("pm-tt-api");
    this.on(this.apiBtn, "click", (event) => {
      event.preventDefault();
      const found = findTable(this.view.state);
      if (!found) return;
      const name = (found.node.attrs.name as string | null) ?? "";
      if (!name) return;
      const url = `/-/paper/api/docs/${this.docId}/tables/${encodeURIComponent(name)}`;
      window.open(url, "_blank", "noopener,noreferrer");
    });

    bar.append(
      addRow,
      addCol,
      delRow,
      delCol,
      delTable,
      sep,
      this.nameInput,
      this.warnEl,
      this.apiBtn,
    );
    return bar;
  }

  private wireCommand(btn: HTMLButtonElement, cmd: Command) {
    this.on(btn, "click", (event) => {
      event.preventDefault();
      cmd(this.view.state, this.view.dispatch);
      this.view.focus();
    });
  }

  private on(
    target: EventTarget,
    type: string,
    fn: EventListenerOrEventListenerObject,
  ) {
    target.addEventListener(type, fn);
    this.listeners.push({ target, type, fn });
  }

  private commitName() {
    setTableName(this.nameDraft)(this.view.state, this.view.dispatch);
    // Deliberately no view.focus() — user explicitly moved focus away.
  }

  private refreshWarning() {
    const found = findTable(this.view.state);
    const count = found
      ? countOtherTablesWithName(this.view.state, this.nameDraft, found.pos)
      : 0;
    if (count > 0) {
      this.warnEl.style.display = "";
      this.warnEl.textContent = `⚠ duplicate (${count} other${count === 1 ? "" : "s"})`;
      this.warnEl.title =
        `Another table in this document already uses this name. ` +
        `The /tables/${this.nameDraft} endpoint will return whichever appears first.`;
      this.nameInput.classList.add("pm-tt-name-warn");
    } else {
      this.warnEl.style.display = "none";
      this.nameInput.classList.remove("pm-tt-name-warn");
    }
  }

  update(view: EditorView, lastState: EditorState | null) {
    const state = view.state;
    if (
      lastState &&
      lastState.doc.eq(state.doc) &&
      lastState.selection.eq(state.selection)
    ) {
      return;
    }

    const found = findTable(state);
    if (!found) {
      this.root.style.display = "none";
      this.lastTablePos = -1;
      return;
    }

    this.root.style.display = "";
    // The committed doc name gates the API button — typing in the input
    // alone shouldn't enable it because the endpoint will 404 until
    // setNodeMarkup commits.
    const docName = (found.node.attrs.name as string | null) ?? "";
    this.apiBtn.disabled = docName.length === 0;
    this.apiBtn.title = docName
      ? `Open /-/paper/api/docs/${this.docId}/tables/${docName} in a new tab`
      : "Set a table name to enable the API link";

    if (found.pos !== this.lastTablePos) {
      // Cursor entered a different table — sync the draft from the doc.
      this.lastTablePos = found.pos;
      const docName = (found.node.attrs.name as string | null) ?? "";
      // Only overwrite the input when the user isn't actively typing in
      // it (otherwise switching tables mid-type would clobber the draft,
      // but in practice the cursor must be IN the table to be the
      // tracking position, so the input can't have focus simultaneously
      // unless the click is happening this same tick — accept that).
      if (document.activeElement !== this.nameInput) {
        this.nameDraft = docName;
        this.nameInput.value = docName;
        this.refreshWarning();
      }
    } else {
      // Same table — the doc may have been edited (e.g. remote rename).
      // If the input isn't focused, sync.
      if (document.activeElement !== this.nameInput) {
        const docName = (found.node.attrs.name as string | null) ?? "";
        if (this.nameInput.value !== docName) {
          this.nameDraft = docName;
          this.nameInput.value = docName;
          this.refreshWarning();
        }
      }
    }

    this.positionAboveTable(view, found.pos);
  }

  private positionAboveTable(view: EditorView, tablePos: number) {
    // Anchor to the horizontal center of the table's DOM rect; the CSS
    // class `pm-tt-pos-table` shifts the bar up + half-left from this
    // origin so it sits centered above the table.
    const dom = view.nodeDOM(tablePos);
    if (!(dom instanceof HTMLElement)) return;
    const parent = this.root.offsetParent as HTMLElement | null;
    if (!parent) {
      this.root.style.display = "none";
      return;
    }
    const tableBox = dom.getBoundingClientRect();
    const box = parent.getBoundingClientRect();
    const cx = tableBox.left + tableBox.width / 2;
    this.root.style.left = `${cx - box.left}px`;
    this.root.style.top = `${tableBox.top - box.top}px`;
  }

  destroy() {
    for (const { target, type, fn } of this.listeners) {
      target.removeEventListener(type, fn);
    }
    this.listeners = [];
    this.root.remove();
  }
}

export function tableInsertTooltipPlugin(docId: string): Plugin {
  return new Plugin({
    view(editorView) {
      return new TableTooltipView(editorView, docId);
    },
  });
}
