/**
 * Notion-style `/` slash command menu — state + decoration + popup + keymap.
 *
 * Mirrors the `mentionSuggest.ts` suggest skeleton (one PluginKey, a
 * `state.apply` that handles `setMeta` then recomputes from doc+selection, a
 * `decorations` prop, and a `Plugin.view` popup) with three differences:
 *   - Trigger is `/` gated to an EMPTY textblock at doc depth 1 (a `/`
 *     mid-sentence never fires) — the block must contain only the `/query`.
 *   - Results are a STATIC, filtered command registry (no fetch).
 *   - Commit clears the `/query` text first, then runs an arbitrary command.
 *
 * The popup is vanilla DOM (PM transactions don't drive Svelte rerenders);
 * state changes go through `setMeta` only. Commands that open Svelte dialogs
 * (image, Datasette embed) are injected as callbacks so this module stays
 * decoupled from the page wrapper.
 */
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
} from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { setBlockType, wrapIn } from "prosemirror-commands";
import { wrapInList } from "prosemirror-schema-list";
import { schema } from "./schema";
import { TOOLBAR_ICONS } from "./icons";
import { insertTable } from "./tables";
import { insertSqlBlock } from "./sqlQuery";
import { embedInsertSources, type EmbedInsertSource } from "./embedProviders";

/**
 * Section taxonomy for the `/` menu. Display order = array order; the chosen
 * grouping (Option A) renders one non-interactive header per non-empty group,
 * top-to-bottom in this order. Every `SlashCommand` carries a `group` key into
 * this list. Provider sources (3rd-party embeds) all land in `embeds`; if a
 * future provider wants its own section, extend `ProviderManifestSource`
 * (embedProviders.ts) with an optional group field — out of scope here.
 */
export const SLASH_GROUPS = [
  { key: "styling", label: "Styling" },
  { key: "media", label: "Media" },
  { key: "datasette", label: "Datasette" },
  { key: "embeds", label: "Embeds" },
] as const;

export type SlashGroupKey = (typeof SLASH_GROUPS)[number]["key"];

/** Render/sort order of groups, keyed by `SlashGroupKey`. */
export const GROUP_ORDER: SlashGroupKey[] = SLASH_GROUPS.map((g) => g.key);

const GROUP_LABELS: Record<SlashGroupKey, string> = Object.fromEntries(
  SLASH_GROUPS.map((g) => [g.key, g.label]),
) as Record<SlashGroupKey, string>;

export interface SlashCommand {
  id: string;
  label: string;
  keywords: string[];
  icon: string; // a TOOLBAR_ICONS key
  group: SlashGroupKey;
  run: (view: EditorView) => void;
  enabled?: (state: EditorState) => boolean;
}

export interface SlashState {
  active: boolean;
  query: string;
  from: number; // doc pos of the `/`
  index: number;
  dismissedFrom?: number;
}

type SlashMeta = { type: "move"; d: 1 | -1 } | { type: "cancel" } | { type: "commit" };

const INACTIVE: SlashState = { active: false, query: "", from: -1, index: 0 };

export const slashKey = new PluginKey<SlashState>("slashMenu");

// `/` at the very start of the block, followed by a word-char query, anchored
// to the text-before-cursor. The empty-block guard lives in recompute().
const TRIGGER = /^\/(\w*)$/;

function clampIndex(index: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(index, len - 1));
}

function groupRank(group: SlashGroupKey): number {
  const i = GROUP_ORDER.indexOf(group);
  return i === -1 ? GROUP_ORDER.length : i;
}

/**
 * The visible, context-enabled, query-filtered command list.
 *
 * Always group-ordered (primary key = `GROUP_ORDER` position) so the render
 * step can emit a header at each group boundary — including while searching
 * ("keep grouped", ticket 06). Within a group: natural (registration) order
 * for an empty query, prefix-first for a non-empty query. Returns a **flat**
 * array; headers are derived at render time from `group` transitions, so the
 * keyboard `index` / `clampIndex` / commit all stay flat and untouched.
 */
export function filterSlashCommands(
  commands: SlashCommand[],
  state: EditorState,
  query: string,
): SlashCommand[] {
  const q = query.toLowerCase();
  const enabled = commands.filter((c) => (c.enabled ? c.enabled(state) : true));
  const matched = q
    ? enabled.filter(
        (c) =>
          c.label.toLowerCase().includes(q) ||
          c.keywords.some((k) => k.toLowerCase().includes(q)),
      )
    : enabled;
  // Stable sort: primary = group order; secondary (query only) = prefix-first.
  // `Array.prototype.sort` is stable, so ties preserve registration order.
  const withIndex = matched.map((c, i) => ({ c, i }));
  withIndex.sort((a, b) => {
    const byGroup = groupRank(a.c.group) - groupRank(b.c.group);
    if (byGroup !== 0) return byGroup;
    if (q) {
      const byPrefix =
        Number(b.c.label.toLowerCase().startsWith(q)) -
        Number(a.c.label.toLowerCase().startsWith(q));
      if (byPrefix !== 0) return byPrefix;
    }
    return a.i - b.i;
  });
  return withIndex.map((x) => x.c);
}

function recompute(prev: SlashState, newState: EditorState): SlashState {
  const sel = newState.selection;
  if (!(sel instanceof TextSelection) || !sel.empty || !sel.$cursor) {
    return { ...INACTIVE, dismissedFrom: prev.dismissedFrom };
  }
  const $cursor = sel.$cursor;
  // Gate to an empty top-level paragraph (mirrors canInsertTable's guard).
  if ($cursor.depth !== 1 || $cursor.parent.type !== schema.nodes.paragraph) {
    return INACTIVE;
  }
  // Nothing may follow the cursor in the block — the block is just `/query`.
  if ($cursor.parent.content.size !== $cursor.parentOffset) return INACTIVE;

  const textBefore = $cursor.parent.textBetween(0, $cursor.parentOffset, undefined, "￼");
  const m = TRIGGER.exec(textBefore);
  if (!m) return INACTIVE;

  const from = sel.from - m[0].length; // doc pos of the `/`
  if (prev.dismissedFrom !== undefined && prev.dismissedFrom === from) {
    return { ...INACTIVE, dismissedFrom: prev.dismissedFrom };
  }
  const query = m[1];
  const sameQuery = prev.active && prev.from === from && prev.query === query;
  return {
    active: true,
    query,
    from,
    index: sameQuery ? prev.index : 0,
  };
}

/** State-machine plugin. Factory so it can clamp `move` against the filtered
 * command count for the current state + query. */
export function createSlashSuggestPlugin(commands: SlashCommand[]): Plugin<SlashState> {
  return new Plugin<SlashState>({
    key: slashKey,
    state: {
      init() {
        return { ...INACTIVE };
      },
      apply(tr, prev, _oldState, newState) {
        const meta = tr.getMeta(slashKey) as SlashMeta | undefined;
        if (meta) {
          switch (meta.type) {
            case "move": {
              const len = filterSlashCommands(commands, newState, prev.query).length;
              return { ...prev, index: clampIndex(prev.index + meta.d, len) };
            }
            case "cancel":
              return { ...INACTIVE, dismissedFrom: prev.from };
            case "commit":
              return { ...INACTIVE };
          }
        }
        return recompute(prev, newState);
      },
    },
    props: {
      decorations(state) {
        const ss = slashKey.getState(state);
        if (!ss || !ss.active) return DecorationSet.empty;
        return DecorationSet.create(state.doc, [
          Decoration.inline(ss.from, state.selection.from, {
            class: "pm-slash-typing",
          }),
        ]);
      },
    },
  });
}

/** Clear the `/query` text, then run the command on the cleaned block. */
function runSlashCommand(view: EditorView, ss: SlashState, command: SlashCommand): void {
  view.dispatch(
    view.state.tr
      .delete(ss.from, view.state.selection.from)
      .setMeta(slashKey, { type: "commit" }),
  );
  command.run(view);
  view.focus();
}

export function moveSlashSelection(d: 1 | -1): Command {
  return (state, dispatch) => {
    const ss = slashKey.getState(state);
    if (!ss || !ss.active) return false;
    if (dispatch) dispatch(state.tr.setMeta(slashKey, { type: "move", d }));
    return true;
  };
}

export function cancelSlashMenu(): Command {
  return (state, dispatch) => {
    const ss = slashKey.getState(state);
    if (!ss || !ss.active) return false;
    if (dispatch) dispatch(state.tr.setMeta(slashKey, { type: "cancel" }));
    return true;
  };
}

export function commitSlashSelection(commands: SlashCommand[]): Command {
  return (state, dispatch, view) => {
    const ss = slashKey.getState(state);
    if (!ss || !ss.active) return false;
    const filtered = filterSlashCommands(commands, state, ss.query);
    const cmd = filtered[clampIndex(ss.index, filtered.length)];
    if (!cmd) return false;
    if (dispatch && view) runSlashCommand(view, ss, cmd);
    return true;
  };
}

/**
 * Keymap consumed while the `/` popup is open. Each command returns false when
 * inactive so normal keystrokes fall through. MUST be registered before
 * `baseKeymap`.
 */
export function slashKeymap(commands: SlashCommand[]): Record<string, Command> {
  return {
    ArrowDown: moveSlashSelection(1),
    ArrowUp: moveSlashSelection(-1),
    Enter: commitSlashSelection(commands),
    Tab: commitSlashSelection(commands),
    Escape: cancelSlashMenu(),
  };
}

/** The popup (`Plugin.view`) rendering the static command list. */
class SlashPopupView {
  private host: HTMLElement | null;
  private root: HTMLDivElement | null;

  constructor(
    private view: EditorView,
    private commands: SlashCommand[],
  ) {
    const host = view.dom.parentElement;
    if (!host) {
      this.host = null;
      this.root = null;
      return;
    }
    this.host = host;
    this.root = document.createElement("div");
    this.root.className = "pm-slash-menu";
    this.root.style.display = "none";
    host.appendChild(this.root);
    this.update(view);
  }

  update(view: EditorView): void {
    this.view = view;
    const root = this.root;
    const host = this.host;
    if (!root || !host) return;
    const ss = slashKey.getState(view.state);
    if (!ss || !ss.active) {
      root.style.display = "none";
      return;
    }
    this.position(view, ss.from);
    root.style.display = "block";
    this.renderResults(ss);
  }

  private position(view: EditorView, from: number): void {
    const root = this.root;
    const host = this.host;
    if (!root || !host) return;
    let coords: { left: number; bottom: number };
    try {
      coords = view.coordsAtPos(from);
    } catch {
      return; // jsdom: getClientRects unimplemented — skip positioning
    }
    const hostRect = host.getBoundingClientRect();
    const top = coords.bottom - hostRect.top + 2;
    let left = coords.left - hostRect.left;
    const maxLeft = Math.max(0, host.clientWidth - root.offsetWidth);
    if (left > maxLeft) left = maxLeft;
    if (left < 0) left = 0;
    root.style.top = `${top}px`;
    root.style.left = `${left}px`;
  }

  private renderResults(ss: SlashState): void {
    const root = this.root;
    if (!root) return;
    root.textContent = "";
    const filtered = filterSlashCommands(this.commands, this.view.state, ss.query);
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pm-slash-empty";
      empty.textContent = "No commands";
      root.appendChild(empty);
      return;
    }
    const active = clampIndex(ss.index, filtered.length);
    let lastGroup: SlashGroupKey | null = null;
    const activeRef: { el: HTMLElement | null } = { el: null };
    filtered.forEach((command, i) => {
      // Group boundary → a non-interactive header before the first item of the
      // group. Headers are derived from `group` transitions in the flat,
      // group-ordered filtered array; they are NOT counted in `index`.
      if (command.group !== lastGroup) {
        lastGroup = command.group;
        const header = document.createElement("div");
        header.className = "pm-slash-header";
        header.setAttribute("aria-hidden", "true");
        header.textContent = GROUP_LABELS[command.group] ?? command.group;
        root.appendChild(header);
      }
      const item = document.createElement("div");
      item.className = "pm-slash-item";
      if (i === active) {
        item.classList.add("pm-slash-item--active");
        activeRef.el = item;
      }
      const icon = document.createElement("span");
      icon.className = "pm-slash-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${TOOLBAR_ICONS[command.icon as keyof typeof TOOLBAR_ICONS] ?? ""}</svg>`;
      item.appendChild(icon);
      item.appendChild(document.createTextNode(command.label));
      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep editor focus for the commit transaction
        const ssNow = slashKey.getState(this.view.state);
        if (ssNow && ssNow.active) runSlashCommand(this.view, ssNow, command);
      });
      root.appendChild(item);
    });
    // Keep the highlighted *item* in view (never a header). jsdom doesn't
    // implement scrollIntoView, so guard the call.
    const activeItem = activeRef.el;
    if (activeItem && typeof activeItem.scrollIntoView === "function") {
      activeItem.scrollIntoView({ block: "nearest" });
    }
  }

  destroy(): void {
    this.root?.remove();
    this.root = null;
  }
}

export function slashMenuPopupPlugin(commands: SlashCommand[]): Plugin {
  return new Plugin({
    view(view) {
      return new SlashPopupView(view, commands);
    },
  });
}

export interface SlashCommandCallbacks {
  /** Open the image insert dialog (PaperApp-owned Svelte component). */
  openImageDialog?: () => void;
  /**
   * Open the embed picker dialog (PaperApp-owned). `sourceId` selects a
   * third-party provider source; omitted/undefined = the core Datasette source.
   */
  openDatasetteEmbed?: (sourceId?: string) => void;
}

/**
 * Map one shared `EmbedInsertSource` (embedProviders.ts) to its `/`-menu
 * command. The native Datasette source (id undefined) keeps its historical id
 * `block_embed` / keywords / `datasette` group; provider sources get an
 * `embed_source:<id>` id, the `embeds` group, and the `icon in TOOLBAR_ICONS`
 * fallback. The source *set* (native + providers, in order) is owned by
 * `embedInsertSources()`; only these slash-menu-specific fields live here.
 */
function embedSlashCommand(
  source: EmbedInsertSource,
  cb: SlashCommandCallbacks,
): SlashCommand {
  if (source.id === undefined) {
    return {
      id: "block_embed",
      label: source.label,
      keywords: ["datasette", "table", "data", "embed", "database", "query"],
      icon: source.icon && source.icon in TOOLBAR_ICONS ? source.icon : "database",
      group: "datasette",
      run: () => cb.openDatasetteEmbed?.(),
    };
  }
  const id = source.id;
  return {
    id: `embed_source:${id}`,
    label: source.label,
    keywords: ["embed", "insert", id, source.label.toLowerCase()],
    icon: source.icon && source.icon in TOOLBAR_ICONS ? source.icon : "database",
    group: "embeds",
    run: () => cb.openDatasetteEmbed?.(id),
  };
}

/**
 * One slash command per third-party provider source, read from the **manifest**
 * (page_data) — not the live registry — so a provider appears in the `/` menu
 * without its bundle being loaded. Picking a source opens the dialog, which
 * lazy-injects that provider's bundle before searching (see embedProviders.ts /
 * DatasetteEmbedDialog). Drops the native first entry of `embedInsertSources()`
 * — the registry's hardcoded `block_embed` covers that.
 */
export function providerSlashCommands(cb: SlashCommandCallbacks): SlashCommand[] {
  return embedInsertSources()
    .filter((source) => source.id !== undefined)
    .map((source) => embedSlashCommand(source, cb));
}

function runCommand(cmd: Command): (view: EditorView) => void {
  return (view) => cmd(view.state, view.dispatch, view);
}

/** Build the default command registry. Dialog-backed commands use callbacks. */
export function buildSlashCommands(cb: SlashCommandCallbacks = {}): SlashCommand[] {
  const { heading, code_block, blockquote, bullet_list, ordered_list, task_list, horizontal_rule } =
    schema.nodes;
  const commands: SlashCommand[] = [
    {
      id: "h1",
      label: "Heading 1",
      keywords: ["title", "h1", "heading"],
      icon: "h1",
      group: "styling",
      run: runCommand(setBlockType(heading, { level: 1 })),
    },
    {
      id: "h2",
      label: "Heading 2",
      keywords: ["h2", "heading", "subtitle"],
      icon: "h2",
      group: "styling",
      run: runCommand(setBlockType(heading, { level: 2 })),
    },
    {
      id: "h3",
      label: "Heading 3",
      keywords: ["h3", "heading"],
      icon: "h3",
      group: "styling",
      run: runCommand(setBlockType(heading, { level: 3 })),
    },
    {
      id: "bullet_list",
      label: "Bullet list",
      keywords: ["ul", "unordered", "list", "bullet"],
      icon: "listUl",
      group: "styling",
      run: runCommand(wrapInList(bullet_list)),
    },
    {
      id: "ordered_list",
      label: "Numbered list",
      keywords: ["ol", "ordered", "numbered", "list"],
      icon: "listOl",
      group: "styling",
      run: runCommand(wrapInList(ordered_list)),
    },
    {
      id: "task_list",
      label: "Task list",
      keywords: ["todo", "checklist", "task", "checkbox"],
      icon: "taskList",
      group: "styling",
      run: runCommand(wrapInList(task_list)),
    },
    {
      id: "blockquote",
      label: "Quote",
      keywords: ["blockquote", "quote", "citation"],
      icon: "quote",
      group: "styling",
      run: runCommand(wrapIn(blockquote)),
    },
    {
      id: "code_block",
      label: "Code block",
      keywords: ["code", "pre", "monospace"],
      icon: "codeBlock",
      group: "styling",
      run: runCommand(setBlockType(code_block)),
    },
    {
      id: "sql_block",
      label: "SQL query",
      keywords: ["sql", "query", "database", "datasette", "data"],
      icon: "database",
      group: "datasette",
      // Inserts an empty block; the NodeView defaults the database and the
      // header <select> lets the user change it.
      run: runCommand(insertSqlBlock()),
    },
    {
      id: "table",
      label: "Table",
      keywords: ["grid", "table", "spreadsheet", "data"],
      icon: "table",
      group: "media",
      // The slash menu only fires in an empty top-level paragraph, so a table
      // is always insertable here — no canInsertTable gate needed.
      run: runCommand(insertTable(3, 3)),
    },
    {
      id: "divider",
      label: "Divider",
      keywords: ["hr", "rule", "separator", "divider", "line"],
      icon: "hr",
      group: "styling",
      run: (view) => {
        view.dispatch(
          view.state.tr.replaceSelectionWith(horizontal_rule.create()).scrollIntoView(),
        );
      },
    },
    {
      id: "image",
      label: "Image",
      keywords: ["img", "picture", "photo", "image"],
      icon: "image",
      group: "media",
      run: () => cb.openImageDialog?.(),
    },
    // Native Datasette + every provider source — same shared list the toolbar
    // dropdown uses (embedInsertSources). The native entry is always first.
    ...embedInsertSources().map((source) => embedSlashCommand(source, cb)),
  ];
  return commands;
}
