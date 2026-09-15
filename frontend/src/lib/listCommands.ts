/**
 * Shared list commands: the indent / outdent pair behind the Tab / Shift-Tab
 * chains and the `Mod-]` / `Mod-[` registry chords in collab.ts plus the
 * Toolbar List ▾ Indent / Outdent rows, and the toggle-list kind / collapse
 * pair behind `/toggle`, the List ▾ Toggle-list row and the `[>] ` input rule.
 *
 * `indentListSelection` / `dedentListSelection`'s export names are fixed by
 * plans/list-kinds ticket 05, which replaces the bodies with a multi-item,
 * mixed-type range command — callers must not change. Names may be *added*
 * here (as the toggle pair does); none may be renamed.
 */
import type { Command, Transaction } from "prosemirror-state";
import { chainCommands } from "prosemirror-commands";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import type { Node as PMNode } from "prosemirror-model";
import { schema, clampListItemKind, type ListItemKind } from "./schema";

/** Current model: task_item first, then list_item. plans/list-kinds ticket 05
 *  replaces the body with a multi-item, mixed-type range command. Callers
 *  (collab.ts Tab chain + registry chord, Toolbar List ▾) must not change. */
export const indentListSelection: Command = chainCommands(
  sinkListItem(schema.nodes.task_item),
  sinkListItem(schema.nodes.list_item),
);

/** Outdent counterpart of {@link indentListSelection}; same contract. */
export const dedentListSelection: Command = chainCommands(
  liftListItem(schema.nodes.task_item),
  liftListItem(schema.nodes.list_item),
);

/**
 * Positions of every `list_item` in `doc` whose OWN paragraph overlaps
 * [from, to].
 *
 * The scope rule for {@link setListItemKind}: an item converts only when the
 * selection touches its own summary line, so converting a parent item leaves
 * its nested children alone unless the selection covers them too. An item's
 * own paragraph is its first child — everything after that (nested lists) is
 * the subtree.
 */
function listItemsInRange(doc: PMNode, from: number, to: number): number[] {
  const found: number[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === schema.nodes.list_item && node.firstChild) {
      const start = pos + 1;
      const end = start + node.firstChild.nodeSize;
      if (start <= to && end >= from) found.push(pos);
    }
    // Always descend: nested lists inside an item hold more candidates.
    return true;
  });
  return found;
}

/**
 * Retype the collected items (and, for toggles, their ordered containers) on
 * `tr`. Every write is a `setNodeMarkup`, which preserves node sizes, so the
 * positions collected up-front stay valid for the whole batch.
 */
function applyListItemKind(tr: Transaction, positions: number[], kind: ListItemKind): void {
  if (kind === "toggle") {
    // A chevron replacing a number is incoherent, so an enclosing
    // `ordered_list` is retyped to `bullet_list` first. Content shapes are
    // identical (`list_item+`), so this is one `setNodeMarkup` on the
    // container rather than a re-wrap. Command-level rule: PM has no
    // per-container attr restrictions. Only on the way *to* toggle —
    // converting an item back to a plain bullet must not silently strip a
    // numbered list of its numbering.
    const containers = new Set<number>();
    for (const pos of positions) {
      const $item = tr.doc.resolve(pos);
      if ($item.parent.type === schema.nodes.ordered_list) {
        containers.add($item.before($item.depth));
      }
    }
    for (const containerPos of containers) {
      tr.setNodeMarkup(containerPos, schema.nodes.bullet_list, null);
    }
  }
  for (const pos of positions) {
    const item = tr.doc.nodeAt(pos);
    if (!item) continue;
    tr.setNodeMarkup(pos, undefined, {
      ...item.attrs,
      kind,
      // Converting to a bullet drops the chevron, so a collapsed subtree
      // would have no way back into view — reset the fold.
      collapsed: kind === "bullet" ? false : item.attrs.collapsed,
    });
  }
}

/**
 * Set the `kind` attr on every `list_item` the selection touches (slash
 * `/toggle`, the Toolbar List ▾ Toggle-list row).
 *
 * Outside a bullet/ordered list the selection is wrapped in a `bullet_list`
 * first — the same `wrapInList` the plain list toolbar buttons use — so
 * `/toggle` works from a bare paragraph. Declines (and so renders the menu row
 * disabled) exactly where `wrapInList` declines.
 */
// @feat toggle-list: command converts the selected list items to/from toggles
export function setListItemKind(kind: ListItemKind): Command {
  return (state, dispatch) => {
    const sel = state.selection;
    const items = listItemsInRange(state.doc, sel.from, sel.to);
    if (items.length === 0) {
      const wrap = wrapInList(schema.nodes.bullet_list);
      if (!dispatch) return wrap(state);
      let wrapped = false;
      wrap(state, (tr) => {
        // `wrapInList` hands back a live transaction off `state.tr`; keep
        // editing it so the wrap and the retype land as one undo step.
        applyListItemKind(tr, listItemsInRange(tr.doc, tr.selection.from, tr.selection.to), kind);
        dispatch(tr.scrollIntoView());
        wrapped = true;
      });
      return wrapped;
    }
    if (dispatch) {
      const tr = state.tr;
      applyListItemKind(tr, items, kind);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/**
 * Enter inside a COLLAPSED toggle item — the one correction to PM's stock
 * split.
 *
 * Enter at the end of a toggle's summary is meant to spawn another toggle,
 * which is exactly what `splitListItem(list_item)` (bound by
 * `buildKeymap`) already does: it copies the item's attrs onto the new item,
 * so `kind: "toggle"` carries over for free. But it copies *every* attr,
 * `collapsed` included — and the split moves whatever followed the cursor
 * (the nested child list) into the NEW item. Stock behaviour therefore hands
 * the user a pre-collapsed item with their children hidden inside it.
 *
 * So: split, then clear `collapsed` on the item the cursor landed in, in the
 * same transaction (one undo step). Declines everywhere else — a bullet item,
 * or an already-expanded toggle — so the stock binding keeps handling those.
 */
// @feat toggle-list: Enter never yields a pre-collapsed item
export const splitListItemUncollapsed: Command = (state, dispatch) => {
  const head = state.selection.$from;
  const itemDepth = head.depth - 1;
  if (itemDepth < 1) return false;
  const item = head.node(itemDepth);
  if (item.type !== schema.nodes.list_item) return false;
  if (clampListItemKind(item.attrs.kind) !== "toggle") return false;
  if (item.attrs.collapsed !== true) return false;
  const split = splitListItem(schema.nodes.list_item);
  if (!dispatch) return split(state);
  return split(state, (tr) => {
    // The split leaves the selection in the new item's first textblock; walk
    // back out to the item it belongs to.
    const $new = tr.selection.$from;
    for (let d = $new.depth; d > 0; d--) {
      const node = $new.node(d);
      if (node.type !== schema.nodes.list_item) continue;
      tr.setNodeMarkup($new.before(d), undefined, { ...node.attrs, collapsed: false });
      break;
    }
    dispatch(tr);
  });
};

/**
 * Flip the shared `collapsed` attr of the toggle `list_item` at the selection
 * head. The NodeView owns its own click path (it also handles the read-only
 * local override and the caret rescue); this is the command form, exported so
 * a later keybinding has something to bind — there is none in v1.
 *
 * Declines when the innermost enclosing `list_item` is a plain bullet, so a
 * future chord falls through to whatever else is bound to the key.
 */
// @feat toggle-list: command flips the shared collapsed attr at the cursor
export const toggleListItemCollapsed: Command = (state, dispatch) => {
  const head = state.selection.$from;
  for (let d = head.depth; d > 0; d--) {
    const node = head.node(d);
    if (node.type !== schema.nodes.list_item) continue;
    if (clampListItemKind(node.attrs.kind) !== "toggle") return false;
    if (dispatch) {
      dispatch(
        state.tr.setNodeMarkup(head.before(d), undefined, {
          ...node.attrs,
          collapsed: node.attrs.collapsed !== true,
        }),
      );
    }
    return true;
  }
  return false;
};
