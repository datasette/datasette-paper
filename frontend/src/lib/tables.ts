/**
 * Small wrappers around prosemirror-tables for the toolbar.
 *
 * `insertTable(rows, cols)` builds a fresh table with one header row
 * and `rows-1` body rows of `cols` columns each, then replaces the
 * selection with it. Mirrors the Atlassian fork's helper but stays
 * minimal — no merge/split UI, so cells always get colspan=rowspan=1.
 *
 * `findTable(state)` walks up the cursor's ancestor chain to the
 * containing `table` node, returning its position + node, or null.
 *
 * `setTableName(state, name)` is a Command that updates the
 * containing table's `name` attr via setNodeMarkup. The change rides
 * through ProseMirror steps like any other doc edit and round-trips
 * over collab.
 */

import type { Command, EditorState, Transaction } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import {
  CellSelection,
  addRowAfter,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
} from "prosemirror-tables";
import { schema } from "./schema";

/**
 * The cursor sits on a place where it makes sense to insert a top-level
 * table: empty selection, depth=1 (parent is the doc), and the
 * containing block is an empty paragraph. The toolbar's Insert-table
 * button uses this to gate its disabled state — if there's text on the
 * line, inserting a table replaces the selection and would split the
 * paragraph, which is rarely what the user wants.
 */
export function canInsertTable(state: EditorState): boolean {
  if (findTable(state)) return false;
  const sel = state.selection;
  if (!sel.empty) return false;
  const $from = sel.$from;
  if ($from.depth !== 1) return false;
  const block = $from.parent;
  if (block.type !== schema.nodes.paragraph) return false;
  return block.content.size === 0;
}

export function insertTable(rows = 3, cols = 3): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const cellType = schema.nodes.table_cell;
    const headerType = schema.nodes.table_header;
    const rowType = schema.nodes.table_row;
    const tableType = schema.nodes.table;
    const para = schema.nodes.paragraph;

    const headerRow = rowType.create(
      null,
      Array.from({ length: cols }, () => headerType.createAndFill(null, para.create())!),
    );
    const bodyRows = Array.from({ length: Math.max(0, rows - 1) }, () =>
      rowType.create(
        null,
        Array.from({ length: cols }, () => cellType.createAndFill(null, para.create())!),
      ),
    );
    const table = tableType.create(null, [headerRow, ...bodyRows]);

    if (!table) return false;
    if (dispatch) {
      const tr = state.tr.replaceSelectionWith(table).scrollIntoView();
      dispatch(tr);
    }
    return true;
  };
}

export interface TableInfo {
  pos: number;
  node: PMNode;
}

/** Returns the enclosing table node + its absolute position, or null. */
export function findTable(state: EditorState): TableInfo | null {
  const sel = state.selection;
  for (let d = sel.$from.depth; d > 0; d--) {
    const node = sel.$from.node(d);
    if (node.type === schema.nodes.table) {
      return { pos: sel.$from.before(d), node };
    }
  }
  return null;
}

/**
 * Count how many *other* tables in the doc share `name` (excluding the
 * table at `ownPos`). Used by the toolbar to surface a duplicate-name
 * warning live as the user types. Empty/whitespace name → 0.
 */
export function countOtherTablesWithName(
  state: EditorState,
  name: string,
  ownPos: number,
): number {
  const trimmed = name.trim();
  if (!trimmed) return 0;
  let count = 0;
  state.doc.descendants((node, pos) => {
    if (node.type === schema.nodes.table) {
      if (
        pos !== ownPos &&
        ((node.attrs.name as string | null) ?? "") === trimmed
      ) {
        count++;
      }
      // Tables can't (in practice) contain other tables, and skipping
      // descent here also avoids walking the cell forest.
      return false;
    }
    return true;
  });
  return count;
}

/**
 * Tab-in-last-cell behavior: try `goToNextCell(1)` first; if that fails
 * (cursor is in the table's bottom-right cell), append a new row and
 * advance into its first cell.
 *
 * Implemented as two consecutive dispatches: first the `addRowAfter`
 * transaction, then `goToNextCell` against the resulting state. The
 * view applies the first dispatch synchronously so the second command
 * sees the new row.
 */
export function tabOrAddRow(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    if (goToNextCell(1)(state, dispatch)) return true;
    // Probe whether addRowAfter could even run before committing.
    if (!addRowAfter(state)) return false;
    if (!dispatch) return true;
    let after: EditorState | null = null;
    addRowAfter(state, (tr) => {
      after = state.apply(tr);
      dispatch(tr);
    });
    if (!after) return true;
    goToNextCell(1)(after, dispatch);
    return true;
  };
}

/**
 * Backspace/Delete handler for table CellSelections. When the user has
 * selected one-or-more whole rows (or columns), delete the rows (cols)
 * outright rather than letting `baseKeymap`'s `deleteSelection` clear the
 * cell contents in place. A selection covering every cell collapses to
 * `deleteTable` so users don't have to delete row-by-row to remove the
 * whole thing. Returns false for any other selection so normal text
 * editing keystrokes inside cells still pass through.
 */
export function deleteRowOrColSelection(): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const sel = state.selection;
    if (!(sel instanceof CellSelection)) return false;
    const isRow = sel.isRowSelection();
    const isCol = sel.isColSelection();
    if (isRow && isCol) return deleteTable(state, dispatch);
    if (isRow) return deleteRow(state, dispatch);
    if (isCol) return deleteColumn(state, dispatch);
    return false;
  };
}

export function setTableName(name: string | null): Command {
  return (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const found = findTable(state);
    if (!found) return false;
    const trimmed = name && name.trim().length ? name.trim() : null;
    if (found.node.attrs.name === trimmed) return false;
    if (dispatch) {
      const tr = state.tr.setNodeMarkup(found.pos, undefined, {
        ...found.node.attrs,
        name: trimmed,
      });
      dispatch(tr);
    }
    return true;
  };
}
