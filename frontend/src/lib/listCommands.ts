/**
 * Shared list indent / outdent commands. One definition for every caller:
 * the Tab / Shift-Tab chains and the `Mod-]` / `Mod-[` registry chords in
 * collab.ts, and the Toolbar List ▾ Indent / Outdent rows.
 *
 * Export names are fixed by plans/list-kinds ticket 05, which replaces the
 * bodies with a multi-item, mixed-type range command — callers must not
 * change.
 */
import type { Command } from "prosemirror-state";
import { chainCommands } from "prosemirror-commands";
import { liftListItem, sinkListItem } from "prosemirror-schema-list";
import { schema } from "./schema";

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
