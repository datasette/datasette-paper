/**
 * NodeView for `code_block`. Two tiers share one view class:
 *
 * - *Static* (tier 0): the same `<pre><code>` the stock `toDOM` produced, a
 *   contentDOM PM manages, with codeHighlight.ts's `tok-*` decorations. This
 *   is what viewers and unfocused editors see.
 * - *CM* (tier 1): while `codeFocusPlugin` marks this block active, the text
 *   surface is a live CodeMirror6 editor (real indentation, bracket
 *   matching/closing, per-language highlighting). At most one block is in CM
 *   mode at a time.
 *
 * PM cannot add or remove a `contentDOM` on a live NodeView, so the mode swap
 * is a *rebuild*: `update()` returns false whenever the plugin's mode for this
 * block differs from the mode it was built in, and PM destroys + recreates the
 * NodeView in the other mode. Mode is the ONLY extra rebuild trigger (else we
 * churn NodeViews). Selection survives because it lives in the PM doc model.
 *
 * PM ↔ CM sync adapts the ProseMirror reference integration
 * (prosemirror.net/examples/codemirror): CM → PM forwards the minimal changed
 * range as a `replaceWith`/`delete` plus the mirrored selection; PM → CM
 * (`update()`) diffs `node.textContent` against the CM doc and applies the
 * delta tagged with the `fromPM` annotation — this is how remote collab steps
 * land inside the focused block. An `updating` re-entrancy flag breaks the
 * echo loop. Undo/redo stay PM-owned (collab requires it): CM's history
 * extension is not installed and Mod-z/Mod-y forward to PM history.
 *
 * The corner language picker chrome (T04) is independent of the text surface,
 * so it keeps working in both modes; in CM mode a picker re-select swaps the
 * language via a CM compartment rather than rebuilding.
 *
 * Known limitations (accepted): remote carets (cursors.ts) can't render inside
 * the CM-mounted block; mode never flips while `view.composing`.
 */
import { NodeSelection, Selection, TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";
import { redo, undo } from "prosemirror-history";
import { iconMarkup } from "./datasetteEmbed";
import { schema } from "./schema";
import { allLanguages, resolveLanguage } from "./languages";
import { codeFocusKey } from "./codeFocusPlugin";
import {
  loadedCmCore,
  type CmCore,
  type Compartment,
  type EditorView as CmView,
  type KeyBinding,
  type LanguageSupport,
  type ViewUpdate,
} from "./cmCore";

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

/** A minimal text edit: replace `[from, to)` (CM doc offsets) with `insert`. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * Minimal single-range diff of two strings: the common prefix/suffix are
 * peeled off and the differing middle is returned as one `{from, to, insert}`
 * change (in `oldText` offsets), or null when the strings are identical. The
 * head/tail scan from the reference PM↔CM integration — pure so the sync core
 * is unit-testable without a live editor.
 */
// @feat code-cm-focus: minimal-diff + offset mapping — the pure PM↔CM sync core
export function computeChange(oldText: string, newText: string): TextChange | null {
  if (oldText === newText) return null;
  let start = 0;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (start < oldEnd && start < newEnd && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start++;
  }
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }
  return { from: start, to: oldEnd, insert: newText.slice(start, newEnd) };
}

/** CM doc offset → PM document position. `blockStart` is `getPos() + 1` (the
 * first text position inside the block). */
export function pmPosForCm(blockStart: number, cmOffset: number): number {
  return blockStart + cmOffset;
}

/** PM document position → CM doc offset (inverse of `pmPosForCm`). */
export function cmPosForPm(blockStart: number, pmPos: number): number {
  return pmPos - blockStart;
}

// @feat code-lang-picker: NodeView — corner button + type-to-filter popup writes code_block.language via setNodeMarkup
// @feat code-cm-focus: NodeView mode swap — static <pre> vs a mounted CM6
// editor, rebuilt on plugin mode flip, bidirectional PM↔CM sync with echo
// suppression, PM-owned undo/redo, arrow/Escape exit
export class CodeBlockView implements NodeView {
  dom: HTMLDivElement;
  contentDOM?: HTMLElement;
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

  // ── CM-mode state (null in static mode) ────────────────────────────────
  private cmMode: boolean;
  private cm: CmView | null = null;
  private langCompartment: Compartment | null = null;
  private surfaceEl: HTMLElement;
  /** Re-entrancy guard: suppress forwarding a CM change we ourselves pushed
   * from PM (and vice-versa) — breaks the sync echo loop. */
  private updating = false;

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

    // Chrome (button + popup) is independent of the text surface, so it's
    // built once and survives the static↔CM rebuilds unchanged. Neither is
    // part of the doc, so both are non-editable — only the text surface below
    // tracks the editor's real editable state (via inheritance from view.dom).
    this.langBtn = document.createElement("button");
    this.langBtn.type = "button";
    this.langBtn.className = "pm-code-block-lang-btn";
    this.langBtn.setAttribute("contenteditable", "false");
    this.langBtnLabel = document.createElement("span");
    this.langBtn.appendChild(this.langBtnLabel);
    const chevron = document.createElement("span");
    chevron.className = "pm-code-block-lang-icon";
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = iconMarkup("chevronDown"); // trusted constant SVG
    this.langBtn.appendChild(chevron);
    this.langBtn.addEventListener("mousedown", (e) => {
      // Prevent the click from moving the PM/CM selection into the button.
      e.preventDefault();
    });
    this.langBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.togglePicker();
    });

    this.popupEl = document.createElement("div");
    this.popupEl.className = "pm-code-block-lang-popup";
    this.popupEl.setAttribute("contenteditable", "false");
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

    // Build the text surface for the mode the plugin currently wants.
    this.cmMode = this.wantsCm();
    if (this.cmMode) {
      this.surfaceEl = this.mountCm();
    } else {
      const pre = document.createElement("pre");
      pre.setAttribute("spellcheck", "false");
      pre.setAttribute("autocorrect", "off");
      pre.setAttribute("autocapitalize", "off");
      const code = document.createElement("code");
      pre.appendChild(code);
      this.contentDOM = code;
      this.surfaceEl = pre;
    }
    this.dom.appendChild(this.surfaceEl);
    this.dom.appendChild(this.langBtn);
    this.dom.appendChild(this.popupEl);

    this.refreshLangBtn();
    this.refreshEditable();
  }

  // ── Mode ────────────────────────────────────────────────────────────────

  /** True when codeFocusPlugin has marked this block active AND its CM core
   * has resolved — the block should render as a live CM editor. */
  private wantsCm(): boolean {
    const pos = this.getPos();
    if (pos == null) return false;
    const s = codeFocusKey.getState(this.view.state);
    return !!s && s.active === pos && s.core != null;
  }

  private mountCm(): HTMLElement {
    const s = codeFocusKey.getState(this.view.state);
    const core = s?.core as CmCore;
    const support = (s?.support ?? null) as LanguageSupport | null;
    this.langCompartment = new core.Compartment();
    const state = core.EditorState.create({
      doc: this.node.textContent,
      extensions: [
        this.langCompartment.of(support ? support : []),
        core.baseExtensions({ keymap: this.cmKeymap() }),
        core.EditorView.updateListener.of((u) => this.forwardUpdate(u)),
      ],
    });
    this.cm = new core.EditorView({ state });
    // Move focus into CM once the surrounding PM update settles. PM usually
    // calls setSelection() (which focuses), but the async activation meta may
    // not carry a selection change, so nudge it when the caret is inside.
    queueMicrotask(() => {
      if (!this.cm || this.cm.hasFocus) return;
      const pos = this.getPos();
      const sel = this.view.state.selection;
      if (pos != null && sel.from >= pos && sel.to <= pos + this.node.nodeSize) {
        this.cm.focus();
      }
    });
    return this.cm.dom;
  }

  // ── CM → PM ───────────────────────────────────────────────────────────────

  private forwardUpdate(update: ViewUpdate): void {
    if (this.updating || !this.cm || !this.cm.hasFocus) return;
    const pos = this.getPos();
    if (pos == null) return;
    let offset = pos + 1;
    const main = update.state.selection.main;
    const selFrom = offset + main.from;
    const selTo = offset + main.to;
    const pmSel = this.view.state.selection;
    if (update.docChanged || pmSel.from !== selFrom || pmSel.to !== selTo) {
      const tr = this.view.state.tr;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const text = inserted.toString();
        if (text.length) {
          tr.replaceWith(offset + fromA, offset + toA, schema.text(text));
        } else {
          tr.delete(offset + fromA, offset + toA);
        }
        offset += text.length - (toA - fromA);
      });
      tr.setSelection(TextSelection.create(tr.doc, selFrom, selTo));
      this.view.dispatch(tr);
    }
  }

  // ── PM → CM ───────────────────────────────────────────────────────────────

  private syncCmFromNode(node: PMNode): void {
    if (!this.cm) return;
    const change = computeChange(this.cm.state.doc.toString(), node.textContent);
    if (!change) return;
    const core = loadedCmCore();
    this.updating = true;
    this.cm.dispatch({
      changes: { from: change.from, to: change.to, insert: change.insert },
      annotations: core ? core.fromPM.of(true) : undefined,
    });
    this.updating = false;
  }

  private swapLanguage(language: string | null): void {
    const entry = resolveLanguage(language);
    const compartment = this.langCompartment;
    if (!compartment) return;
    if (!entry) {
      this.cm?.dispatch({ effects: compartment.reconfigure([]) });
      return;
    }
    entry.cm().then(({ support }) => {
      if (!this.cm || this.langCompartment !== compartment) return;
      this.cm.dispatch({ effects: compartment.reconfigure(support) });
    });
  }

  // ── CM keymap (arrows/Escape exit, PM-owned undo/redo, Enter escape) ──────

  private cmKeymap(): KeyBinding[] {
    return [
      { key: "ArrowUp", run: () => this.maybeEscape("line", -1) },
      { key: "ArrowLeft", run: () => this.maybeEscape("char", -1) },
      { key: "ArrowDown", run: () => this.maybeEscape("line", 1) },
      { key: "ArrowRight", run: () => this.maybeEscape("char", 1) },
      { key: "Enter", run: () => this.maybeExitOnEnter() },
      { key: "Escape", run: () => this.selectBlockNode() },
      { key: "Mod-z", run: () => this.runPm(undo) },
      { key: "Mod-y", run: () => this.runPm(redo), mac: "Cmd-y" },
      { key: "Mod-Shift-z", run: () => this.runPm(redo) },
    ];
  }

  private runPm(command: typeof undo): boolean {
    const ran = command(this.view.state, this.view.dispatch);
    if (ran) this.view.focus();
    return ran;
  }

  /** Exit to the adjacent PM position when the CM caret is at the doc edge in
   * the given direction; otherwise let CM handle the arrow. */
  private maybeEscape(unit: "line" | "char", dir: -1 | 1): boolean {
    if (!this.cm) return false;
    const state = this.cm.state;
    const main = state.selection.main;
    if (!main.empty) return false;
    if (unit === "line") {
      const line = state.doc.lineAt(main.head);
      if (dir < 0 ? line.from > 0 : line.to < state.doc.length) return false;
    } else if (dir < 0 ? main.from > 0 : main.to < state.doc.length) {
      return false;
    }
    const pos = this.getPos();
    if (pos == null) return false;
    const targetPos = pos + (dir < 0 ? 0 : this.node.nodeSize);
    const selection = Selection.near(this.view.state.doc.resolve(targetPos), dir);
    this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView());
    this.view.focus();
    return true;
  }

  /** Escape selects the whole block node in PM (one more arrow then exits). */
  private selectBlockNode(): boolean {
    const pos = this.getPos();
    if (pos == null) return false;
    const selection = NodeSelection.create(this.view.state.doc, pos);
    this.view.dispatch(this.view.state.tr.setSelection(selection));
    this.view.focus();
    return true;
  }

  /** Parity with exitCodeBlockAtDocEnd (collab.ts): a second Enter at the end
   * of a code_block that's the last block in the doc escapes into a fresh
   * trailing paragraph instead of inserting another newline. PM's own handler
   * can't see the key while CM has focus, so it's re-implemented here. Returns
   * false in every other case so CM's insertNewlineAndIndent runs. */
  private maybeExitOnEnter(): boolean {
    if (!this.cm) return false;
    const state = this.cm.state;
    const main = state.selection.main;
    if (!main.empty || main.head !== state.doc.length) return false;
    if (state.doc.length === 0 || state.doc.sliceString(state.doc.length - 1) !== "\n") return false;
    const pos = this.getPos();
    if (pos == null) return false;
    if (pos + this.node.nodeSize !== this.view.state.doc.content.size) return false;
    // Strip the trailing newline in PM (the PM→CM sync mirrors it back into CM
    // before the block deactivates), append a paragraph, drop the caret in it.
    let tr = this.view.state.tr.delete(pos + main.head, pos + 1 + main.head);
    const paragraph = schema.nodes.paragraph.create();
    tr = tr.insert(tr.doc.content.size, paragraph);
    const cursor = tr.doc.content.size - paragraph.nodeSize + 1;
    tr = tr.setSelection(TextSelection.create(tr.doc, cursor));
    this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
    return true;
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
    if (!editable) {
      this.closePicker(false);
      // A live edit→view flip doesn't dispatch a transaction, so nudge one so
      // codeFocusPlugin re-evaluates and tears this CM block back to static.
      if (this.cmMode) this.view.dispatch(this.view.state.tr);
    }
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
    if (refocus) {
      if (this.cm) this.cm.focus();
      else this.view.focus();
    }
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
    // Mode is the only extra rebuild trigger: a mismatch forces PM to destroy
    // and recreate the NodeView in the other tier.
    if (this.wantsCm() !== this.cmMode) return false;
    const languageChanged = node.attrs.language !== this.node.attrs.language;
    this.node = node;
    if (this.cmMode) {
      this.syncCmFromNode(node);
      if (languageChanged) this.swapLanguage(node.attrs.language as string | null);
    }
    if (languageChanged) {
      this.refreshLangBtn();
      if (this.popupOpen) this.renderRows(this.inputEl.value);
    }
    this.refreshEditable();
    return true;
  }

  /** In CM mode PM asks us to place a selection inside the block (offsets are
   * relative to the node content); focus CM and mirror it, guarded so it
   * doesn't echo back out. */
  setSelection(anchor: number, head: number): void {
    if (!this.cm) return;
    this.cm.focus();
    this.updating = true;
    this.cm.dispatch({ selection: { anchor, head } });
    this.updating = false;
  }

  destroy(): void {
    this.editableObserver.disconnect();
    this.closePicker(false);
    if (this.cm) {
      this.cm.destroy();
      this.cm = null;
    }
  }

  // In CM mode CM owns its whole DOM subtree, so PM must ignore every mutation
  // and stop every event within it. In static mode PM manages the code text
  // (contentDOM); only chrome mutations/events are ours.
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (this.cmMode) return true;
    return !this.contentDOM?.contains(mutation.target as Node);
  }

  stopEvent(event: Event): boolean {
    if (this.cmMode) return true;
    return !this.contentDOM?.contains(event.target as Node | null);
  }
}
