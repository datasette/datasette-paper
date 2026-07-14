<script lang="ts">
  import type { EditorView } from "prosemirror-view";
  import type { MarkType, NodeType } from "prosemirror-model";
  import { toggleMark, setBlockType, wrapIn } from "prosemirror-commands";
  import { wrapInList, liftListItem, sinkListItem } from "prosemirror-schema-list";
  import { undo, redo, undoDepth, redoDepth } from "prosemirror-history";
  import { schema } from "./schema";
  import { TOOLBAR_ICONS, type ToolbarIconName } from "./icons";
  import { wrapSelectionInCallout, unwrapCallout } from "./callout";
  import { canInsertTable, insertTable } from "./tables";
  import { insertToc } from "./tocView";
  import { embedInsertSources } from "./embedProviders";
  // The in-table action bar (add/delete row/col, name input) is owned
  // by tableInsertTooltipPlugin (see tableInsertTooltip.ts). Only the
  // initial Insert-table button lives in the toolbar.

  let {
    view,
    kind = "doc",
    onInsertImage,
    onInsertEmbed,
  }: {
    view: EditorView | null;
    kind?: "doc" | "template";
    // Opens the (PaperApp-owned) image insert dialog. Shared with the `/`
    // slash menu so there is only ever one ImageDialog instance.
    onInsertImage?: () => void;
    // Opens the (PaperApp-owned) embed picker dialog for `sourceId`
    // (undefined = native Datasette). Same callback shape as the `/` menu's
    // openDatasetteEmbed.
    onInsertEmbed?: (sourceId?: string) => void;
  } = $props();

  // ─── embed dropdown ─────────────────────────────────────────────────────────
  // Launcher for the existing embed picker. Items come from the shared
  // `embedInsertSources()` (the same list the `/` menu uses) so the two entry
  // points never drift. Synchronous/in-memory — no fetch, no loading state.
  let embedOpen = $state(false);
  let embedRoot: HTMLDivElement | undefined = $state();

  /** Resolve each source's TOOLBAR_ICONS key, falling back to "database" for an
   *  absent/unknown manifest icon. Pure so it can be unit-tested without DOM. */
  function embedDropdownItems(): { id?: string; label: string; icon: ToolbarIconName }[] {
    return embedInsertSources().map((s) => ({
      id: s.id,
      label: s.label,
      icon: (s.icon && s.icon in TOOLBAR_ICONS ? s.icon : "database") as ToolbarIconName,
    }));
  }

  let embedItems = $state(embedDropdownItems());

  function onEmbedTriggerClick() {
    const items = embedDropdownItems();
    // Single source (no third-party providers — the default install): a
    // one-item menu is noise, so open the native dialog directly.
    if (items.length <= 1) {
      embedOpen = false;
      onInsertEmbed?.(undefined);
      return;
    }
    embedItems = items;
    embedOpen = !embedOpen;
  }

  // Close the embed dropdown on outside-click / Escape (mirrors the
  // placeholder dropdown effect below).
  $effect(() => {
    if (!embedOpen) return;
    const onClick = (evt: MouseEvent) => {
      if (!embedRoot) return;
      if (!embedRoot.contains(evt.target as Node)) embedOpen = false;
    };
    const onKey = (evt: KeyboardEvent) => {
      if (evt.key === "Escape") embedOpen = false;
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  });

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

  // Callout toggle: mirrors the quote button. Outside a callout, wrap the
  // selection as a Note; inside one, unwrap it back to plain blocks.
  function toggleCallout() {
    if (!view) return;
    run(isCallout ? unwrapCallout : wrapSelectionInCallout("note"));
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

<div class="paper-toolbar" role="toolbar" aria-label="Editor toolbar" style={mobileBottomStyle}>
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
  {@render btn("wikilink", "Link to a page ([[)", startWikiLink)}
  <span class="tb-sep" aria-hidden="true"></span>
  {@render btn("listUl", "Bullet list", wrapList(schema.nodes.bullet_list))}
  {@render btn("listOl", "Numbered list", wrapList(schema.nodes.ordered_list))}
  {@render btn("taskList", "Task list (⌘⇧7)", wrapList(schema.nodes.task_list))}
  {@render btn("outdent", "Outdent list (⌘[)", () => run(liftListItem(schema.nodes.list_item)))}
  {@render btn("indent", "Indent list (⌘])", () => run(sinkListItem(schema.nodes.list_item)))}
  <span class="tb-sep" aria-hidden="true"></span>
  {@render btn("quote", "Blockquote", () => run(wrapIn(schema.nodes.blockquote)), isBlockquote)}
  <!-- @feat callout: toolbar button wraps selection as a Note / unwraps when active -->
  {@render btn("infoCircle", "Callout", toggleCallout, isCallout)}
  {@render btn("codeBlock", "Code block", () => run(setBlockType(schema.nodes.code_block)), isCodeBlock)}
  {@render btn("hr", "Horizontal rule", insertHorizontalRule)}
  {@render btn("listNested", "Insert table of contents", () => run(insertToc))}
  {@render btn("image", "Insert image", () => onInsertImage?.())}
  {@render btn(
    "table",
    "Insert table (empty paragraphs only)",
    () => run(insertTable(3, 3)),
    undefined,
    !canTable,
  )}
  <!-- Embed launcher. Reuses the bundled `database` icon; opens the existing
       picker dialog. NOT gated on `kind` — available for both doc & template
       (unlike the placeholder dropdown, which is template-only). -->
  <div class="tb-embed-wrap" bind:this={embedRoot}>
    <button
      type="button"
      class="tb-btn"
      class:active={embedOpen}
      aria-haspopup="menu"
      aria-expanded={embedOpen}
      aria-label="Insert embed"
      title="Insert Datasette embed"
      onclick={onEmbedTriggerClick}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
        {@html TOOLBAR_ICONS["database"]}
      </svg>
    </button>
    {#if embedOpen}
      <div class="tb-embed-menu" role="menu">
        {#each embedItems as src (src.label)}
          <button
            type="button"
            role="menuitem"
            class="tb-embed-item"
            onclick={() => {
              embedOpen = false;
              onInsertEmbed?.(src.id);
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
              {@html TOOLBAR_ICONS[src.icon]}
            </svg>
            <span>{src.label}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
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
  .tb-embed-wrap {
    position: relative;
    display: inline-flex;
  }
  .tb-embed-menu {
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
  .tb-embed-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font: inherit;
    text-align: left;
    color: var(--pp-fg);
    cursor: pointer;
  }
  .tb-embed-item:hover {
    background: var(--pp-surface-2);
  }
  .tb-embed-item svg {
    flex: 0 0 auto;
    color: var(--pp-fg-muted);
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
    /* deliberate literal: deep-navy placeholder accent, darker than --pp-accent. */
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
    background: var(--pp-bg);
    border: 1px solid var(--pp-border);
    border-radius: 8px;
    box-shadow: 0 4px 14px var(--pp-shadow);
    padding: 4px;
    display: flex;
    flex-direction: column;
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
