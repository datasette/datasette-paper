/**
 * The `insertDatasetteEmbed` ProseMirror command, split out of
 * `datasetteEmbed.ts` so that module's fetch helpers stay ProseMirror-free.
 *
 * This matters for the published page: `publishHydrate.ts` reuses
 * `datasetteEmbed.ts`'s `fetchEmbed` / `cellText`, and if those dragged in
 * `schema` (which constructs a ProseMirror Schema at module load) the slim
 * publish bundle would balloon to include all of ProseMirror. Keeping the one
 * command that needs the schema here breaks that dependency.
 */
import type { Command } from "prosemirror-state";

import { schema } from "./schema";

/** A ProseMirror command that inserts a `block_embed` block at the selection. */
export function insertDatasetteEmbed(ref: string, mode = "table"): Command {
  return (state, dispatch) => {
    const node = schema.nodes.block_embed.create({ ref, mode });
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}
