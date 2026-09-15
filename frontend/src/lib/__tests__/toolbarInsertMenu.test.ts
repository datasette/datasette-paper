/**
 * ＋ Insert menu derivation.
 *
 * `insertMenuGroups` is the pure filter/group step the toolbar's Insert menu
 * renders (it consumes the same `SlashCommand[]` registry the `/` menu uses).
 * These assertions feed a stub registry and pin: the `styling` group is
 * excluded; groups come out in `SLASH_GROUPS` order with their labels;
 * `enabled: () => false` yields a disabled row; and provider (`embeds`) commands
 * pass through. No DOM / EditorView needed — the `enabled` stubs ignore state,
 * so a cast placeholder stands in.
 */
import { describe, it, expect } from "vitest";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { insertMenuGroups } from "../insertMenuItems";
import { SLASH_GROUPS, type SlashCommand, type SlashGroupKey } from "../slashMenu";

/** A no-op state; the stub commands' `enabled` predicates never read it. */
const STATE = {} as unknown as EditorState;

function cmd(
  id: string,
  group: SlashGroupKey,
  extra: Partial<SlashCommand> = {},
): SlashCommand {
  return {
    id,
    label: id,
    keywords: [],
    icon: "database",
    group,
    run: (_view: EditorView) => {},
    ...extra,
  };
}

describe("insertMenuGroups", () => {
  it("excludes the styling group entirely", () => {
    const groups = insertMenuGroups(
      [cmd("h1", "styling"), cmd("image", "media")],
      null,
    );
    expect(groups.map((g) => g.key)).toEqual(["media"]);
    // The styling command never surfaces, even flattened.
    const ids = groups.flatMap((g) => g.rows.map((r) => r.command.id));
    expect(ids).not.toContain("h1");
  });

  it("orders groups + labels by SLASH_GROUPS (styling omitted)", () => {
    // Deliberately register out of display order.
    const groups = insertMenuGroups(
      [
        cmd("provider", "embeds"),
        cmd("sql", "datasette"),
        cmd("image", "media"),
      ],
      null,
    );
    expect(groups.map((g) => g.key)).toEqual(["media", "datasette", "embeds"]);
    const labelFor = (k: SlashGroupKey) => SLASH_GROUPS.find((g) => g.key === k)!.label;
    expect(groups.map((g) => g.label)).toEqual([
      labelFor("media"),
      labelFor("datasette"),
      labelFor("embeds"),
    ]);
  });

  it("preserves registration order within a group", () => {
    const groups = insertMenuGroups(
      [cmd("first", "media"), cmd("second", "media"), cmd("third", "media")],
      null,
    );
    expect(groups[0].rows.map((r) => r.command.id)).toEqual(["first", "second", "third"]);
  });

  it("maps enabled:()=>false to a disabled row (others stay enabled)", () => {
    const groups = insertMenuGroups(
      [
        cmd("table", "media", { enabled: () => false }),
        cmd("image", "media", { enabled: () => true }),
        cmd("toc", "media"), // no predicate → enabled
      ],
      STATE,
    );
    const rows = groups[0].rows;
    expect(rows.find((r) => r.command.id === "table")!.disabled).toBe(true);
    expect(rows.find((r) => r.command.id === "image")!.disabled).toBe(false);
    expect(rows.find((r) => r.command.id === "toc")!.disabled).toBe(false);
  });

  it("treats every row as enabled when state is null", () => {
    const groups = insertMenuGroups([cmd("table", "media", { enabled: () => false })], null);
    expect(groups[0].rows[0].disabled).toBe(false);
  });

  it("passes provider (embeds) commands through", () => {
    const groups = insertMenuGroups(
      [cmd("embed_source:places", "embeds"), cmd("image", "media")],
      null,
    );
    const embeds = groups.find((g) => g.key === "embeds");
    expect(embeds).toBeDefined();
    expect(embeds!.rows.map((r) => r.command.id)).toEqual(["embed_source:places"]);
  });

  it("omits a group with no matching commands", () => {
    const groups = insertMenuGroups([cmd("image", "media")], null);
    expect(groups.map((g) => g.key)).toEqual(["media"]);
  });
});
