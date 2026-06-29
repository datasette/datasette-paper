/**
 * ProseMirror insert commands for the `sql_block` and `source` nodes, split out
 * of `sqlQuery.ts` so that module's `runSqlQuery` fetch helper stays
 * ProseMirror-free.
 *
 * This keeps the published page's slim hydrator (which reuses `runSqlQuery`)
 * from transitively importing `schema` — which constructs a ProseMirror Schema
 * at module load and would otherwise pull all of ProseMirror into the publish
 * bundle.
 */
import type { Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { schema } from "./schema";

/** A ProseMirror command that inserts an empty `sql_block` at the selection. */
export function insertSqlBlock(db: string | null = null): Command {
  return (state, dispatch) => {
    const node = schema.nodes.sql_block.create({ db, hidden: false });
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

/** Imperative variant for the slash menu (which hands us a view, not state). */
export function runInsertSqlBlock(view: EditorView, db: string | null = null): void {
  insertSqlBlock(db)(view.state, view.dispatch);
  view.focus();
}

/** A command that inserts an empty `source` (named query) at the selection.
 *  The NodeView defaults the database and exposes name + SQL inputs. */
export function insertSource(db: string | null = null): Command {
  return (state, dispatch) => {
    const node = schema.nodes.source.create({ name: null, db });
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}
