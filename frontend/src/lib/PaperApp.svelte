<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { EditorView } from "prosemirror-view";
  import "prosemirror-tables/style/tables.css";
  import "./editor.css";
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
  import Sidebar from "./Sidebar.svelte";
  import type { SourceStore } from "./sourceStore";
  import ImageDialog from "./ImageDialog.svelte";
  import DatasetteEmbedDialog from "./DatasetteEmbedDialog.svelte";
  import type { EmbedKindFilter } from "./slashMenu";
  import CreatePageDialog from "./CreatePageDialog.svelte";
  import { insertImage } from "./image";
  import { youtubeWatchUrl } from "./youtube";
  import { insertDatasetteEmbed } from "./datasetteEmbed";
  import { TOOLBAR_ICONS } from "./icons";

  let { docId }: { docId: string } = $props();

  // Insert dialogs, owned here so there's a single instance each. The toolbar
  // image button and the `/` slash menu both open the image dialog; the embed
  // dialog is opened by the slash menu and context-aware paste.
  let imageDialogOpen = $state(false);
  let embedDialogOpen = $state(false);
  // Which embed source the picker is scoped to: undefined = core Datasette,
  // otherwise a third-party provider source id.
  let embedSource = $state<string | undefined>(undefined);
  // Restricts the core picker to one resource kind ("table" / "database"), set
  // by the `/` menu's split embed commands; undefined = list everything.
  let embedFilter = $state<EmbedKindFilter | undefined>(undefined);
  // Create-page dialog, driven by the `[[`-autocomplete's "Create … page"
  // row. `createResolver` bridges the imperative editor flow (which awaits a
  // doc id) to the declarative dialog: onCreatePage opens it and parks a
  // promise resolver here until the dialog reports a result.
  let createDialogOpen = $state(false);
  let createInitialTitle = $state("");
  let createResolver: ((id: number | null) => void) | null = null;

  let editorEl: HTMLDivElement | undefined = $state(undefined);

  // Floating scroll-to-top affordance for long docs (mobile-primary, but shown
  // at every width and in view mode too). The page scrolls on the window — the
  // app has no bounded-height overflow container — so we watch window scroll.
  let showScrollTop = $state(false);
  $effect(() => {
    const onScroll = () => {
      showScrollTop = window.scrollY > 600;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  });
  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  type StatusObj = { state: ReporterState; message: string };
  let status: StatusObj = $state({ state: "ok", message: "" });
  let view: EditorView | null = $state(null);
  // Per-connection source store, surfaced to the Sources panel for value counts.
  let sourceStore = $state<SourceStore | null>(null);
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
          // Expose the live EditorView for e2e tests and manual debugging.
          // ProseMirror bugs are usually about the *document model* (selection
          // position, node structure) which the rendered DOM hides — read
          // `window.__pmView.state` to see the truth. Intentionally NOT
          // dev-gated: the e2e suite loads the production bundle, so this must
          // survive the prod build. See frontend/e2e/CLAUDE.md.
          (window as unknown as { __pmView: EditorView | null }).__pmView = v;
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
        onInsertDatasetteEmbed: (sourceId, filter) => {
          embedSource = sourceId;
          embedFilter = filter;
          embedDialogOpen = true;
        },
        onCreatePage,
      },
      reporter,
    );
    sourceStore = conn.getSourceStore();

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

  // Open the create-page dialog and resolve once it reports back. The editor
  // (wikiLinkSuggest) awaits this and drops a paper_link to the new id.
  function onCreatePage(title: string): Promise<number | null> {
    return new Promise((resolve) => {
      // Defensive: a still-pending dialog shouldn't strand its promise.
      createResolver?.(null);
      createInitialTitle = title;
      createResolver = resolve;
      createDialogOpen = true;
    });
  }

  function onCreateResult(docId: number | null) {
    const resolve = createResolver;
    createResolver = null;
    resolve?.(docId);
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
          // A lone canonical YouTube URL on its own line — the bare-URL form
          // the backend markdown round-trips (datasette_paper/markdown.py).
          video_embed(state, node) {
            if ((node.attrs.provider ?? "youtube") === "youtube" && node.attrs.videoId) {
              const start = typeof node.attrs.start === "number" ? node.attrs.start : null;
              state.write(youtubeWatchUrl(node.attrs.videoId, start));
            }
            state.closeBlock(node);
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
  <div class="paper-layout">
    <div class="paper-main">
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
    <Toolbar
      {view}
      {kind}
      onInsertImage={() => (imageDialogOpen = true)}
      onInsertEmbed={(sourceId) => {
        embedSource = sourceId;
        embedFilter = undefined;
        embedDialogOpen = true;
      }}
    />
  {/if}
  <div class="editor-host" bind:this={editorEl}></div>
  <ImageDialog bind:open={imageDialogOpen} oninsert={onImageInsert} />
  <DatasetteEmbedDialog
    bind:open={embedDialogOpen}
    source={embedSource}
    filter={embedFilter}
    oninsert={onEmbedInsert}
  />
  <CreatePageDialog
    bind:open={createDialogOpen}
    initialTitle={createInitialTitle}
    onresult={onCreateResult}
  />
    </div>
    <Sidebar {view} {docId} {sourceStore} showSources={canEdit && mode === "edit"} />
  </div>
  {#if showScrollTop}
    <button
      type="button"
      class="scroll-to-top"
      aria-label="Scroll to top"
      title="Scroll to top"
      onclick={scrollToTop}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
        {@html TOOLBAR_ICONS["arrowUpCircle"]}
      </svg>
    </button>
  {/if}
</div>

<style>
  .datasette-paper-app {
    /* The document keeps a comfortable centred 740px reading column at every
     * width; the thin icon rail floats in the right gutter (Sidebar.svelte,
     * fixed) and its flyout overlays the page rather than reflowing it, so the
     * editor never shifts as sections open and close. */
    max-width: 740px;
    margin: 0 auto;
    padding: 0 16px;
    box-sizing: border-box;
  }
  /* <1400px the gutter tightens; reserve a right inset the width of the rail so
   * content never runs under it. ≥1400px the gutter is roomy enough on its own. */
  @media (max-width: 1399.98px) {
    .datasette-paper-app {
      padding-right: 52px;
    }
  }
  /* On phones the rail collapses to a single 3-dot button (Sidebar.svelte), so
   * the 52px reservation above just wastes width — restore the normal inset. */
  @media (max-width: 640px) {
    .datasette-paper-app {
      padding-right: 16px;
    }
  }
  .status-banner {
    padding: 6px 10px;
    font-size: 13px;
    border-radius: 4px;
    margin-bottom: 8px;
  }
  /* deliberate literals: the status-banner family is a set of solid-pastel
     callout identity palettes (amber / red / slate) — each is its own bg+fg(+
     border) triplet with no matching role token (the --pp-danger-bg / --pp-warn-bg
     washes are faint, not these solid fills). #fff8ec below is the one exact
     --pp-warn-bg match. */
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
    background: var(--pp-warn-bg);
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
    background: var(--pp-surface-2);
    color: var(--pp-fg-muted);
    font-size: 12px;
    border-radius: 10px;
    border: 1px solid var(--pp-border);
  }
  /* In fullscreen layout the host gets flex:1; make the ProseMirror
   * surface stretch to fill it instead of capping at min-height: 60vh. */
  .editor-host {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  /* Floating scroll-to-top button. Bottom-right, clear of the top-right icon
   * rail (Sidebar, fixed at top:72px). On phones it lifts above the
   * bottom-pinned toolbar strip so the two never overlap. */
  .scroll-to-top {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 18;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid var(--pp-border);
    border-radius: 50%;
    background: var(--pp-bg);
    color: var(--pp-fg-muted);
    cursor: pointer;
    box-shadow: 0 2px 8px var(--pp-shadow);
  }
  .scroll-to-top:hover {
    background: var(--pp-surface-2);
    color: var(--pp-fg);
  }
  @media (max-width: 640px) {
    /* The toolbar is `position: fixed` at the bottom on phones; reserve room so
     * the last lines of a long doc aren't hidden behind it. */
    .editor-host {
      padding-bottom: calc(52px + env(safe-area-inset-bottom));
    }
    /* Lift the scroll-to-top button above the fixed toolbar strip. */
    .scroll-to-top {
      bottom: calc(60px + env(safe-area-inset-bottom));
    }
  }
</style>
