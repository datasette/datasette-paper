import type { EditorState } from "prosemirror-state";
import { schema } from "./schema";

/**
 * Label for the Text ▾ dropdown trigger — the current block type at the
 * selection head ("Text", "H1"/"H2"/"H3", "Quote", "Callout", "Code").
 *
 * Pure over `EditorState` so the toolbar can derive it (RAF `tick` style, since
 * PM transactions don't rerender Svelte) and tests can assert it without a DOM.
 *
 * Precedence is innermost-block-wins: a heading or code block nested inside a
 * quote/callout reports the heading/code, so we walk the ancestor chain from
 * the deepest depth outward and return the first structural block we recognise.
 */
export function blockTypeLabel(state: EditorState): string {
  const head = state.selection.$from;
  for (let d = head.depth; d > 0; d--) {
    const node = head.node(d);
    if (node.type === schema.nodes.heading) return `H${node.attrs.level}`;
    if (node.type === schema.nodes.code_block) return "Code";
    if (node.type === schema.nodes.blockquote) return "Quote";
    if (node.type === schema.nodes.callout) return "Callout";
  }
  return "Text";
}
