/**
 * Tracks which single code-carrying block (if any) is "active" — i.e. mounted
 * as a live CodeMirror editor (tier 1). See plans/codemirror/02-design.md §4.
 * The three code-carrying types are `code_block`, `sql_block` and `source`;
 * `sql_block` / `source` always resolve to the SQL grammar (their text is
 * always SQL) rather than a stored `language` attr.
 *
 * A block is a *candidate* when the view is editable, the PM selection sits
 * wholly inside one of those types, and the view isn't mid-composition — with
 * two per-type guards: a `sql_block` is never a candidate while `attrs.hidden`
 * (its editor is collapsed to results), and a `source`'s NodeView-local
 * "collapsed" pill state is invisible here, so the plugin still marks a
 * collapsed `source` a candidate and the NodeView declines the CM mount itself
 * (sourceBlockView.ts). On a new candidate the plugin kicks `loadCmCore()`
 * plus the block language's `cm()` loader; the block stays a plain PM-editable
 * `<pre>` (typing is never locked out) until *both* resolve, at which point a
 * `codeFocusKey` meta flips the plugin's `active` position and stashes the
 * resolved `core` + `support`. Selection leaving the block deactivates
 * immediately. At most one block is active; moving between two code blocks
 * tears one CM down and mounts the other (cheap once chunks are cached).
 *
 * `active` is the position *before* the block (== the NodeView's `getPos()`),
 * mapped through every transaction. The NodeView reads this state as the
 * single source of truth for its mode; a node decoration on the active block
 * is what forces PM to re-run the NodeView's `update()` (which returns false
 * to trigger the mode-swap rebuild) when activation changes.
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { resolveLanguage, type PaperLanguage } from "./languages";
import { loadCmCore, type CmCore, type LanguageSupport } from "./cmCore";

/** The three block types whose text is code the CM tier can own. */
const CODE_TYPES = new Set(["code_block", "sql_block", "source"]);

/** The registry entry a code-carrying node mounts against: a `code_block`
 * honors its stored `language`, while `sql_block` / `source` are always SQL. */
function languageForNode(node: PMNode): PaperLanguage | undefined {
  if (node.type.name === "code_block") {
    return resolveLanguage(node.attrs.language as string | null);
  }
  return resolveLanguage("sql");
}

export interface CodeFocusState {
  /** Position before the active code_block, or null. */
  active: number | null;
  /** Resolved CM core once the active block's loaders settle. */
  core: CmCore | null;
  /** Resolved language support for the active block (null for plain/unknown). */
  support: LanguageSupport | null;
}

interface CodeFocusMeta {
  active: number | null;
  core: CmCore | null;
  support: LanguageSupport | null;
}

const INACTIVE: CodeFocusState = { active: null, core: null, support: null };

export const codeFocusKey = new PluginKey<CodeFocusState>("codeFocus");

/** The position before the active CM block, or null — read by codeHighlight
 * to skip re-parsing the block CM already owns. */
export function activeCodePos(state: EditorState): number | null {
  return codeFocusKey.getState(state)?.active ?? null;
}

/** The code-carrying block the selection sits wholly inside (returns its
 * `getPos`), gated on editability, composition, and the per-type guards, or
 * null. A hidden `sql_block` is excluded here; a collapsed `source` is not
 * (the NodeView declines the mount instead). */
function candidatePos(state: EditorState, view: EditorView): number | null {
  if (!view.editable || view.composing) return null;
  const { $from, $to } = state.selection;
  const parent = $from.parent;
  if (!CODE_TYPES.has(parent.type.name)) return null;
  if (!$from.sameParent($to)) return null;
  if (parent.type.name === "sql_block" && parent.attrs.hidden) return null;
  return $from.before();
}

// @feat code-cm-focus: plugin tracking the one active CM block — resolves
// core+grammar off a new candidate then flips `active`, mapping the pos and
// exposing it (activeCodePos) so tier-0 skips the block CM owns
export function codeFocusPlugin(): Plugin<CodeFocusState> {
  // The candidate we've most recently kicked loaders for, plus a monotonic
  // sequence so a superseded load (selection moved on) is discarded on resolve.
  let requested: number | null | undefined = undefined;
  let seq = 0;

  return new Plugin<CodeFocusState>({
    key: codeFocusKey,
    state: {
      init(): CodeFocusState {
        return INACTIVE;
      },
      apply(tr, value): CodeFocusState {
        const meta = tr.getMeta(codeFocusKey) as CodeFocusMeta | undefined;
        if (meta) return meta;
        if (value.active == null) return value;
        // Map the active pos forward; drop if the block was deleted.
        const mapped = tr.mapping.mapResult(value.active, -1);
        if (mapped.deleted) return INACTIVE;
        return { ...value, active: mapped.pos };
      },
    },
    view(editorView) {
      // Sync `requested` with whatever the initial state already reflects.
      requested = codeFocusKey.getState(editorView.state)?.active ?? null;
      return {
        update(view) {
          const cand = candidatePos(view.state, view);
          if (cand === requested) return;
          requested = cand;
          const token = ++seq;

          if (cand == null) {
            if (activeCodePos(view.state) != null) {
              view.dispatch(view.state.tr.setMeta(codeFocusKey, INACTIVE));
            }
            return;
          }

          const node = view.state.doc.nodeAt(cand);
          const entry = node ? languageForNode(node) : undefined;
          Promise.all([
            loadCmCore(),
            entry ? entry.cm() : Promise.resolve({ support: null }),
          ]).then(([core, lang]) => {
            if (token !== seq || view.isDestroyed) return;
            // Re-check the candidate is still this same block before flipping.
            if (candidatePos(view.state, view) !== cand) return;
            const meta: CodeFocusMeta = {
              active: cand,
              core,
              support: lang.support,
            };
            view.dispatch(view.state.tr.setMeta(codeFocusKey, meta));
          });
        },
      };
    },
    props: {
      // A node decoration on the active block; its appearance/disappearance is
      // what makes PM re-run the NodeView's update() so the mode swap fires.
      decorations(state) {
        const active = activeCodePos(state);
        if (active == null) return null;
        const node = state.doc.nodeAt(active);
        if (!node) return null;
        return DecorationSet.create(state.doc, [
          Decoration.node(active, active + node.nodeSize, {}, { codeCm: true }),
        ]);
      },
    },
  });
}
