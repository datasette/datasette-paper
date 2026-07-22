<script lang="ts">
  import type { EditorView } from "prosemirror-view";
  import type { MarkType, NodeType } from "prosemirror-model";
  import { toggleMark, setBlockType, wrapIn, lift, chainCommands } from "prosemirror-commands";
  import { wrapInList, liftListItem, sinkListItem } from "prosemirror-schema-list";
  import { undo, redo, undoDepth, redoDepth } from "prosemirror-history";
  import { schema } from "./schema";
  import { TOOLBAR_ICONS, type ToolbarIconName } from "./icons";
  import { blockTypeLabel } from "./blockTypeLabel";
  import { activeListType } from "./activeListType";
  import { wrapSelectionInCallout, unwrapCallout } from "./callout";
  import type { SlashCommand } from "./slashMenu";
  import { insertMenuGroups } from "./insertMenuItems";
  // The in-table action bar (add/delete row/col, name input) is owned
  // by tableInsertTooltipPlugin (see tableInsertTooltip.ts). No table-mode
  // controls live in the toolbar.

  let {
    view,
    kind = "doc",
    insertCommands = [],
  }: {
    view: EditorView | null;
    kind?: "doc" | "template";
    // The `/` slash-command registry (built once in collab.ts) — the ＋ Insert
    // menu renders it directly so the two entry points never drift. Dialog-
    // backed commands (image, embed picker) already carry their PaperApp-owned
    // callbacks, so opening one from here reuses the single dialog instance.
    insertCommands?: SlashCommand[];
  } = $props();

  // ─── shared dropdown machinery ──────────────────────────────────────────────
  // One menu open at a time. Every dropdown trigger sets `openMenu` to its own
  // key and binds its wrapper element as the menu root; a single $effect (below)
  // handles outside-click / Escape close plus ArrowUp/Down + Enter roving
  // navigation over that menu's `[role=menuitem]` rows. Deliberately generic:
  // the ＋ Insert menu (with the template placeholder section folded in) is the
  // "insert" key.
  type MenuName = "text" | "link" | "list" | "insert";
  let openMenu = $state<MenuName | null>(null);

  // Wrapper element per menu (trigger + popup), so a click on the trigger reads
  // as "inside" and doesn't trip the outside-click close.
  let textRoot: HTMLDivElement | undefined = $state();
  let linkRoot: HTMLDivElement | undefined = $state();
  let listRoot: HTMLDivElement | undefined = $state();
  let insertRoot: HTMLDivElement | undefined = $state();

  function menuRoot(name: MenuName): HTMLElement | undefined {
    switch (name) {
      case "text":
        return textRoot;
      case "link":
        return linkRoot;
      case "list":
        return listRoot;
      case "insert":
        return insertRoot;
      default:
        return undefined;
    }
  }

  function toggleMenu(name: MenuName) {
    openMenu = openMenu === name ? null : name;
  }

  function closeMenu() {
    openMenu = null;
  }

  // Close on outside-click / Escape; roving highlight with ArrowUp/Down + Enter
  // (same feel as the slash popup). `index` is local to the open-menu lifecycle
  // — keeping it out of $state avoids the effect re-triggering itself.
  $effect(() => {
    const name = openMenu;
    if (!name) return;
    const root = menuRoot(name);

    const items = (): HTMLElement[] =>
      root
        ? Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'))
        : [];
    const highlight = (i: number) => {
      const els = items();
      els.forEach((el, k) => el.classList.toggle("sel", k === i));
      // jsdom doesn't implement scrollIntoView — guard the call.
      const el = els[i];
      if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    };

    // Start on the active row (current block type) when the menu marks one.
    let index = Math.max(
      0,
      items().findIndex((el) => el.classList.contains("active")),
    );
    highlight(index);

    const onClick = (evt: MouseEvent) => {
      if (root && !root.contains(evt.target as Node)) closeMenu();
    };
    const onKey = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") {
        closeMenu();
        return;
      }
      const els = items();
      if (!els.length) return;
      if (evt.key === "ArrowDown") {
        evt.preventDefault();
        index = (index + 1) % els.length;
        highlight(index);
      } else if (evt.key === "ArrowUp") {
        evt.preventDefault();
        index = (index - 1 + els.length) % els.length;
        highlight(index);
      } else if (evt.key === "Enter") {
        evt.preventDefault();
        els[index]?.click();
      }
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  });

  // ─── ＋ Insert menu ──────────────────────────────────────────────────────────
  // Rendered from the shared `insertCommands` registry (see prop docstring),
  // filtered/grouped by the pure `insertMenuGroups` helper. Recomputed each RAF
  // tick so per-command `enabled(state)` gating (canInsertTable / canDate) stays
  // live with the cursor. On a template, a trailing Placeholders section (below)
  // folds in.

  // Lazy-loaded list of built-in placeholder keys with sample values.
  // Fetched once on demand (when the Insert menu opens for the first
  // time on a template) and cached for the session.
  type ParamInfo = { key: string; sample: string };
  let placeholderParams = $state<ParamInfo[] | null>(null);
  let placeholderLoading = $state(false);

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
    closeMenu();
    const node = schema.nodes.placeholder.create({ key });
    const tr = view.state.tr.replaceSelectionWith(node).scrollIntoView();
    view.dispatch(tr);
    view.focus();
  }

  // Commit an ＋ Insert row: close the menu, run the slash command (each handles
  // its own dialog/insert), then restore editor focus — mirrors the slash
  // popup's runSlashCommand tail (there's no `/query` to clear here).
  function runInsertCommand(cmd: SlashCommand) {
    if (!view) return;
    closeMenu();
    cmd.run(view);
    view.focus();
  }

  // Open/close the ＋ Insert menu; on a template, kick the (cached) placeholder
  // fetch the first time it opens so the trailing Placeholders section fills in.
  function onInsertTriggerClick() {
    const opening = openMenu !== "insert";
    toggleMenu("insert");
    if (opening && kind === "template") void loadPlaceholderParams();
  }

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

  // Indent / outdent for the List ▾ menu. Unlike the old single-command
  // buttons, these chain task_item then list_item so they work in task lists
  // too — matching the Tab / Shift-Tab keymap in collab.ts.
  const sinkList = chainCommands(
    sinkListItem(schema.nodes.task_item),
    sinkListItem(schema.nodes.list_item),
  );
  const liftList = chainCommands(
    liftListItem(schema.nodes.task_item),
    liftListItem(schema.nodes.list_item),
  );

  // Text ▾ menu rows: close the menu, then run the block-type command. Kept
  // generic (takes the action thunk) so every row reads the same.
  function chooseBlock(action: () => void) {
    return () => {
      closeMenu();
      action();
    };
  }

  // Callout toggle: mirrors the quote button. Outside a callout, wrap the
  // selection as a Note; inside one, unwrap it back to plain blocks.
  function toggleCallout() {
    if (!view) return;
    run(isCallout ? unwrapCallout : wrapSelectionInCallout("note"));
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

  // Insert `[[` at the cursor to launch the wiki-link autocomplete. The
  // wikiLinkSuggest plugin recomputes from doc+selection on every transaction
  // (no dedicated open command), so a plain insert trips its trigger exactly
  // like typing the brackets by hand.
  function startWikiLink() {
    if (!view) return;
    const tr = view.state.tr.insertText("[[");
    view.dispatch(tr);
    view.focus();
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
  // Active when the selection sits anywhere inside a callout — walk the
  // ancestor chain like isBlockquote (a callout wraps blocks above the
  // current depth). Callouts only ever live at depth 1.
  const isCallout = $derived.by(() => {
    void tick;
    if (!view) return false;
    const sel = view.state.selection;
    for (let d = sel.$from.depth; d > 0; d--) {
      if (sel.$from.node(d).type === schema.nodes.callout) return true;
    }
    return false;
  });
  const isLink = $derived.by(() => {
    void tick;
    return isLinkActive();
  });
  // List ▾ trigger + active-row marker: the innermost list wrapping the
  // selection ("bullet_list" / "ordered_list" / "task_list"), or null when the
  // selection sits outside any list. Trigger is active whenever this is non-null.
  const activeList = $derived.by(() => {
    void tick;
    return view ? activeListType(view.state) : null;
  });
  // Text ▾ trigger label — current block type at the cursor.
  const blockLabel = $derived.by(() => {
    void tick;
    return view ? blockTypeLabel(view.state) : "Text";
  });
  const canUndo = $derived.by(() => {
    void tick;
    return view ? undoDepth(view.state) > 0 : false;
  });
  const canRedo = $derived.by(() => {
    void tick;
    return view ? redoDepth(view.state) > 0 : false;
  });
  // ＋ Insert menu contents from the shared slash registry. Recomputed on the
  // RAF tick so each command's enabled(state) gate (table-in-list, canDate, …)
  // tracks the cursor; `insertMenuGroups` is pure so it's unit-tested directly.
  const insertGroups = $derived.by(() => {
    void tick;
    return insertMenuGroups(insertCommands, view ? view.state : null);
  });

  // ─── mobile layout ──────────────────────────────────────────────────────────
  // On phones the toolbar becomes a bottom-pinned, horizontally-scrolling strip
  // that rides above the software keyboard, plus an always-visible button to
  // dismiss the keyboard. Everything here is gated on the same 640px breakpoint
  // as the `@media` rules below so JS and CSS agree on what "mobile" means.
  const MOBILE_QUERY = "(max-width: 640px)";
  let isMobile = $state(false);
  $effect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => (isMobile = mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  // Keyboard-aware bottom offset. `position: fixed; bottom: 0` pins to the
  // layout viewport, which on iOS sits *behind* the keyboard; the VisualViewport
  // gap tells us how tall the keyboard is so the strip can sit flush on top of
  // it. Falls back to 0 (viewport bottom) where VisualViewport is unavailable.
  let kbOffset = $state(0);
  $effect(() => {
    if (!isMobile) {
      kbOffset = 0;
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      kbOffset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  });

  // Blur the contenteditable to dismiss the iOS keyboard. Blurring the active
  // element too covers iOS versions that keep the keyboard up otherwise.
  function hideKeyboard() {
    (view?.dom as HTMLElement | undefined)?.blur();
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  // Inline bottom offset applied only on mobile (desktop keeps its sticky-top
  // rule untouched). Kept as a derived string so both the strip and the
  // hide-keyboard button track the keyboard together.
  const mobileBottomStyle = $derived(isMobile ? `bottom: ${kbOffset}px` : "");
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

<!-- Leading icon for a dropdown menu row / trigger. Falls back to a text glyph
     for the `paragraph` ("¶") and `plus` ("＋") slots until their bootstrap
     paths (`text-paragraph` / `plus-lg`) are pasted into icons.ts — the swap is
     then a one-line addition there, no markup change. -->
{#snippet menuIcon(name: string)}
  {#if TOOLBAR_ICONS[name]}
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
      {@html TOOLBAR_ICONS[name]}
    </svg>
  {:else if name === "paragraph"}
    <span class="tb-menu-glyph" aria-hidden="true">¶</span>
  {:else if name === "plus"}
    <span class="tb-menu-glyph" aria-hidden="true">＋</span>
  {/if}
{/snippet}

<div class="paper-toolbar" role="toolbar" aria-label="Editor toolbar" style={mobileBottomStyle}>
  {@render btn("undo", "Undo", () => run(undo), undefined, !canUndo)}
  {@render btn("redo", "Redo", () => run(redo), undefined, !canRedo)}
  <span class="tb-sep" aria-hidden="true"></span>
  <!-- Text ▾ — block-type "turn into" dropdown; trigger label doubles as the
       current-block indicator (blockLabel, RAF-tick derived). -->
  <div class="tb-menu-wrap" bind:this={textRoot}>
    <button
      type="button"
      class="tb-btn tb-trigger"
      class:active={openMenu === "text"}
      aria-haspopup="menu"
      aria-expanded={openMenu === "text"}
      aria-label="Turn into"
      title="Turn into…"
      onclick={() => toggleMenu("text")}
    >
      <span class="tb-trigger-label">{blockLabel}</span>
      <svg class="tb-trigger-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
        {@html TOOLBAR_ICONS["chevronDown"]}
      </svg>
    </button>
    {#if openMenu === "text"}
      <div class="tb-menu" role="menu" aria-label="Turn into">
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          class:active={blockLabel === "Text"}
          onclick={chooseBlock(() => run(setBlockType(schema.nodes.paragraph)))}
        >
          {@render menuIcon("paragraph")}
          <span class="tb-menu-label">Text</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          class:active={isH1}
          onclick={chooseBlock(setHeading(1))}
        >
          {@render menuIcon("h1")}
          <span class="tb-menu-label">Heading 1</span>
          <span class="tb-menu-hint">⇧⌃1</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          class:active={isH2}
          onclick={chooseBlock(setHeading(2))}
        >
          {@render menuIcon("h2")}
          <span class="tb-menu-label">Heading 2</span>
          <span class="tb-menu-hint">⇧⌃2</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          class:active={isH3}
          onclick={chooseBlock(setHeading(3))}
        >
          {@render menuIcon("h3")}
          <span class="tb-menu-label">Heading 3</span>
          <span class="tb-menu-hint">⇧⌃3</span>
        </button>
        <span class="tb-menu-sep" role="separator"></span>
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          class:active={isBlockquote}
          onclick={chooseBlock(() => run(isBlockquote ? lift : wrapIn(schema.nodes.blockquote)))}
        >
          {@render menuIcon("quote")}
          <span class="tb-menu-label">Quote</span>
          <span class="tb-menu-hint">⌃&gt;</span>
        </button>
        <!-- @feat callout: Text ▾ row wraps selection as a Note / unwraps when active -->
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          class:active={isCallout}
          onclick={chooseBlock(toggleCallout)}
        >
          {@render menuIcon("infoCircle")}
          <span class="tb-menu-label">Callout</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          class:active={isCodeBlock}
          onclick={chooseBlock(() => run(setBlockType(schema.nodes.code_block)))}
        >
          {@render menuIcon("codeBlock")}
          <span class="tb-menu-label">Code block</span>
          <span class="tb-menu-hint">⇧⌃\</span>
        </button>
      </div>
    {/if}
  </div>
  <span class="tb-sep" aria-hidden="true"></span>
  {@render btn("bold", "Bold (⌘B)", toggle(schema.marks.strong), isBold)}
  {@render btn("italic", "Italic (⌘I)", toggle(schema.marks.em), isItalic)}
  {@render btn("code", "Inline code (⌘`)", toggle(schema.marks.code), isCode)}
  <!-- Link ▾ — merges the URL-link and wiki-link buttons; trigger active when
       the selection carries a link mark (isLink). -->
  <div class="tb-menu-wrap" bind:this={linkRoot}>
    <button
      type="button"
      class="tb-btn tb-trigger tb-trigger-icon"
      class:active={openMenu === "link" || isLink}
      aria-haspopup="menu"
      aria-expanded={openMenu === "link"}
      aria-label="Link"
      title="Link"
      onclick={() => toggleMenu("link")}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
        {@html TOOLBAR_ICONS["link"]}
      </svg>
      <svg class="tb-trigger-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
        {@html TOOLBAR_ICONS["chevronDown"]}
      </svg>
    </button>
    {#if openMenu === "link"}
      <div class="tb-menu" role="menu" aria-label="Link">
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          class:active={isLink}
          onclick={chooseBlock(toggleLink)}
        >
          {@render menuIcon("link")}
          <span class="tb-menu-label">Link</span>
          <span class="tb-menu-hint">⌘K</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          onclick={chooseBlock(startWikiLink)}
        >
          {@render menuIcon("wikilink")}
          <span class="tb-menu-label">Link to a page</span>
          <span class="tb-menu-hint">[[</span>
        </button>
      </div>
    {/if}
  </div>
  <span class="tb-sep" aria-hidden="true"></span>
  <!-- List ▾ — merges the five list buttons; trigger active when the selection
       sits inside any list (activeList !== null). -->
  <div class="tb-menu-wrap" bind:this={listRoot}>
    <button
      type="button"
      class="tb-btn tb-trigger tb-trigger-icon"
      class:active={openMenu === "list" || activeList !== null}
      aria-haspopup="menu"
      aria-expanded={openMenu === "list"}
      aria-label="List"
      title="List"
      onclick={() => toggleMenu("list")}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
        {@html TOOLBAR_ICONS["listUl"]}
      </svg>
      <svg class="tb-trigger-chevron" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
        {@html TOOLBAR_ICONS["chevronDown"]}
      </svg>
    </button>
    {#if openMenu === "list"}
      <div class="tb-menu" role="menu" aria-label="List">
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          class:active={activeList === "bullet_list"}
          onclick={chooseBlock(wrapList(schema.nodes.bullet_list))}
        >
          {@render menuIcon("listUl")}
          <span class="tb-menu-label">Bullet list</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          class:active={activeList === "ordered_list"}
          onclick={chooseBlock(wrapList(schema.nodes.ordered_list))}
        >
          {@render menuIcon("listOl")}
          <span class="tb-menu-label">Numbered list</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          class:active={activeList === "task_list"}
          onclick={chooseBlock(wrapList(schema.nodes.task_list))}
        >
          {@render menuIcon("taskList")}
          <span class="tb-menu-label">Task list</span>
          <span class="tb-menu-hint">⌘⇧7</span>
        </button>
        <span class="tb-menu-sep" role="separator"></span>
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          onclick={chooseBlock(() => run(sinkList))}
        >
          {@render menuIcon("indent")}
          <span class="tb-menu-label">Indent</span>
          <span class="tb-menu-hint">⌘]</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="tb-menu-item"
          onclick={chooseBlock(() => run(liftList))}
        >
          {@render menuIcon("outdent")}
          <span class="tb-menu-label">Outdent</span>
          <span class="tb-menu-hint">⌘[</span>
        </button>
      </div>
    {/if}
  </div>
  <span class="tb-sep" aria-hidden="true"></span>
  <!-- ＋ Insert — one menu fed by the shared slash-command registry (insertGroups
       from insertMenuGroups). Replaces the per-insert buttons + the bespoke embed
       dropdown; disabled rows come straight from each command's enabled(state)
       gate. On a template, the trailing Placeholders section folds in.
       @feat date: the /date command surfaces here as an Insert menu row. -->
  <div class="tb-menu-wrap" bind:this={insertRoot}>
    <button
      type="button"
      class="tb-btn tb-trigger tb-trigger-insert"
      class:active={openMenu === "insert"}
      aria-haspopup="menu"
      aria-expanded={openMenu === "insert"}
      aria-label="Insert"
      title="Insert…"
      onclick={onInsertTriggerClick}
    >
      {@render menuIcon("plus")}
      <span class="tb-trigger-label tb-insert-label">Insert</span>
    </button>
    {#if openMenu === "insert"}
      <div class="tb-menu tb-insert-menu" role="menu" aria-label="Insert">
        {#each insertGroups as g (g.key)}
          <div class="tb-insert-header" aria-hidden="true">{g.label}</div>
          <div class="tb-insert-grid">
            {#each g.rows as row (row.command.id)}
              <button
                type="button"
                role="menuitem"
                class="tb-menu-item tb-insert-item"
                disabled={row.disabled}
                title={row.disabled
                  ? `${row.command.label} — not available here`
                  : row.command.label}
                onclick={() => runInsertCommand(row.command)}
              >
                {@render menuIcon(row.command.icon)}
                <span class="tb-menu-label">{row.command.label}</span>
              </button>
            {/each}
          </div>
        {/each}
        {#if kind === "template"}
          <div class="tb-insert-header" aria-hidden="true">Placeholders</div>
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
        {/if}
      </div>
    {/if}
  </div>
</div>

<!-- Hide-keyboard button (mobile only). Rendered outside `.paper-toolbar` so it
     stays fixed on the right edge and never scrolls away with the button strip. -->
{#if isMobile}
  <button
    type="button"
    class="tb-hide-keyboard"
    aria-label="Hide keyboard"
    title="Hide keyboard"
    style={mobileBottomStyle}
    onclick={hideKeyboard}
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
      {@html TOOLBAR_ICONS["keyboardHide"]}
    </svg>
  </button>
{/if}


<style>
  .paper-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px;
    border: 1px solid var(--pp-border);
    border-radius: 8px;
    background: var(--pp-bg);
    /* deliberate literal: very faint toolbar elevation (.04), lighter than the
       --pp-shadow (.12) used by popovers/dialogs. */
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04), 0 4px 12px rgba(0, 0, 0, 0.04);
    /* No flex-wrap: the redesigned strip is ~9 controls and fits on one row by
       construction (design.md §Final control set). Mobile re-pins + scrolls. */
    position: sticky;
    top: 8px;
    z-index: 10;
    margin: 0 auto 12px;
    width: fit-content;
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
    color: var(--pp-fg);
    padding: 0;
  }
  .tb-btn:hover:not(:disabled) {
    background: var(--pp-surface-2);
  }
  .tb-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tb-btn.active {
    background: var(--pp-surface-3);
    color: var(--pp-accent);
    /* deliberate literal: light-blue active-button border, no matching token. */
    border-color: #b8d3ee;
  }
  .tb-sep {
    width: 1px;
    height: 18px;
    background: var(--pp-border-strong);
    margin: 0 4px;
  }

  /* ─── shared dropdown (Text ▾; tickets 02/03 reuse for Link/List/Insert) ──── */
  .tb-menu-wrap {
    position: relative;
    display: inline-flex;
  }
  /* Wide trigger: label (current block type) + chevron, sized past the 28px
     icon square so text fits. */
  .tb-trigger {
    width: auto;
    gap: 4px;
    padding: 0 6px;
  }
  .tb-trigger-label {
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
  }
  .tb-trigger-chevron {
    color: var(--pp-fg-muted);
    flex: 0 0 auto;
  }
  /* Icon-first triggers (Link ▾ / List ▾): a 16px icon + chevron, tighter than
     the text-label Text ▾ trigger. */
  .tb-trigger-icon {
    gap: 2px;
    padding: 0 4px;
  }
  .tb-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 20;
    min-width: 200px;
    background: var(--pp-bg);
    border: 1px solid var(--pp-border);
    border-radius: 8px;
    box-shadow: 0 4px 14px var(--pp-shadow);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .tb-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font: inherit;
    text-align: left;
    color: var(--pp-fg);
    cursor: pointer;
  }
  /* `.sel` is the keyboard roving highlight (toggled at runtime via classList
     from the shared $effect, so it's :global to Svelte); hover mirrors it. */
  .tb-menu-item:hover,
  .tb-menu-item:global(.sel) {
    background: var(--pp-surface-2);
  }
  /* `.active` marks the current block type. */
  .tb-menu-item.active {
    color: var(--pp-accent);
  }
  .tb-menu-item.active :is(svg, .tb-menu-glyph) {
    color: var(--pp-accent);
  }
  .tb-menu-item svg,
  .tb-menu-glyph {
    flex: 0 0 auto;
    color: var(--pp-fg-muted);
  }
  .tb-menu-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    font-size: 14px;
    line-height: 1;
  }
  .tb-menu-label {
    flex: 1 1 auto;
  }
  .tb-menu-hint {
    margin-left: auto;
    font-size: 11px;
    color: var(--pp-fg-subtle);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .tb-menu-sep {
    height: 1px;
    background: var(--pp-border);
    margin: 4px 6px;
  }
  /* ─── ＋ Insert menu ───────────────────────────────────────────────────────
   * Reuses the shared `.tb-menu` shell + `.tb-menu-item` rows; adds group
   * headers and a two-column grid on wide viewports (one column ≤640px). */
  .tb-trigger-insert {
    gap: 4px;
    padding: 0 8px;
  }
  .tb-insert-menu {
    min-width: 300px;
  }
  .tb-insert-header {
    padding: 6px 10px 2px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--pp-fg-subtle);
  }
  /* Two-column grid ≥641px; collapses to one below (design.md §＋ Insert). */
  .tb-insert-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
  }
  .tb-insert-item {
    min-width: 0;
  }
  .tb-insert-item .tb-menu-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Disabled row: the command's enabled(state) gate rejected the context
     (e.g. table inside a list). Non-clickable, dimmed; reason in `title`. */
  .tb-insert-item:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tb-insert-item:disabled:hover {
    background: transparent;
  }
  @media (max-width: 640px) {
    .tb-insert-grid {
      grid-template-columns: 1fr;
    }
  }
  .tb-placeholder-loading {
    padding: 8px 10px;
    font-size: 12px;
    color: var(--pp-fg-muted);
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
    color: var(--pp-fg);
    cursor: pointer;
  }
  .tb-placeholder-item:hover {
    background: var(--pp-surface-2);
  }
  .tb-placeholder-key {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    /* deliberate literal: deep-navy placeholder accent, darker than --pp-accent. */
    color: #0b3b8a;
  }
  .tb-placeholder-sample {
    font-size: 11px;
    color: var(--pp-fg-subtle);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 130px;
  }

  /* ─── mobile: bottom-pinned, horizontally-scrolling strip ──────────────────
   * On phones the toolbar leaves the top and pins to the bottom of the screen,
   * riding above the software keyboard (JS sets an inline `bottom` via the
   * VisualViewport gap). It becomes a single non-wrapping row that scrolls
   * horizontally, with room reserved on the right for the fixed hide-keyboard
   * button. Breakpoint mirrors MOBILE_QUERY in the script. */
  .tb-hide-keyboard {
    display: none;
  }
  @media (max-width: 640px) {
    .paper-toolbar {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      top: auto;
      margin: 0;
      width: 100%;
      max-width: none;
      border-radius: 0;
      border-left: none;
      border-right: none;
      flex-wrap: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
      justify-content: flex-start;
      -webkit-overflow-scrolling: touch;
      /* Reserve space so scrolled buttons never slide under the fixed
       * hide-keyboard button on the right. */
      padding-right: 46px;
      /* Clear the iOS home indicator when the keyboard is closed. */
      padding-bottom: calc(4px + env(safe-area-inset-bottom));
    }
    /* Keep separators and buttons from being squeezed by the flex row. */
    .paper-toolbar .tb-btn,
    .paper-toolbar .tb-sep {
      flex: 0 0 auto;
    }
    /* ＋ Insert collapses to icon-only on the mobile strip (ticket 04 turns the
       menu itself into a bottom sheet; the trigger shrinks here already). */
    .tb-insert-label {
      display: none;
    }
    .tb-hide-keyboard {
      position: fixed;
      right: 0;
      bottom: 0;
      z-index: 11;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 46px;
      /* Match the strip height + safe-area so the button spans it fully. */
      height: calc(36px + env(safe-area-inset-bottom));
      padding-bottom: env(safe-area-inset-bottom);
      border: 1px solid var(--pp-border);
      border-right: none;
      border-bottom: none;
      border-top-left-radius: 8px;
      background: var(--pp-bg);
      color: var(--pp-fg);
      cursor: pointer;
      /* deliberate literal: faint edge shadow (.06), lighter than --pp-shadow. */
      box-shadow: -2px 0 6px rgba(0, 0, 0, 0.06);
    }
    .tb-hide-keyboard:active {
      background: var(--pp-surface-2);
    }
  }
</style>
