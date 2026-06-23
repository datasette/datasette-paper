/**
 * Tests for the `/` slash command menu: trigger gating, query filtering,
 * commit (clear /query then run command), and enabled() gating.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import {
  slashKey,
  createSlashSuggestPlugin,
  filterSlashCommands,
  commitSlashSelection,
  buildSlashCommands,
  providerSlashCommands,
  type SlashCommand,
} from "../slashMenu";
import { embedRegistry } from "../embedRegistry";

const commands = buildSlashCommands();

function stateWith(
  blocks: import("prosemirror-model").Node[],
  selPos: number,
  typed: string,
  cmds: SlashCommand[] = commands,
): EditorState {
  const doc = schema.node("doc", null, blocks);
  let state = EditorState.create({
    doc,
    plugins: [createSlashSuggestPlugin(cmds)],
  });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, selPos)));
  if (typed) state = state.apply(state.tr.insertText(typed, selPos));
  return state;
}

describe("slash trigger gating", () => {
  it("fires in an empty top-level paragraph", () => {
    const state = stateWith([schema.node("paragraph")], 1, "/");
    const ss = slashKey.getState(state)!;
    expect(ss.active).toBe(true);
    expect(ss.query).toBe("");
  });

  it("tracks the query after the slash", () => {
    const state = stateWith([schema.node("paragraph")], 1, "/head");
    expect(slashKey.getState(state)!.query).toBe("head");
  });

  it("does not fire mid-sentence", () => {
    const state = stateWith(
      [schema.node("paragraph", null, [schema.text("hello")])],
      6,
      "/",
    );
    expect(slashKey.getState(state)!.active).toBe(false);
  });

  it("does not fire in a nested block (list item)", () => {
    const state = stateWith(
      [
        schema.node("bullet_list", null, [
          schema.node("list_item", null, [schema.node("paragraph")]),
        ]),
      ],
      3,
      "/",
    );
    expect(slashKey.getState(state)!.active).toBe(false);
  });

  it("closes when a space breaks the query", () => {
    const state = stateWith([schema.node("paragraph")], 1, "/h ");
    expect(slashKey.getState(state)!.active).toBe(false);
  });
});

describe("filterSlashCommands", () => {
  it("returns all commands for an empty query", () => {
    const state = stateWith([schema.node("paragraph")], 1, "/");
    expect(filterSlashCommands(commands, state, "")).toHaveLength(commands.length);
  });

  it("filters by label/keyword and orders prefix matches first", () => {
    const state = stateWith([schema.node("paragraph")], 1, "/head");
    const filtered = filterSlashCommands(commands, state, "head");
    expect(filtered.map((c) => c.id)).toEqual(["h1", "h2", "h3"]);
  });

  it("matches keywords (todo → task list)", () => {
    const state = stateWith([schema.node("paragraph")], 1, "/todo");
    const filtered = filterSlashCommands(commands, state, "todo");
    expect(filtered.some((c) => c.id === "task_list")).toBe(true);
  });

  it("excludes commands whose enabled() is false", () => {
    const custom: SlashCommand[] = [
      { id: "on", label: "On", keywords: [], icon: "table", run: () => {} },
      {
        id: "off",
        label: "Off",
        keywords: [],
        icon: "table",
        run: () => {},
        enabled: () => false,
      },
    ];
    const state = stateWith([schema.node("paragraph")], 1, "/", custom);
    expect(filterSlashCommands(custom, state, "").map((c) => c.id)).toEqual(["on"]);
  });
});

function fakeView(state: EditorState): {
  view: EditorView;
  get: () => EditorState;
} {
  let current = state;
  const view = {
    get state() {
      return current;
    },
    dispatch(tr: import("prosemirror-state").Transaction) {
      current = current.apply(tr);
    },
    focus() {},
  } as unknown as EditorView;
  return { view, get: () => current };
}

describe("commitSlashSelection", () => {
  it("clears the /query text and runs the highlighted command (Heading 1)", () => {
    const { view, get } = fakeView(stateWith([schema.node("paragraph")], 1, "/head"));
    const ok = commitSlashSelection(commands)(view.state, view.dispatch, view);
    expect(ok).toBe(true);
    const block = get().doc.firstChild!;
    expect(block.type.name).toBe("heading");
    expect(block.attrs.level).toBe(1);
    // The "/head" text was removed before the command ran.
    expect(block.textContent).toBe("");
  });

  it("runs a dialog-backed command via its callback", () => {
    const openDatasetteEmbed = vi.fn();
    const cmds = buildSlashCommands({ openDatasetteEmbed });
    const { view } = fakeView(stateWith([schema.node("paragraph")], 1, "/datasette", cmds));
    commitSlashSelection(cmds)(view.state, view.dispatch, view);
    expect(openDatasetteEmbed).toHaveBeenCalledTimes(1);
  });

  it("inserts a table from the table command", () => {
    const { view, get } = fakeView(stateWith([schema.node("paragraph")], 1, "/table"));
    commitSlashSelection(commands)(view.state, view.dispatch, view);
    let hasTable = false;
    get().doc.descendants((n) => {
      if (n.type.name === "table") hasTable = true;
    });
    expect(hasTable).toBe(true);
  });

  it("falls through when the menu is inactive", () => {
    const { view } = fakeView(
      stateWith([schema.node("paragraph", null, [schema.text("x")])], 2, ""),
    );
    expect(commitSlashSelection(commands)(view.state, view.dispatch, view)).toBe(false);
  });
});

describe("providerSlashCommands (third-party sources)", () => {
  afterEach(() => {
    delete window.datasettePaperEmbeds;
  });

  it("builds one command per provider that implements picker()", () => {
    embedRegistry().register({
      kind: "place-list",
      picker: () => ({ id: "places", label: "Places map", icon: "globe" }),
      mount: () => {},
    });
    // A provider with no picker() contributes no command.
    embedRegistry().register({ kind: "no-picker", mount: () => {} });

    const open = vi.fn();
    const cmds = providerSlashCommands({ openDatasetteEmbed: open });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ id: "embed_source:places", label: "Places map" });

    cmds[0].run({} as unknown as EditorView);
    expect(open).toHaveBeenCalledWith("places");
  });

  it("falls back to the database icon for an unknown icon name", () => {
    embedRegistry().register({
      kind: "place-list",
      picker: () => ({ id: "places", label: "Places", icon: "not-a-real-icon" }),
      mount: () => {},
    });
    expect(providerSlashCommands({})[0].icon).toBe("database");
  });

  it("is included in buildSlashCommands output", () => {
    embedRegistry().register({
      kind: "place-list",
      picker: () => ({ id: "places", label: "Places map" }),
      mount: () => {},
    });
    const ids = buildSlashCommands().map((c) => c.id);
    expect(ids).toContain("embed_source:places");
  });
});
