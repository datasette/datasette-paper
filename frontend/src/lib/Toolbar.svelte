<script lang="ts">
  import type { EditorView } from "prosemirror-view";
  import type { MarkType, NodeType } from "prosemirror-model";
  import { toggleMark, setBlockType, wrapIn } from "prosemirror-commands";
  import { wrapInList, liftListItem, sinkListItem } from "prosemirror-schema-list";
  import { undo, redo, undoDepth, redoDepth } from "prosemirror-history";
  import { schema } from "./schema";
  import { TOOLBAR_ICONS, type ToolbarIconName } from "./icons";
  import { canInsertTable, insertTable } from "./tables";
  // The in-table action bar (add/delete row/col, name input) is owned
  // by tableInsertTooltipPlugin (see tableInsertTooltip.ts). Only the
  // initial Insert-table button lives in the toolbar.

  let {
    view,
    kind = "doc",
    onInsertImage,
  }: {
    view: EditorView | null;
    kind?: "doc" | "template";
    // Opens the (PaperApp-owned) image insert dialog. Shared with the `/`
    // slash menu so there is only ever one ImageDialog instance.
    onInsertImage?: () => void;
  } = $props();

  // Lazy-loaded list of built-in placeholder keys with sample values.
  // Fetched once on demand (when the dropdown opens for the first
  // time on a template) and cached for the session.
  type ParamInfo = { key: string; sample: string };
  let placeholderParams = $state<ParamInfo[] | null>(null);
  let placeholderLoading = $state(false);
  let placeholderOpen = $state(false);
  let placeholderRoot: HTMLDivElement | undefined = $state();

  async function loadPlaceholderParams() {
    if (placeholderParams !== null || placeholderLoading) return;
    placeholderLoading = true;
    try {
      const resp = await fetch("/-/paper/api/template_params");
      if (resp.ok) {
        const body = (await resp.json()) as { builtins: ParamInfo[] };
        placeholderParams = body.builtins;
      }
    } finally {
      placeholderLoading = false;
    }
  }

  function insertPlaceholder(key: string) {
    if (!view) return;
    placeholderOpen = false;
    const node = schema.nodes.placeholder.create({ key });
    const tr = view.state.tr.replaceSelectionWith(node).scrollIntoView();
    view.dispatch(tr);
    view.focus();
  }

  // Close the placeholder dropdown on outside-click / Escape, mirroring
  // the same pattern DocHeader uses for its overflow menu.
  $effect(() => {
    if (!placeholderOpen) return;
    const onClick = (evt: MouseEvent) => {
      if (!placeholderRoot) return;
      if (!placeholderRoot.contains(evt.target as Node)) placeholderOpen = false;
    };
    const onKey = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") placeholderOpen = false;
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  });

  // ─── helpers ──────────────────────────────────────────────────────────────

  function markActive(type: MarkType): boolean {
    if (!view) return false;
    const sel = view.state.selection;
    if (sel.empty) {
      return !!type.isInSet(view.state.storedMarks || sel.$from.marks());
    }
    return view.state.doc.rangeHasMark(sel.from, sel.to, type);
  }

  function nodeActive(type: NodeType, attrs: Record<string, unknown> = {}): boolean {
    if (!view) return false;
    const sel = view.state.selection;
    const node = sel.$from.node(sel.$from.depth);
    if (node.type !== type) return false;
    return Object.entries(attrs).every(([k, v]) => node.attrs[k] === v);
  }

  function run(cmd: (state: EditorView["state"], dispatch?: EditorView["dispatch"]) => boolean) {
    if (!view) return;
    cmd(view.state, view.dispatch);
    view.focus();
  }

  function toggle(mark: MarkType) {
    return () => run(toggleMark(mark));
  }

  function setHeading(level: number) {
    return () => {
      if (!view) return;
      // Toggle: if already this heading, go back to paragraph
      if (nodeActive(schema.nodes.heading, { level })) {
        run(setBlockType(schema.nodes.paragraph));
      } else {
        run(setBlockType(schema.nodes.heading, { level }));
      }
    };
  }

  function wrapList(node: NodeType) {
    return () => run(wrapInList(node));
  }

  function insertHorizontalRule() {
    if (!view) return;
    const hr = schema.nodes.horizontal_rule;
    const tr = view.state.tr.replaceSelectionWith(hr.create()).scrollIntoView();
    view.dispatch(tr);
    view.focus();
  }

  function toggleLink() {
    if (!view) return;
    const linkType = schema.marks.link;
    const { from, to, empty } = view.state.selection;
    if (empty) {
      view.focus();
      return;
    }
    if (view.state.doc.rangeHasMark(from, to, linkType)) {
      run(toggleMark(linkType));
      return;
    }
    const href = window.prompt("Link URL");
    if (!href) {
      view.focus();
      return;
    }
    run(toggleMark(linkType, { href }));
  }

  function isLinkActive(): boolean {
    if (!view) return false;
    const sel = view.state.selection;
    const linkType = schema.marks.link;
    if (sel.empty) return !!linkType.isInSet(sel.$from.marks());
    return view.state.doc.rangeHasMark(sel.from, sel.to, linkType);
  }

  // ─── derived button state ─────────────────────────────────────────────────
  // ProseMirror transactions don't trigger Svelte rerenders; poll on RAF
  // so toolbar pressed-state stays in sync with the cursor position.
  let tick = $state(0);
  $effect(() => {
    if (!view) return;
    let raf = 0;
    const loop = () => {
      tick++;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  const isBold = $derived.by(() => {
    void tick;
    return markActive(schema.marks.strong);
  });
  const isItalic = $derived.by(() => {
    void tick;
    return markActive(schema.marks.em);
  });
  const isCode = $derived.by(() => {
    void tick;
    return markActive(schema.marks.code);
  });
  const isH1 = $derived.by(() => {
    void tick;
    return nodeActive(schema.nodes.heading, { level: 1 });
  });
  const isH2 = $derived.by(() => {
    void tick;
    return nodeActive(schema.nodes.heading, { level: 2 });
  });
  const isH3 = $derived.by(() => {
    void tick;
    return nodeActive(schema.nodes.heading, { level: 3 });
  });
  const isBlockquote = $derived.by(() => {
    void tick;
    if (!view) return false;
    const sel = view.state.selection;
    // Walk up the ancestor chain — a blockquote can wrap several blocks
    // away from the current depth.
    for (let d = sel.$from.depth; d > 0; d--) {
      if (sel.$from.node(d).type === schema.nodes.blockquote) return true;
    }
    return false;
  });
  const isCodeBlock = $derived.by(() => {
    void tick;
    return nodeActive(schema.nodes.code_block);
  });
  const isLink = $derived.by(() => {
    void tick;
    return isLinkActive();
  });
  const canUndo = $derived.by(() => {
    void tick;
    return view ? undoDepth(view.state) > 0 : false;
  });
  const canRedo = $derived.by(() => {
    void tick;
    return view ? redoDepth(view.state) > 0 : false;
  });
  const canTable = $derived.by(() => {
    void tick;
    return view ? canInsertTable(view.state) : false;
  });
</script>

{#snippet btn(name: ToolbarIconName, title: string, onclick: () => void, pressed: boolean | undefined = undefined, disabled = false)}
  <button
    type="button"
    class="tb-btn"
    class:active={pressed}
    aria-pressed={pressed}
    aria-label={title}
    {title}
    {disabled}
    {onclick}
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
      {@html TOOLBAR_ICONS[name]}
    </svg>
  </button>
{/snippet}

<div class="paper-toolbar" role="toolbar" aria-label="Editor toolbar">
  {@render btn("undo", "Undo", () => run(undo), undefined, !canUndo)}
  {@render btn("redo", "Redo", () => run(redo), undefined, !canRedo)}
  <span class="tb-sep" aria-hidden="true"></span>
  {@render btn("h1", "Heading 1", setHeading(1), isH1)}
  {@render btn("h2", "Heading 2", setHeading(2), isH2)}
  {@render btn("h3", "Heading 3", setHeading(3), isH3)}
  <span class="tb-sep" aria-hidden="true"></span>
  {@render btn("bold", "Bold (⌘B)", toggle(schema.marks.strong), isBold)}
  {@render btn("italic", "Italic (⌘I)", toggle(schema.marks.em), isItalic)}
  {@render btn("code", "Inline code (⌘`)", toggle(schema.marks.code), isCode)}
  {@render btn("link", "Link (⌘K)", toggleLink, isLink)}
  <span class="tb-sep" aria-hidden="true"></span>
  {@render btn("listUl", "Bullet list", wrapList(schema.nodes.bullet_list))}
  {@render btn("listOl", "Numbered list", wrapList(schema.nodes.ordered_list))}
  {@render btn("taskList", "Task list (⌘⇧7)", wrapList(schema.nodes.task_list))}
  {@render btn("outdent", "Outdent list (⌘[)", () => run(liftListItem(schema.nodes.list_item)))}
  {@render btn("indent", "Indent list (⌘])", () => run(sinkListItem(schema.nodes.list_item)))}
  <span class="tb-sep" aria-hidden="true"></span>
  {@render btn("quote", "Blockquote", () => run(wrapIn(schema.nodes.blockquote)), isBlockquote)}
  {@render btn("codeBlock", "Code block", () => run(setBlockType(schema.nodes.code_block)), isCodeBlock)}
  {@render btn("hr", "Horizontal rule", insertHorizontalRule)}
  {@render btn("image", "Insert image", () => onInsertImage?.())}
  {@render btn(
    "table",
    "Insert table (empty paragraphs only)",
    () => run(insertTable(3, 3)),
    undefined,
    !canTable,
  )}
  {#if kind === "template"}
    <span class="tb-sep" aria-hidden="true"></span>
    <div class="tb-placeholder-wrap" bind:this={placeholderRoot}>
      <button
        type="button"
        class="tb-btn tb-placeholder-trigger"
        aria-haspopup="menu"
        aria-expanded={placeholderOpen}
        aria-label="Insert placeholder"
        title={"Insert placeholder ({key})"}
        onclick={() => {
          placeholderOpen = !placeholderOpen;
          if (placeholderOpen) void loadPlaceholderParams();
        }}
      >
        <span class="tb-placeholder-label">{"{ }"}</span>
      </button>
      {#if placeholderOpen}
        <div class="tb-placeholder-menu" role="menu">
          {#if placeholderLoading && placeholderParams === null}
            <div class="tb-placeholder-loading">Loading…</div>
          {:else if placeholderParams && placeholderParams.length}
            {#each placeholderParams as p (p.key)}
              <button
                type="button"
                role="menuitem"
                class="tb-placeholder-item"
                onclick={() => insertPlaceholder(p.key)}
              >
                <span class="tb-placeholder-key">{p.key}</span>
                <span class="tb-placeholder-sample">{p.sample}</span>
              </button>
            {/each}
          {:else}
            <div class="tb-placeholder-loading">No placeholders defined.</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>


<style>
  .paper-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px;
    border: 1px solid #e4e4e4;
    border-radius: 8px;
    background: #fff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 12px rgba(0, 0, 0, 0.04);
    flex-wrap: wrap;
    position: sticky;
    top: 8px;
    z-index: 10;
    margin: 0 auto 12px;
    width: fit-content;
    justify-content: center;
  }
  .tb-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid transparent;
    background: transparent;
    border-radius: 4px;
    cursor: pointer;
    color: #333;
    padding: 0;
  }
  .tb-btn:hover:not(:disabled) {
    background: #eaeaea;
  }
  .tb-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tb-btn.active {
    background: #d9e7f8;
    color: #0b5cad;
    border-color: #b8d3ee;
  }
  .tb-sep {
    width: 1px;
    height: 18px;
    background: #ccc;
    margin: 0 4px;
  }
  .tb-placeholder-wrap {
    position: relative;
    display: inline-flex;
  }
  .tb-placeholder-trigger {
    width: auto;
    padding: 0 8px;
    font-size: 12px;
    font-weight: 600;
    color: #0b3b8a;
  }
  .tb-placeholder-label {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .tb-placeholder-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 20;
    min-width: 220px;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 8px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.1);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .tb-placeholder-loading {
    padding: 8px 10px;
    font-size: 12px;
    color: #666;
  }
  .tb-placeholder-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font: inherit;
    text-align: left;
    color: #222;
    cursor: pointer;
  }
  .tb-placeholder-item:hover {
    background: #f0f3f6;
  }
  .tb-placeholder-key {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    color: #0b3b8a;
  }
  .tb-placeholder-sample {
    font-size: 11px;
    color: #888;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 130px;
  }
</style>
