<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { EditorView } from "prosemirror-view";
  import "prosemirror-tables/style/tables.css";
  import { EditorConnection } from "./collab";
  import type {
    BootstrapPermissions,
    DocStatePayload,
    StepApplyError,
  } from "./collab";
  import { Reporter } from "./reporter";
  import type { ReporterState } from "./reporter";
  import Toolbar from "./Toolbar.svelte";
  import DocHeader from "./DocHeader.svelte";
  import LinksPanel from "./LinksPanel.svelte";
  import ImageDialog from "./ImageDialog.svelte";
  import DatasetteEmbedDialog from "./DatasetteEmbedDialog.svelte";
  import { insertImage } from "./image";
  import { insertDatasetteEmbed } from "./datasetteEmbed";

  let { docId }: { docId: string } = $props();

  // Insert dialogs, owned here so there's a single instance each. The toolbar
  // image button and the `/` slash menu both open the image dialog; the embed
  // dialog is opened by the slash menu and context-aware paste.
  let imageDialogOpen = $state(false);
  let embedDialogOpen = $state(false);
  // Which embed source the picker is scoped to: undefined = core Datasette,
  // otherwise a third-party provider source id.
  let embedSource = $state<string | undefined>(undefined);

  let editorEl: HTMLDivElement | undefined = $state(undefined);

  type StatusObj = { state: ReporterState; message: string };
  let status: StatusObj = $state({ state: "ok", message: "" });
  let view: EditorView | null = $state(null);
  let users = $state(0);
  let mode: "edit" | "view" = $state("edit");
  let permissions = $state<BootstrapPermissions | null>(null);
  let docState = $state<DocStatePayload | null>(null);
  // First step from the bootstrap or an SSE update that the editor couldn't
  // apply. When set, the connection forces read-only and we surface a
  // banner so the user knows the doc has corrupted history that needs a
  // backend repair before further edits.
  let stepError = $state<StepApplyError | null>(null);
  // Re-render the trash countdown each minute.
  let nowTick = $state(Date.now());
  // Read-only when the server says canEdit=false. When this flips on we
  // also force mode='view' so the toggle reflects reality.
  let canEdit = $derived(permissions?.canEdit ?? true);
  let isOwner = $derived(permissions?.isOwner ?? false);
  let locked = $derived(permissions?.locked ?? false);
  let kind = $state<"doc" | "template">("doc");
  // Current actor id from the bootstrap, forwarded to the share dialog.
  let selfActor = $state<string | null>(null);

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
        onKind: (k) => {
          kind = k;
        },
        onSelfActor: (a) => {
          selfActor = a;
        },
        onStepError: (e) => {
          // Keep the first error — subsequent ones don't add information
          // and would flap the banner.
          if (!stepError) {
            stepError = e;
            mode = "view";
          }
        },
        onInsertImage: () => {
          imageDialogOpen = true;
        },
        onInsertDatasetteEmbed: (sourceId) => {
          embedSource = sourceId;
          embedDialogOpen = true;
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

  function onImageInsert(src: string, alt: string) {
    if (!view) return;
    insertImage(src, alt)(view.state, view.dispatch);
    view.focus();
  }

  function onEmbedInsert(ref: string, mode: string) {
    if (!view) return;
    insertDatasetteEmbed(ref, mode)(view.state, view.dispatch);
    view.focus();
  }

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
  <DocHeader
    {docId}
    {users}
    bind:mode
    {canEdit}
    {isOwner}
    {locked}
    {kind}
    {selfActor}
    docState={docState?.state ?? "active"}
    {copyMarkdown}
  />
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
  {#if stepError}
    <div class="status-banner status-step-error" role="alert">
      Could not apply edit at version {stepError.version}. The doc is shown
      up to the last good edit and is read-only until an admin repairs the
      history.
    </div>
  {/if}
  {#if status.state !== "ok"}
    <div class="status-banner status-{status.state}">{status.message}</div>
  {/if}
  {#if canEdit && mode === "edit"}
    <Toolbar {view} {kind} onInsertImage={() => (imageDialogOpen = true)} />
  {/if}
  <div class="editor-host" bind:this={editorEl}></div>
  <LinksPanel {docId} />
  <ImageDialog bind:open={imageDialogOpen} oninsert={onImageInsert} />
  <DatasetteEmbedDialog
    bind:open={embedDialogOpen}
    source={embedSource}
    oninsert={onEmbedInsert}
  />
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
  /* Distinct from `fail` (which means "we tried and the server said
   * no") — `offline` is informational and self-clearing on reconnect. */
  .status-banner.status-offline {
    background: #e0e7ee;
    color: #2a3a4a;
    border: 1px solid #b8c2cc;
  }
  .status-banner.status-step-error {
    background: #ffd6d6;
    color: #5a0000;
    border: 1px solid #c08080;
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
  /* Keep a large pasted/inserted image from overflowing the document. The
   * image node is inline; constrain to the content width and preserve aspect
   * ratio. ProseMirror's selected-node outline still shows on click. */
  .editor-host :global(.ProseMirror img) {
    max-width: 100%;
    height: auto;
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

  /* paper_link inline atom — rendered by PaperLinkView, resolved live via
   * the LinkResolver. Base looks like a link; modifier classes mute /
   * decorate by resolution state. */
  .editor-host :global(.pm-paper-link) {
    display: inline;
    white-space: nowrap;
    cursor: pointer;
    color: #0b5cad;
    text-decoration: none;
    padding: 0 2px;
    border-radius: 3px;
    background: rgba(11, 92, 173, 0.08);
  }
  .editor-host :global(.pm-paper-link:hover) {
    text-decoration: underline;
  }
  .editor-host :global(.pm-paper-link .pm-paper-link-icon) {
    display: inline-flex;
    align-items: center;
    vertical-align: middle;
    margin-right: 0.25em;
  }
  .editor-host :global(.pm-paper-link .pm-paper-link-icon svg) {
    width: 0.9em;
    height: 0.9em;
  }
  .editor-host :global(.pm-paper-link--loading),
  .editor-host :global(.pm-paper-link--archived),
  .editor-host :global(.pm-paper-link--trashed) {
    color: #888;
    background: rgba(0, 0, 0, 0.05);
  }
  .editor-host :global(.pm-paper-link--denied) {
    color: #888;
    background: rgba(0, 0, 0, 0.05);
    cursor: default;
    text-decoration: none;
  }
  .editor-host :global(.pm-paper-link--missing) {
    color: #888;
    background: rgba(0, 0, 0, 0.05);
    cursor: default;
    text-decoration: line-through;
  }
  /* Cross-access affordances: an amber warning when a named collaborator of
   * this doc can't see the target, and a muted dot hint when the doc's
   * audience can't be fully enumerated. */
  .editor-host :global(.pm-paper-link .pm-paper-link-warn) {
    display: inline;
    margin-left: 0.25em;
    color: #b45309;
    font-size: 0.85em;
    cursor: help;
    text-decoration: none;
  }
  .editor-host :global(.pm-paper-link .pm-paper-link-hint) {
    display: inline;
    margin-left: 0.25em;
    color: #999;
    font-size: 0.85em;
    cursor: help;
    text-decoration: none;
  }

  /* mention inline atom — rendered by MentionView, resolved live via the
   * ActorResolver. A subtle rounded pill carrying the actor's display name
   * (and optional avatar). Non-text-selectable so it acts as one unit. */
  .editor-host :global(.pm-mention) {
    display: inline;
    white-space: nowrap;
    color: #0b5cad;
    padding: 0 4px;
    border-radius: 3px;
    background: rgba(11, 92, 173, 0.1);
    font-weight: 500;
    user-select: none;
  }
  .editor-host :global(.pm-mention--loading) {
    color: #888;
    background: rgba(0, 0, 0, 0.05);
  }
  .editor-host :global(.pm-mention .pm-mention-avatar) {
    display: inline-block;
    width: 0.9em;
    height: 0.9em;
    border-radius: 50%;
    object-fit: cover;
    vertical-align: middle;
    margin-right: 0.25em;
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
  /* Flipped placement when anchoring above the table would land the bar
   * under the sticky page toolbar — see positionAboveTable in
   * tableInsertTooltip.ts. */
  .editor-host :global(.pm-table-tooltip-root.pm-tt-below) {
    transform: translate(-50%, 0);
    margin-top: 6px;
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

  /* Row-drag handle owned by tableRowDragPlugin. The button is hosted
   * on .editor-host (positioned absolutely) and parked at the left edge
   * of whichever table row the cursor is over. transform centers it
   * vertically on the row's mid-line; the handle's right edge sits flush
   * with the row's left border so moving the cursor left from inside
   * the row lands directly on the handle (no dead-zone gap). */
  .editor-host :global(.pm-row-drag-handle) {
    position: absolute;
    transform: translate(-100%, -50%);
    width: 18px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    color: #999;
    cursor: grab;
    padding: 0;
    z-index: 11;
  }
  .editor-host :global(.pm-row-drag-handle:hover) {
    background: #eaeaea;
    color: #333;
  }
  .editor-host :global(.pm-row-drag-handle.pm-row-drag-handle-grabbing) {
    cursor: grabbing;
    background: #d9e7f8;
    color: #0b5cad;
  }
  /* Drop indicator — 2px line spanning the table's row width at the
   * boundary above/below the row currently under the pointer. */
  .editor-host :global(.pm-row-drop-indicator) {
    position: absolute;
    height: 2px;
    background: #0b5cad;
    pointer-events: none;
    z-index: 11;
    transform: translateY(-1px);
  }
  /* Visually fade the source row while it's being dragged so the user
   * can tell which row will move. */
  .editor-host :global(tr.pm-row-dragging) {
    opacity: 0.4;
  }

  /* Link hover tooltip — appears beneath an `<a>` link mark when the
   * mouse hovers it in edit mode. Owned by linkTooltipPlugin. Anchored
   * absolutely to .editor-host (same coordinate space as the table
   * tooltip). z:11 sits above the sticky .paper-toolbar (z:10). */
  .editor-host :global(.pm-link-tooltip-root) {
    position: absolute;
    z-index: 11;
    pointer-events: auto;
  }
  .editor-host :global(.pm-link-tooltip-bar) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: #fff;
    border: 1px solid #d4d4d4;
    border-radius: 6px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    font-size: 12px;
    max-width: 460px;
  }
  .editor-host :global(.pm-link-tooltip-url) {
    color: #0b5cad;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 320px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .editor-host :global(.pm-link-tooltip-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 22px;
    padding: 0 8px;
    border: 1px solid #d4d4d4;
    border-radius: 4px;
    background: #f4f6f8;
    color: #1a1a1a;
    cursor: pointer;
    font: inherit;
    text-decoration: none;
  }
  .editor-host :global(.pm-link-tooltip-btn:hover) {
    background: #e6ebf0;
  }

  /* `[[`-triggered wiki-link autocomplete. */
  .editor-host :global(.pm-wikilink-typing) {
    background: rgba(11, 92, 173, 0.08);
    border-bottom: 1px solid rgba(11, 92, 173, 0.4);
    border-radius: 2px;
  }
  .editor-host :global(.pm-wikilink-popup) {
    position: absolute;
    z-index: 11;
    min-width: 220px;
    max-height: 260px;
    overflow-y: auto;
    background: #fff;
    border: 1px solid #d4d4d4;
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    font-size: 13px;
    padding: 4px 0;
  }
  .editor-host :global(.pm-wikilink-item) {
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .editor-host :global(.pm-wikilink-item:hover) {
    background: #f1f4f7;
  }
  .editor-host :global(.pm-wikilink-item--active) {
    background: #e1ebf7;
  }
  .editor-host :global(.pm-wikilink-empty) {
    padding: 4px 10px;
    color: #888;
    font-style: italic;
  }

  /* `@`-triggered mention autocomplete. Mirrors the `[[` popup. */
  .editor-host :global(.pm-mention-typing) {
    background: rgba(11, 92, 173, 0.08);
    border-bottom: 1px solid rgba(11, 92, 173, 0.4);
    border-radius: 2px;
  }
  .editor-host :global(.pm-mention-popup) {
    position: absolute;
    z-index: 11;
    min-width: 220px;
    max-height: 260px;
    overflow-y: auto;
    background: #fff;
    border: 1px solid #d4d4d4;
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    font-size: 13px;
    padding: 4px 0;
  }
  .editor-host :global(.pm-mention-item) {
    display: flex;
    align-items: center;
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .editor-host :global(.pm-mention-item:hover) {
    background: #f1f4f7;
  }
  .editor-host :global(.pm-mention-item--active) {
    background: #e1ebf7;
  }
  .editor-host :global(.pm-mention-item .pm-mention-avatar) {
    width: 1.1em;
    height: 1.1em;
    border-radius: 50%;
    object-fit: cover;
    margin-right: 0.4em;
    flex: none;
  }
  .editor-host :global(.pm-mention-empty) {
    padding: 4px 10px;
    color: #888;
    font-style: italic;
  }
  .editor-host :global(.pm-mention-typing-hint) {
    padding: 4px 10px;
    color: #999;
    font-size: 0.85em;
    font-style: italic;
    border-top: 1px solid #eee;
  }
  /* Inline #tags — a distinct teal accent so they don't read as
     @mentions (blue) or [[links]]. Rendered by the schema toDOM. */
  .editor-host :global(.pm-tag) {
    display: inline;
    white-space: nowrap;
    color: #0f766e;
    padding: 0 4px;
    border-radius: 3px;
    background: rgba(15, 118, 110, 0.1);
    font-weight: 500;
    user-select: none;
  }
  .editor-host :global(.pm-tag-typing) {
    background: rgba(15, 118, 110, 0.08);
    border-bottom: 1px solid rgba(15, 118, 110, 0.4);
    border-radius: 2px;
  }
  .editor-host :global(.pm-tag-popup) {
    position: absolute;
    z-index: 11;
    min-width: 180px;
    max-height: 260px;
    overflow-y: auto;
    background: #fff;
    border: 1px solid #d4d4d4;
    border-radius: 6px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    font-size: 13px;
    padding: 4px 0;
  }
  .editor-host :global(.pm-tag-item) {
    display: flex;
    align-items: center;
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .editor-host :global(.pm-tag-item:hover) {
    background: #f1f4f7;
  }
  .editor-host :global(.pm-tag-item--active) {
    background: #d8efec;
  }
  .editor-host :global(.pm-tag-create) {
    color: #0f766e;
    font-style: italic;
  }
  .editor-host :global(.pm-tag-empty) {
    padding: 4px 10px;
    color: #888;
    font-style: italic;
  }

  /* Slash command menu — mirrors .pm-tag-popup; z above toolbar + table tooltip. */
  .editor-host :global(.pm-slash-typing) {
    background: rgba(11, 92, 173, 0.08);
    border-radius: 2px;
  }
  .editor-host :global(.pm-slash-menu) {
    position: absolute;
    z-index: 12;
    min-width: 220px;
    max-height: 300px;
    overflow-y: auto;
    background: #fff;
    border: 1px solid #d4d4d4;
    border-radius: 6px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.14);
    font-size: 13px;
    padding: 4px 0;
  }
  .editor-host :global(.pm-slash-item) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .editor-host :global(.pm-slash-item:hover) {
    background: #f1f4f7;
  }
  .editor-host :global(.pm-slash-item--active) {
    background: #e4eefb;
  }
  .editor-host :global(.pm-slash-icon) {
    display: inline-flex;
    color: #555;
  }
  .editor-host :global(.pm-slash-empty) {
    padding: 5px 12px;
    color: #888;
    font-style: italic;
  }

  /* Inline Datasette ref pill — mirrors .pm-paper-link / .pm-mention. */
  .editor-host :global(.pm-inline-embed) {
    display: inline;
    white-space: nowrap;
    cursor: pointer;
    color: #6429a8;
    text-decoration: none;
    padding: 0 4px;
    border-radius: 3px;
    background: rgba(100, 41, 168, 0.1);
    font-weight: 500;
    user-select: none;
  }
  .editor-host :global(.pm-inline-embed:hover) {
    text-decoration: underline;
  }
  .editor-host :global(.pm-inline-embed--loading) {
    opacity: 0.6;
  }
  .editor-host :global(.pm-inline-embed--denied),
  .editor-host :global(.pm-inline-embed--missing) {
    color: #8a8a8a;
    background: rgba(0, 0, 0, 0.05);
    cursor: default;
  }
  .editor-host :global(.pm-inline-embed--missing) {
    text-decoration: line-through;
  }
  .editor-host :global(.pm-inline-embed-icon) {
    display: inline-flex;
    vertical-align: -2px;
    margin-right: 2px;
  }
  /* Clamp icon size: a provider may supply its own raw <svg>, so don't trust
     its width/height attrs to match paper's chrome. */
  .editor-host :global(.pm-inline-embed-icon svg) {
    width: 14px;
    height: 14px;
    display: block;
  }

  /* Block Datasette embed card. */
  .editor-host :global(.pm-block-embed) {
    position: relative;
    margin: 0 0 0.75em;
    border: 1px solid #d4d4d4;
    border-radius: 6px;
    background: #fbfbfd;
    overflow: hidden;
  }
  .editor-host :global(.pm-block-embed.ProseMirror-selectednode) {
    outline: 2px solid #6429a8;
    outline-offset: 1px;
  }
  .editor-host :global(.pm-block-embed-head) {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid #ececf0;
    background: #f4f4f7;
    font-size: 12px;
    color: #555;
  }
  .editor-host :global(.pm-block-embed-icon) {
    display: inline-flex;
    color: #6429a8;
  }
  /* Clamp icon size: a provider-supplied raw <svg> must fit paper's chrome. */
  .editor-host :global(.pm-block-embed-icon svg) {
    width: 14px;
    height: 14px;
    display: block;
  }
  .editor-host :global(.pm-block-embed-label) {
    font-weight: 600;
    color: #333;
  }
  .editor-host :global(.pm-block-embed-label--link) {
    text-decoration: none;
    cursor: pointer;
  }
  .editor-host :global(.pm-block-embed-label--link:hover) {
    color: #6429a8;
    text-decoration: underline;
  }
  .editor-host :global(.pm-block-embed-refresh) {
    margin-left: auto;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #777;
    padding: 2px;
    display: inline-flex;
    border-radius: 4px;
  }
  .editor-host :global(.pm-block-embed-refresh:hover) {
    background: rgba(0, 0, 0, 0.06);
    color: #333;
  }
  .editor-host :global(.pm-block-embed-menu-wrap) {
    position: relative;
    display: inline-flex;
  }
  .editor-host :global(.pm-block-embed-menu-btn) {
    border: none;
    background: transparent;
    cursor: pointer;
    color: #777;
    padding: 2px;
    display: inline-flex;
    border-radius: 4px;
  }
  .editor-host :global(.pm-block-embed-menu-btn:hover) {
    background: rgba(0, 0, 0, 0.06);
    color: #333;
  }
  .editor-host :global(.pm-block-embed-menu) {
    display: none;
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 12;
    min-width: 180px;
    padding: 4px;
    background: #fff;
    border: 1px solid #d4d4d4;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  }
  .editor-host :global(.pm-block-embed-menu--open) {
    display: block;
  }
  .editor-host :global(.pm-block-embed-menu-item) {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    color: #333;
    padding: 6px 8px;
    border-radius: 4px;
  }
  .editor-host :global(.pm-block-embed-menu-item:hover) {
    background: #f1ecf8;
    color: #6429a8;
  }
  .editor-host :global(.pm-block-embed-tables) {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    max-height: 320px;
    overflow: auto;
  }
  .editor-host :global(.pm-block-embed-tables li) {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    font-size: 13px;
  }
  .editor-host :global(.pm-block-embed-table-link) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: #333;
    text-decoration: none;
  }
  .editor-host :global(.pm-block-embed-table-link:hover) {
    color: #6429a8;
    text-decoration: underline;
  }
  .editor-host :global(.pm-block-embed-table-count) {
    margin-left: auto;
    color: #999;
    font-variant-numeric: tabular-nums;
  }
  .editor-host :global(.pm-block-embed-scroll) {
    overflow: auto;
    /* ~10 rows + header before vertical scroll kicks in. */
    max-height: 320px;
  }
  .editor-host :global(.pm-block-embed table) {
    border-collapse: collapse;
    width: 100%;
    font-size: 13px;
  }
  .editor-host :global(.pm-block-embed th),
  .editor-host :global(.pm-block-embed td) {
    border: 1px solid #ececf0;
    padding: 4px 8px;
    text-align: left;
    white-space: nowrap;
  }
  .editor-host :global(.pm-block-embed th) {
    background: #f4f6f8;
    font-weight: 600;
    /* Keep column headers visible while the body scrolls vertically. */
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .editor-host :global(.pm-block-embed-footer) {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    font-size: 12px;
    color: #777;
  }
  .editor-host :global(.pm-block-embed-rows) {
    font: inherit;
    font-size: 12px;
    padding: 0 1px;
    margin: 0 1px;
    vertical-align: baseline;
  }
  .editor-host :global(.pm-block-embed-footer-link),
  .editor-host :global(.pm-block-embed-footer-link:visited) {
    /* Float "open in Datasette" to the right edge of the footer. */
    margin-left: auto;
    color: #6429a8;
    text-decoration: none;
  }
  .editor-host :global(.pm-block-embed-fields) {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 12px;
    margin: 0;
    padding: 10px;
    font-size: 13px;
  }
  .editor-host :global(.pm-block-embed-fields dt) {
    font-weight: 600;
    color: #555;
  }
  .editor-host :global(.pm-block-embed-fields dd) {
    margin: 0;
  }
  .editor-host :global(.pm-block-embed-skeleton),
  .editor-host :global(.pm-block-embed-placeholder) {
    padding: 12px;
    font-size: 13px;
    color: #888;
  }
  .editor-host :global(.pm-block-embed--denied .pm-block-embed-placeholder) {
    color: #8a5a00;
  }
</style>
