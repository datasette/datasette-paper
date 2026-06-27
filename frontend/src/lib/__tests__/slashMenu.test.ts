/**
 * Tests for the `/` slash command menu: trigger gating, query filtering,
 * commit (clear /query then run command), and enabled() gating.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import {
  slashKey,
  createSlashSuggestPlugin,
  filterSlashCommands,
  commitSlashSelection,
  buildSlashCommands,
  providerSlashCommands,
  slashMenuPopupPlugin,
  slashKeymap,
  SLASH_GROUPS,
  GROUP_ORDER,
  type SlashCommand,
  type SlashGroupKey,
} from "../slashMenu";
import { setProviderManifest, _resetProvidersForTest } from "../embedProviders";

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

  it("includes a SQL query command that inserts a sql_block", () => {
    const sql = commands.find((c) => c.id === "sql_block");
    expect(sql).toBeDefined();
    const state = stateWith([schema.node("paragraph")], 1, "/sql");
    expect(filterSlashCommands(commands, state, "sql").some((c) => c.id === "sql_block")).toBe(
      true,
    );
  });

  it("excludes commands whose enabled() is false", () => {
    const custom: SlashCommand[] = [
      { id: "on", label: "On", keywords: [], icon: "table", group: "media", run: () => {} },
      {
        id: "off",
        label: "Off",
        keywords: [],
        icon: "table",
        group: "media",
        run: () => {},
        enabled: () => false,
      },
    ];
    const state = stateWith([schema.node("paragraph")], 1, "/", custom);
    expect(filterSlashCommands(custom, state, "").map((c) => c.id)).toEqual(["on"]);
  });
});

describe("section taxonomy (group tags)", () => {
  it("tags every built-in command with a known group", () => {
    const known = new Set<SlashGroupKey>(GROUP_ORDER);
    for (const c of buildSlashCommands()) {
      expect(known.has(c.group)).toBe(true);
    }
  });

  it("places commands in the expected groups", () => {
    const byId = new Map(buildSlashCommands().map((c) => [c.id, c.group]));
    expect(byId.get("h1")).toBe("styling");
    expect(byId.get("divider")).toBe("styling");
    expect(byId.get("table")).toBe("media");
    expect(byId.get("image")).toBe("media");
    expect(byId.get("sql_block")).toBe("datasette");
    expect(byId.get("block_embed")).toBe("datasette");
  });

  it("tags provider sources with the embeds group", () => {
    setProviderManifest([
      { kind: "place-list", sources: [{ id: "places", label: "Places map" }] },
    ]);
    expect(providerSlashCommands({})[0].group).toBe("embeds");
    _resetProvidersForTest();
  });

  it("exports SLASH_GROUPS labels in GROUP_ORDER", () => {
    expect(SLASH_GROUPS.map((g) => g.key)).toEqual(GROUP_ORDER);
    expect(SLASH_GROUPS.find((g) => g.key === "embeds")?.label).toBe("Embeds");
  });
});

describe("filterSlashCommands group ordering (Option A)", () => {
  it("orders the empty-query list by GROUP_ORDER, natural within group", () => {
    const state = stateWith([schema.node("paragraph")], 1, "/");
    const groups = filterSlashCommands(commands, state, "").map((c) => c.group);
    // De-dupe consecutive groups → the section sequence. Must be contiguous
    // (each group appears once) and in GROUP_ORDER.
    const seen: SlashGroupKey[] = [];
    for (const g of groups) if (seen[seen.length - 1] !== g) seen.push(g);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(
      seen.slice().sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b)),
    );
    // Within styling: registration order preserved (h1 < h2 < divider).
    const ids = filterSlashCommands(commands, state, "").map((c) => c.id);
    expect(ids.indexOf("h1")).toBeLessThan(ids.indexOf("h2"));
    expect(ids.indexOf("h2")).toBeLessThan(ids.indexOf("divider"));
  });

  it("stays group-ordered while searching (headers survive a query)", () => {
    setProviderManifest([
      { kind: "place-list", sources: [{ id: "places", label: "Places map" }] },
    ]);
    const cmds = buildSlashCommands();
    const state = stateWith([schema.node("paragraph")], 1, "/data", cmds);
    const ranks = filterSlashCommands(cmds, state, "data").map((c) =>
      GROUP_ORDER.indexOf(c.group),
    );
    expect(ranks.length).toBeGreaterThan(1);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
    }
    _resetProvidersForTest();
  });

  it("still returns a flat array (length === item count, no headers in data)", () => {
    const state = stateWith([schema.node("paragraph")], 1, "/");
    const filtered = filterSlashCommands(commands, state, "");
    expect(Array.isArray(filtered)).toBe(true);
    expect(filtered).toHaveLength(commands.length);
    // Every element is a real command (headers are render-only, not in data).
    expect(filtered.every((c) => typeof c.run === "function")).toBe(true);
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
    _resetProvidersForTest();
  });

  it("builds one command per manifest source (no bundle needed)", () => {
    setProviderManifest([
      {
        kind: "place-list",
        sources: [{ id: "places", label: "Places map", icon: "globe" }],
      },
      // A provider that contributes no source adds no command.
      { kind: "no-source" },
    ]);

    const open = vi.fn();
    const cmds = providerSlashCommands({ openDatasetteEmbed: open });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ id: "embed_source:places", label: "Places map" });

    cmds[0].run({} as unknown as EditorView);
    expect(open).toHaveBeenCalledWith("places");
  });

  it("falls back to the database icon for an unknown icon name", () => {
    setProviderManifest([
      {
        kind: "place-list",
        sources: [{ id: "places", label: "Places", icon: "not-a-real-icon" }],
      },
    ]);
    expect(providerSlashCommands({})[0].icon).toBe("database");
  });

  it("is included in buildSlashCommands output", () => {
    setProviderManifest([
      { kind: "place-list", sources: [{ id: "places", label: "Places map" }] },
    ]);
    const ids = buildSlashCommands().map((c) => c.id);
    expect(ids).toContain("embed_source:places");
  });
});

describe("popup renders non-interactive section headers (real EditorView)", () => {
  let view: EditorView;
  let host: HTMLDivElement;

  beforeEach(() => {
    setProviderManifest([
      { kind: "place-list", sources: [{ id: "places", label: "Places map" }] },
    ]);
    const cmds = buildSlashCommands();
    host = document.createElement("div");
    host.className = "editor-host";
    document.body.appendChild(host);
    const place = document.createElement("div");
    host.appendChild(place);
    const state = EditorState.create({
      schema,
      plugins: [
        createSlashSuggestPlugin(cmds),
        slashMenuPopupPlugin(cmds),
        keymap(slashKeymap(cmds)),
      ],
    });
    view = new EditorView(place, { state });
  });

  afterEach(() => {
    view.destroy();
    host.remove();
    _resetProvidersForTest();
  });

  function menu(): HTMLElement {
    return host.querySelector(".pm-slash-menu") as HTMLElement;
  }

  it("renders one header per non-empty group, in GROUP_ORDER", () => {
    view.dispatch(view.state.tr.insertText("/"));
    const labels = [...menu().querySelectorAll(".pm-slash-header")].map(
      (h) => h.textContent,
    );
    // All four groups have at least one command (provider registered → Embeds).
    expect(labels).toEqual(["Styling", "Media", "Datasette", "Embeds"]);
  });

  it("header count + item count account for every rendered child", () => {
    view.dispatch(view.state.tr.insertText("/"));
    const root = menu();
    const headers = root.querySelectorAll(".pm-slash-header").length;
    const items = root.querySelectorAll(".pm-slash-item").length;
    expect(headers + items).toBe(root.children.length);
    const cmds = buildSlashCommands();
    expect(items).toBe(filterSlashCommands(cmds, view.state, "").length);
  });

  it("keeps the active highlight on an item, never a header", () => {
    view.dispatch(view.state.tr.insertText("/"));
    const root = menu();
    // The single active element is a .pm-slash-item (the first command).
    const actives = root.querySelectorAll(".pm-slash-item--active");
    expect(actives).toHaveLength(1);
    expect(actives[0].classList.contains("pm-slash-header")).toBe(false);
    expect(root.querySelector(".pm-slash-header.pm-slash-item--active")).toBeNull();
  });

  it("a mousedown on a header does nothing (only items are interactive)", () => {
    view.dispatch(view.state.tr.insertText("/"));
    const header = menu().querySelector(".pm-slash-header") as HTMLElement;
    const before = view.state.doc.toString();
    header.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view.state.doc.toString()).toBe(before);
  });

  it("hides the Embeds header when no provider is registered", () => {
    _resetProvidersForTest();
    view.destroy();
    const cmds = buildSlashCommands();
    const place = host.querySelector("div") as HTMLElement;
    const state = EditorState.create({
      schema,
      plugins: [createSlashSuggestPlugin(cmds), slashMenuPopupPlugin(cmds)],
    });
    view = new EditorView(place, { state });
    view.dispatch(view.state.tr.insertText("/"));
    const labels = [...menu().querySelectorAll(".pm-slash-header")].map(
      (h) => h.textContent,
    );
    expect(labels).toEqual(["Styling", "Media", "Datasette"]);
  });
});
