<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { EditorView } from "prosemirror-view";
  import "prosemirror-tables/style/tables.css";
  import { EditorConnection } from "./collab";
  import type { BootstrapPermissions, DocStatePayload } from "./collab";
  import { Reporter } from "./reporter";
  import type { ReporterState } from "./reporter";
  import Toolbar from "./Toolbar.svelte";
  import DocHeader from "./DocHeader.svelte";

  let { docId }: { docId: string } = $props();

  let editorEl: HTMLDivElement | undefined = $state(undefined);

  type StatusObj = { state: ReporterState; message: string };
  let status: StatusObj = $state({ state: "ok", message: "" });
  let view: EditorView | null = $state(null);
  let users = $state(0);
  let mode: "edit" | "view" = $state("edit");
  let permissions = $state<BootstrapPermissions | null>(null);
  let docState = $state<DocStatePayload | null>(null);
  // Re-render the trash countdown each minute.
  let nowTick = $state(Date.now());
  // Read-only when the server says canEdit=false. When this flips on we
  // also force mode='view' so the toggle reflects reality.
  let canEdit = $derived(permissions?.canEdit ?? true);
  let isOwner = $derived(permissions?.isOwner ?? false);

  let conn: EditorConnection | undefined;
  let unsub: (() => void) | undefined;

  $effect(() => {
    if (!editorEl) return;

    const reporter = new Reporter();
    unsub = reporter.subscribe((s: ReporterState, m: string) => {
      status = { state: s, message: m };
    });

    conn = new EditorConnection(
      {
        docId,
        place: editorEl,
        onView: (v) => {
          view = v;
        },
        onUsers: (n) => {
          users = n;
        },
        onPermissions: (p) => {
          permissions = p;
          if (!p.canEdit) mode = "view";
        },
        onDocState: (s) => {
          docState = s;
        },
      },
      reporter,
    );

    return () => {
      unsub?.();
      conn?.close();
    };
  });

  // Push mode changes into the connection. Tracked separately from the
  // setup effect so we don't tear down the editor on every flip. The
  // server-side permission overrides any local toggle: if canEdit is
  // false, the editor stays read-only regardless of mode state.
  $effect(() => {
    conn?.setEditable(canEdit && mode === "edit");
  });

  async function copyMarkdown(): Promise<boolean> {
    if (!view) return false;
    try {
      // Lazy-load prosemirror-markdown — it bundles markdown-it for the
      // parser side that we don't use here, ~50k gzipped. Code-split so
      // it only downloads when the user actually clicks copy.
      const { defaultMarkdownSerializer, MarkdownSerializer } = await import(
        "prosemirror-markdown"
      );
      // Extend the default serializer with rules for our custom task_list
      // / task_item nodes. GFM-style `- [ ] foo` / `- [x] foo`.
      const serializer = new MarkdownSerializer(
        {
          ...defaultMarkdownSerializer.nodes,
          task_list(state, node) {
            state.renderList(node, "  ", () => "");
          },
          task_item(state, node) {
            const marker = node.attrs.checked ? "- [x] " : "- [ ] ";
            state.write(marker);
            state.renderContent(node);
          },
        },
        defaultMarkdownSerializer.marks,
      );
      const md = serializer.serialize(view.state.doc);
      await navigator.clipboard.writeText(md);
      return true;
    } catch {
      return false;
    }
  }

  onMount(() => {
    const t = setInterval(() => {
      nowTick = Date.now();
    }, 60_000);
    return () => clearInterval(t);
  });

  function deletesInLabel(deleteAt: string | null): string {
    if (!deleteAt) return "";
    const target = Date.parse(deleteAt);
    if (Number.isNaN(target)) return "";
    const diffMs = target - nowTick;
    if (diffMs <= 0) return "Deleting…";
    const days = Math.floor(diffMs / 86_400_000);
    if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
    const hours = Math.floor(diffMs / 3_600_000);
    if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;
    return "less than an hour";
  }

  async function restoreFromBanner(): Promise<void> {
    // Bypass openapi-fetch here so we don't need to thread the union
    // through paths.GET; this view only ever issues /restore.
    try {
      const resp = await fetch(`/-/paper/api/docs/${docId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!resp.ok) return;
      // The state-changed SSE will arrive shortly and update docState;
      // no local override needed.
    } catch {
      // Network error — leave the banner up; the user can retry.
    }
  }

  onDestroy(() => {
    unsub?.();
    conn?.close();
  });
</script>

<div class="datasette-paper-app" class:view-mode={mode === "view"}>
  <DocHeader {docId} {users} bind:mode {canEdit} {copyMarkdown} />
  {#if docState?.state === "trashed"}
    <div class="status-banner status-trashed" role="status">
      <span>
        This paper is in the trash. Auto-deletes in {deletesInLabel(
          docState.delete_at,
        )}.
      </span>
      {#if isOwner}
        <button type="button" onclick={restoreFromBanner}>Restore</button>
      {/if}
    </div>
  {:else if docState?.state === "archived"}
    <div class="archived-pill" aria-label="Archived">Archived</div>
  {/if}
  {#if status.state !== "ok"}
    <div class="status-banner status-{status.state}">{status.message}</div>
  {/if}
  {#if canEdit && mode === "edit"}
    <Toolbar {view} />
  {/if}
  <div class="editor-host" bind:this={editorEl}></div>
</div>

<style>
  .datasette-paper-app {
    max-width: 740px;
    margin: 0 auto;
    padding: 0 16px;
  }
  .status-banner {
    padding: 6px 10px;
    font-size: 13px;
    border-radius: 4px;
    margin-bottom: 8px;
  }
  .status-banner.status-delay {
    background: #fff5d4;
    color: #5a4a00;
  }
  .status-banner.status-fail {
    background: #ffd6d6;
    color: #5a0000;
  }
  .status-banner.status-trashed {
    background: #fff1d6;
    color: #5a3a00;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .status-banner.status-trashed button {
    font: inherit;
    font-size: 0.95em;
    padding: 3px 10px;
    border: 1px solid #c08000;
    background: #fff8ec;
    color: #5a3a00;
    border-radius: 3px;
    cursor: pointer;
  }
  .status-banner.status-trashed button:hover {
    background: #ffe8b8;
  }
  .archived-pill {
    display: inline-block;
    margin-bottom: 8px;
    padding: 2px 8px;
    background: #eef2f7;
    color: #4a5568;
    font-size: 12px;
    border-radius: 10px;
    border: 1px solid #d0d7e0;
  }
  /* In fullscreen layout the host gets flex:1; make the ProseMirror
   * surface stretch to fill it instead of capping at min-height: 60vh. */
  .editor-host {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .editor-host :global(.ProseMirror) {
    flex: 1;
    min-height: 60vh;
    padding: 8px 0;
    border: none;
    outline: none;
    font-size: 16px;
    line-height: 1.65;
    color: #1a1a1a;
  }
  .editor-host :global(.ProseMirror p) {
    margin: 0 0 0.75em;
  }
  .editor-host :global(.ProseMirror h1) {
    font-size: 1.9em;
    line-height: 1.25;
    margin: 0.6em 0 0.3em;
  }
  .editor-host :global(.ProseMirror h2) {
    font-size: 1.4em;
    line-height: 1.3;
    margin: 0.8em 0 0.3em;
  }
  /* Code blocks — distinct slab so users can tell at a glance it's a block,
   * not inline code. The inner <code> inherits font-family from <pre>; null
   * out any background it might have so styling doesn't double up. */
  .editor-host :global(.ProseMirror pre) {
    background: #f4f6f8;
    border: 1px solid #e0e4e8;
    border-radius: 6px;
    padding: 10px 12px;
    margin: 0 0 0.75em;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.9em;
    line-height: 1.5;
    overflow-x: auto;
  }
  .editor-host :global(.ProseMirror pre code) {
    background: transparent;
    padding: 0;
    font-size: inherit;
  }
  /* Heading-fold chevron (rendered as a Decoration.widget by foldHeadings.ts).
   * Sits in the heading's left gutter via a negative absolute offset; the
   * heading itself is the positioning ancestor. Hidden until hover for
   * unfolded sections so it doesn't clutter, but always shown when folded
   * so users can see something is collapsed. */
  .editor-host :global(.ProseMirror h1),
  .editor-host :global(.ProseMirror h2),
  .editor-host :global(.ProseMirror h3),
  .editor-host :global(.ProseMirror h4),
  .editor-host :global(.ProseMirror h5),
  .editor-host :global(.ProseMirror h6) {
    position: relative;
  }
  .editor-host :global(.pm-fold-toggle) {
    position: absolute;
    left: -22px;
    top: 0.45em;
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: #999;
    cursor: pointer;
    padding: 0;
    opacity: 0;
    transition: opacity 0.1s, background 0.1s;
  }
  .editor-host :global(h1:hover .pm-fold-toggle),
  .editor-host :global(h2:hover .pm-fold-toggle),
  .editor-host :global(h3:hover .pm-fold-toggle),
  .editor-host :global(h4:hover .pm-fold-toggle),
  .editor-host :global(h5:hover .pm-fold-toggle),
  .editor-host :global(h6:hover .pm-fold-toggle),
  .editor-host :global(.pm-fold-toggle:focus) {
    opacity: 1;
  }
  /* Always-visible chevron when the section is folded — the icon then
   * points right (▸), making the folded state legible at a glance. */
  .editor-host :global(.pm-fold-toggle[aria-label="Unfold section"]) {
    opacity: 1;
    color: #666;
  }
  .editor-host :global(.pm-fold-toggle:hover) {
    background: #f0f3f6;
    color: #333;
  }
  /* Blocks hidden under a folded heading. */
  .editor-host :global(.pm-folded) {
    display: none;
  }

  /* Datasette's base app.css resets `ol, ul { list-style: none }`. Restore
   * bullets/numbers inside the editor so prosemirror-schema-list's bullet_list
   * and ordered_list render correctly. */
  .editor-host :global(.ProseMirror ul) {
    list-style: disc;
    padding-left: 1.5em;
  }
  .editor-host :global(.ProseMirror ul ul) { list-style: circle; }
  .editor-host :global(.ProseMirror ul ul ul) { list-style: square; }
  .editor-host :global(.ProseMirror ol) {
    list-style: decimal;
    padding-left: 1.5em;
  }
  /* Tighten vertical rhythm inside list items. ProseMirror wraps each item's
   * text in a <p>, which inherits the global `.ProseMirror p` 0.75em bottom
   * margin and makes `- ` / `[ ] ` stacks look airy. Zero it out here; the
   * 1.65 line-height already gives adequate visual separation. */
  .editor-host :global(.ProseMirror li > p),
  .editor-host :global(.ProseMirror .task-item-content > p) {
    margin: 0;
  }
  /* Task lists draw their own checkbox; keep them marker-less and override
   * the bullet rule above. */
  .editor-host :global(ul[data-task-list]) {
    list-style: none;
    padding-left: 1.5em;
  }
  .editor-host :global(li[data-task-item]) {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
  }
  .editor-host :global(li[data-task-item] > input[type="checkbox"]) {
    margin-top: 0.45em;
    flex-shrink: 0;
    cursor: pointer;
  }
  .editor-host :global(li[data-task-item] > .task-item-content) {
    flex: 1;
    min-width: 0;
  }
  .editor-host :global(li[data-task-item][data-checked="true"] > .task-item-content) {
    text-decoration: line-through;
    color: #888;
  }

  /* Tables — prosemirror-tables ships layout but no cell borders. We
   * draw a light grid + a header background. `--default-cell-min-width`
   * stops empty cells from collapsing to 0px wide. */
  .editor-host :global(.ProseMirror) {
    --default-cell-min-width: 80px;
  }
  .editor-host :global(.ProseMirror table) {
    margin: 0 0 0.75em;
    border: 1px solid #d4d4d4;
  }
  .editor-host :global(.ProseMirror td),
  .editor-host :global(.ProseMirror th) {
    border: 1px solid #d4d4d4;
    padding: 6px 9px;
  }
  .editor-host :global(.ProseMirror th) {
    background: #f4f6f8;
    text-align: left;
    font-weight: 600;
  }
  /* Cells contain a `block+`; collapse the implicit paragraph margin so
   * single-line cells don't get the global p { margin-bottom: 0.75em }. */
  .editor-host :global(.ProseMirror td > p),
  .editor-host :global(.ProseMirror th > p) {
    margin: 0;
  }
  /* Highlight cells that are part of a CellSelection — prosemirror-tables
   * tags them with `.selectedCell` and draws an ::after overlay. Tint the
   * background too so the selection is unmistakable. */
  .editor-host :global(.ProseMirror .selectedCell) {
    background: rgba(11, 92, 173, 0.08);
  }

  /* In-table action bar — owned by tableInsertTooltipPlugin. Anchored
   * absolutely to the editor host, centered above the table. The
   * `.editor-host` is position: relative so absolute coords resolve. */
  .editor-host {
    position: relative;
  }
  .editor-host :global(.pm-table-tooltip-root) {
    position: absolute;
    /* Above .paper-toolbar (sticky, z:10) — without this the toolbar
     * intercepts clicks on the tooltip when a table sits near the top. */
    z-index: 11;
    transform: translate(-50%, -100%);
    margin-top: -6px;
  }
  /* Always visible while the cursor is in a table — no opacity ramp
   * because table editing is an explicit mode. */
  .editor-host :global(.pm-tt-bar) {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px;
    background: #fff;
    border: 1px solid #d4d4d4;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    flex-wrap: wrap;
    max-width: 480px;
  }
  .editor-host :global(.pm-tt-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 24px;
    border: 1px solid transparent;
    background: transparent;
    border-radius: 4px;
    cursor: pointer;
    color: #333;
    padding: 0;
  }
  .editor-host :global(.pm-tt-btn:hover) {
    background: #eaeaea;
  }
  .editor-host :global(.pm-tt-btn.pm-tt-text) {
    width: auto;
    padding: 0 6px;
    font-size: 12px;
    color: #555;
  }
  .editor-host :global(.pm-tt-sep) {
    width: 1px;
    height: 18px;
    background: #ccc;
    margin: 0 4px;
  }
  .editor-host :global(.pm-tt-name) {
    height: 22px;
    padding: 0 6px;
    font-size: 12px;
    border: 1px solid #d4d4d4;
    border-radius: 4px;
    width: 140px;
    color: #1a1a1a;
    background: #fff;
  }
  .editor-host :global(.pm-tt-name:focus) {
    outline: none;
    border-color: #0b5cad;
    box-shadow: 0 0 0 2px rgba(11, 92, 173, 0.2);
  }
  .editor-host :global(.pm-tt-name.pm-tt-name-warn) {
    border-color: #c08000;
    background: #fff8ec;
  }
  .editor-host :global(.pm-tt-name.pm-tt-name-warn:focus) {
    border-color: #c08000;
    box-shadow: 0 0 0 2px rgba(192, 128, 0, 0.25);
  }
  .editor-host :global(.pm-tt-warn) {
    margin-left: 4px;
    font-size: 12px;
    color: #8a5a00;
    white-space: nowrap;
  }
  .editor-host :global(.pm-tt-api) {
    font-weight: 600;
    color: #0b5cad;
  }
  .editor-host :global(.pm-tt-api:hover:not(:disabled)) {
    background: #d9e7f8;
  }
  .editor-host :global(.pm-tt-api:disabled) {
    opacity: 0.4;
    cursor: not-allowed;
    color: #555;
  }
</style>
