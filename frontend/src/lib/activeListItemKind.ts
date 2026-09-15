import type { EditorState } from "prosemirror-state";
import { schema, clampListItemKind, type ListItemKind } from "./schema";

/**
 * The `kind` of the innermost `list_item` wrapping the selection head, or null
 * when the selection is not inside one.
 *
 * Companion to `activeListType`, which reports the *container*
 * (bullet/ordered/task) and so cannot answer this — toggle-ness lives on the
 * item, not on the list. Drives the List ▾ menu's Toggle-list active marker.
 * Pure over `EditorState` so the toolbar can derive it (RAF `tick` style, since
 * PM transactions don't rerender Svelte) and tests can assert it without a DOM.
 *
 * Innermost-wins, like `activeListType` / `blockTypeLabel`: a bullet item
 * nested inside a toggle item reports "bullet". The value is clamped, so a
 * kind authored by a newer client reads as "bullet" rather than leaking an
 * unknown string into the UI.
 */
// @feat toggle-list: toolbar active-state source for the List ▾ Toggle-list row
export function activeListItemKind(state: EditorState): ListItemKind | null {
  const head = state.selection.$from;
  for (let d = head.depth; d > 0; d--) {
    const node = head.node(d);
    if (node.type === schema.nodes.list_item) return clampListItemKind(node.attrs.kind);
  }
  return null;
}
