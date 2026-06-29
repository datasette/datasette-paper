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
  import LinksPanel from "./LinksPanel.svelte";
  import SourcesPanel from "./SourcesPanel.svelte";
  import ImageDialog from "./ImageDialog.svelte";
  import DatasetteEmbedDialog from "./DatasetteEmbedDialog.svelte";
  import CreatePageDialog from "./CreatePageDialog.svelte";
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
  // Create-page dialog, driven by the `[[`-autocomplete's "Create … page"
  // row. `createResolver` bridges the imperative editor flow (which awaits a
  // doc id) to the declarative dialog: onCreatePage opens it and parks a
  // promise resolver here until the dialog reports a result.
  let createDialogOpen = $state(false);
  let createInitialTitle = $state("");
  let createResolver: ((id: number | null) => void) | null = null;

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
        onCreatePage,
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
    <Toolbar
      {view}
      {kind}
      onInsertImage={() => (imageDialogOpen = true)}
      onInsertEmbed={(sourceId) => {
        embedSource = sourceId;
        embedDialogOpen = true;
      }}
    />
  {/if}
  <div class="editor-host" bind:this={editorEl}></div>
  <LinksPanel {docId} />
  {#if canEdit && mode === "edit"}
    <SourcesPanel {view} />
  {/if}
  <ImageDialog bind:open={imageDialogOpen} oninsert={onImageInsert} />
  <DatasetteEmbedDialog
    bind:open={embedDialogOpen}
    source={embedSource}
    oninsert={onEmbedInsert}
  />
  <CreatePageDialog
    bind:open={createDialogOpen}
    initialTitle={createInitialTitle}
    onresult={onCreateResult}
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
</style>
