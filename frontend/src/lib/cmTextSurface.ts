/**
 * The CodeMirror text surface shared by the two SQL NodeViews (`sqlBlockView`,
 * `sourceBlockView`) when `codeFocusPlugin` marks their block active. It mounts
 * a live CM6 editor over the block's text and keeps it in bidirectional sync
 * with the PM document, exactly the way `codeBlockView.ts` does for
 * `code_block` — the minimal-diff sync core is reused from there
 * (`computeChange`) rather than reimplemented, so the collab-correctness
 * surface stays in one place.
 *
 * CM → PM forwards the minimal changed range as a `replaceWith`/`delete` plus
 * the mirrored selection; PM → CM (`syncFromNode`) diffs `node.textContent`
 * against the CM doc and applies the delta tagged with the `fromPM` annotation
 * (how remote collab steps land inside the focused block). An `updating`
 * re-entrancy flag breaks the echo loop. Undo/redo stay PM-owned: CM's history
 * extension is not installed and Mod-z/Mod-y forward to PM history.
 *
 * The host NodeView owns mode (static ↔ CM rebuild) and the block chrome; this
 * class owns only the mounted editor and the arrow/Escape exit keymap. Callers
 * pass block-specific `extraKeys` (e.g. Mod-Enter → run) and `extraExtensions`
 * (e.g. the SQL keyword-completion bundle).
 */
import { NodeSelection, Selection, TextSelection } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";
import { redo, undo } from "prosemirror-history";
import { schema } from "./schema";
import { computeChange } from "./codeBlockView";
import {
  type CmCore,
  type EditorView as CmView,
  type Extension,
  type KeyBinding,
  type LanguageSupport,
  type ViewUpdate,
} from "./cmCore";

export interface CmTextSurfaceConfig {
  /** The host PM editor view. */
  view: EditorView;
  /** The host NodeView's `getPos`. */
  getPos: () => number | undefined;
  /** The block node the surface currently mirrors. */
  node: PMNode;
  /** Resolved CM core (from `codeFocusPlugin`'s active state). */
  core: CmCore;
  /** Resolved language support for the block (SQLite dialect for SQL blocks). */
  support: LanguageSupport | null;
  /** Block-specific key bindings, installed ahead of the nav keymap. */
  extraKeys?: KeyBinding[];
  /** Block-specific CM extensions (e.g. `core.completion()`). */
  extraExtensions?: Extension[];
}

// @feat code-cm-focus: the shared CM6 text surface + PM↔CM sync reused by the
// SQL NodeViews (sql_block / source), on top of codeBlockView's diff core
export class CmTextSurface {
  /** The mounted CM editor's root element — the NodeView's text surface. */
  readonly dom: HTMLElement;
  private cm: CmView;
  private core: CmCore;
  private view: EditorView;
  private getPos: () => number | undefined;
  private node: PMNode;
  /** Re-entrancy guard breaking the PM↔CM echo loop. */
  private updating = false;

  constructor(cfg: CmTextSurfaceConfig) {
    this.core = cfg.core;
    this.view = cfg.view;
    this.getPos = cfg.getPos;
    this.node = cfg.node;
    const state = this.core.EditorState.create({
      doc: this.node.textContent,
      extensions: [
        cfg.support ? cfg.support : [],
        this.core.baseExtensions({
          keymap: [...(cfg.extraKeys ?? []), ...this.navKeymap()],
          extra: cfg.extraExtensions,
        }),
        this.core.EditorView.updateListener.of((u) => this.forwardUpdate(u)),
      ],
    });
    this.cm = new this.core.EditorView({ state });
    this.dom = this.cm.dom;
    // Move focus into CM once the surrounding PM update settles, when the caret
    // is inside this block (the async activation meta may carry no selection).
    queueMicrotask(() => {
      if (this.cm.hasFocus) return;
      const pos = this.getPos();
      const sel = this.view.state.selection;
      if (pos != null && sel.from >= pos && sel.to <= pos + this.node.nodeSize) {
        this.cm.focus();
      }
    });
  }

  focus(): void {
    this.cm.focus();
  }

  get hasFocus(): boolean {
    return this.cm.hasFocus;
  }

  // ── PM → CM ───────────────────────────────────────────────────────────────

  /** Adopt `node` as the current block and mirror any text change into CM
   * (guarded so it doesn't echo back out). */
  syncFromNode(node: PMNode): void {
    this.node = node;
    const change = computeChange(this.cm.state.doc.toString(), node.textContent);
    if (!change) return;
    this.updating = true;
    this.cm.dispatch({
      changes: { from: change.from, to: change.to, insert: change.insert },
      annotations: this.core.fromPM.of(true),
    });
    this.updating = false;
  }

  /** PM asks us to place a selection inside the block (content-relative
   * offsets); focus CM and mirror it, guarded against an echo. */
  setSelection(anchor: number, head: number): void {
    this.cm.focus();
    this.updating = true;
    this.cm.dispatch({ selection: { anchor, head } });
    this.updating = false;
  }

  destroy(): void {
    this.cm.destroy();
  }

  // ── CM → PM ───────────────────────────────────────────────────────────────

  private forwardUpdate(update: ViewUpdate): void {
    if (this.updating || !this.cm.hasFocus) return;
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

  // ── Nav keymap (arrows/Escape exit, PM-owned undo/redo) ───────────────────

  private navKeymap(): KeyBinding[] {
    return [
      { key: "ArrowUp", run: () => this.maybeEscape("line", -1) },
      { key: "ArrowLeft", run: () => this.maybeEscape("char", -1) },
      { key: "ArrowDown", run: () => this.maybeEscape("line", 1) },
      { key: "ArrowRight", run: () => this.maybeEscape("char", 1) },
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
}
