/**
 * Heading-based folding for the editor.
 *
 * Decoration-only — no schema change. State lives in a single
 * DecorationSet of "fold markers" attached to each folded heading
 * node, mapped through every transaction so positions stay aligned.
 *
 * On every render we walk the doc, find the section range under each
 * folded heading (everything until the next heading at equal-or-
 * shallower level, or end of doc), and apply node decorations with
 * `.pm-folded` to hide those blocks via CSS. We also add a chevron
 * widget on every heading so users can toggle.
 *
 * Fold state is per-session — it doesn't persist across reloads or
 * sync to other collab peers.
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

const foldKey = new PluginKey<DecorationSet>("foldHeadings");

interface FoldMeta {
  pos: number;
  fold: boolean;
}

/** Toggle the fold state of the heading at the given doc position. */
export function setHeadingFolded(
  view: EditorView,
  pos: number,
  fold: boolean,
): void {
  view.dispatch(view.state.tr.setMeta(foldKey, { pos, fold } as FoldMeta));
}

/** Each top-level child of the doc + its absolute position. */
function topLevelChildren(doc: PMNode): Array<{ node: PMNode; pos: number }> {
  const out: Array<{ node: PMNode; pos: number }> = [];
  doc.forEach((node, offset) => out.push({ node, pos: offset }));
  return out;
}

/** Build node-hide decorations for content under each folded heading. */
function computeHiddenDecorations(
  doc: PMNode,
  folded: Array<{ pos: number; level: number }>,
): Decoration[] {
  const decorations: Decoration[] = [];
  const children = topLevelChildren(doc);
  for (const { pos: headingPos, level } of folded) {
    const headingIdx = children.findIndex((c) => c.pos === headingPos);
    if (headingIdx === -1) continue;
    for (let i = headingIdx + 1; i < children.length; i++) {
      const { node, pos } = children[i];
      // Stop at the next heading with equal or shallower level.
      if (
        node.type.name === "heading" &&
        (node.attrs.level as number) <= level
      ) {
        break;
      }
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { class: "pm-folded" }),
      );
    }
  }
  return decorations;
}

const CHEVRON_DOWN_SVG =
  '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"/></svg>';
const CHEVRON_RIGHT_SVG =
  '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708"/></svg>';

/** Chevron widget rendered just inside the heading's left edge. */
function chevronWidget(headingPos: number, folded: boolean): Decoration {
  return Decoration.widget(
    headingPos + 1,
    (view) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pm-fold-toggle";
      btn.contentEditable = "false";
      btn.setAttribute(
        "aria-label",
        folded ? "Unfold section" : "Fold section",
      );
      btn.title = folded ? "Unfold section" : "Fold section";
      btn.innerHTML = folded ? CHEVRON_RIGHT_SVG : CHEVRON_DOWN_SVG;
      // mousedown (not click) so we beat the editor's selection-on-click.
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setHeadingFolded(view, headingPos, !folded);
      });
      return btn;
    },
    {
      side: -1,
      // Key includes folded state so the widget rebuilds (and the icon
      // flips) whenever the state changes.
      key: `fold-${headingPos}-${folded ? 1 : 0}`,
      // The widget is a UI affordance, not part of the document — keep
      // the cursor / selection from landing on it.
      ignoreSelection: true,
    },
  );
}

export const foldHeadingsPlugin = new Plugin<DecorationSet>({
  key: foldKey,
  state: {
    init() {
      return DecorationSet.empty;
    },
    apply(tr, set) {
      // Map existing fold markers forward so they stay attached to
      // their heading nodes through edits.
      let next = set.map(tr.mapping, tr.doc);
      const meta = tr.getMeta(foldKey) as FoldMeta | undefined;
      if (meta) {
        const node = tr.doc.nodeAt(meta.pos);
        if (node && node.type.name === "heading") {
          if (meta.fold) {
            next = next.add(tr.doc, [
              Decoration.node(
                meta.pos,
                meta.pos + node.nodeSize,
                {},
                { foldHeading: true },
              ),
            ]);
          } else {
            const existing = next.find(
              meta.pos,
              meta.pos + node.nodeSize,
              (s) => s.foldHeading === true,
            );
            if (existing.length) next = next.remove(existing);
          }
        }
      }
      return next;
    },
  },
  props: {
    decorations(state) {
      const set = foldKey.getState(state);
      if (!set) return DecorationSet.empty;
      const doc = state.doc;

      // Identify which headings are currently folded.
      const folded: Array<{ pos: number; level: number }> = [];
      doc.forEach((node, offset) => {
        if (node.type.name !== "heading") return;
        const found = set.find(
          offset,
          offset + node.nodeSize,
          (s) => s.foldHeading === true,
        );
        if (found.length) {
          folded.push({ pos: offset, level: node.attrs.level as number });
        }
      });

      const decorations: Decoration[] = [];
      decorations.push(...computeHiddenDecorations(doc, folded));
      // Chevron on every heading (folded or not).
      doc.forEach((node, offset) => {
        if (node.type.name !== "heading") return;
        const isFolded = folded.some((f) => f.pos === offset);
        decorations.push(chevronWidget(offset, isFolded));
      });
      return DecorationSet.create(doc, decorations);
    },
  },
});
