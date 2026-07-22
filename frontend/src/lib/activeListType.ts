import type { EditorState } from "prosemirror-state";
import { schema } from "./schema";

export type ListTypeName = "bullet_list" | "ordered_list" | "task_list";

/**
 * The innermost list wrapping the selection head, or null when the selection
 * is not inside any list.
 *
 * Drives the List ▾ dropdown's trigger active state (non-null = inside a list)
 * and its active-row marker. Pure over `EditorState` so the toolbar can derive
 * it (RAF `tick` style, since PM transactions don't rerender Svelte) and tests
 * can assert it without a DOM.
 *
 * Innermost-wins: a bullet_list nested inside a task_list reports
 * "bullet_list", so we walk the ancestor chain from the deepest depth outward
 * and return the first list node we recognise.
 */
export function activeListType(state: EditorState): ListTypeName | null {
  const head = state.selection.$from;
  for (let d = head.depth; d > 0; d--) {
    const type = head.node(d).type;
    if (type === schema.nodes.bullet_list) return "bullet_list";
    if (type === schema.nodes.ordered_list) return "ordered_list";
    if (type === schema.nodes.task_list) return "task_list";
  }
  return null;
}
