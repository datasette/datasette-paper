/**
 * ＋ Insert menu item derivation. The toolbar's Insert menu does NOT define its
 * own items — it renders the same `SlashCommand[]` registry the `/` menu uses
 * (built once in `collab.ts` via `buildSlashCommands`), filtered to the insert
 * groups and grouped for display. Kept pure over the registry + `EditorState`
 * so the toolbar can derive it (RAF `tick` style, since PM transactions don't
 * rerender Svelte) and tests can assert it without a DOM / EditorView.
 *
 * The `styling` group is deliberately excluded — Text ▾ / List ▾ cover it.
 */
import type { EditorState } from "prosemirror-state";
import { SLASH_GROUPS, type SlashCommand, type SlashGroupKey } from "./slashMenu";

/** Groups the Insert menu surfaces, in `SLASH_GROUPS` order (styling excluded). */
export const INSERT_GROUPS: SlashGroupKey[] = ["media", "datasette", "embeds"];

export interface InsertMenuRow {
  command: SlashCommand;
  /** `true` when the command's `enabled(state)` predicate rejects the current
   *  context (e.g. `canInsertTable` inside a list). Rendered non-clickable. */
  disabled: boolean;
}

export interface InsertMenuGroup {
  key: SlashGroupKey;
  label: string;
  rows: InsertMenuRow[];
}

/**
 * The Insert menu contents: `commands` filtered to `INSERT_GROUPS` and bucketed
 * into one `InsertMenuGroup` per non-empty group, ordered by `SLASH_GROUPS`.
 * Within a group, registration (array) order is preserved.
 *
 * `disabled` comes from each command's `enabled?(state)` predicate — so the
 * `/`-menu gating (`canInsertTable`, `canDate`, …) is honoured for free. With a
 * null `state` (no live view yet) every row is enabled.
 */
export function insertMenuGroups(
  commands: SlashCommand[],
  state: EditorState | null,
): InsertMenuGroup[] {
  const allow = new Set<SlashGroupKey>(INSERT_GROUPS);
  return SLASH_GROUPS.filter((g) => allow.has(g.key)).flatMap((g) => {
    const rows: InsertMenuRow[] = commands
      .filter((c) => c.group === g.key)
      .map((command) => ({
        command,
        disabled: state ? !(command.enabled ? command.enabled(state) : true) : false,
      }));
    return rows.length ? [{ key: g.key, label: g.label, rows }] : [];
  });
}
