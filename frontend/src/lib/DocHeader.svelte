<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { client } from "./client";
  import ShareDialog from "./ShareDialog.svelte";

  let {
    docId,
    users,
    mode = $bindable("edit"),
    canEdit = true,
    copyMarkdown,
  }: {
    docId: string;
    users: number;
    mode?: "edit" | "view";
    canEdit?: boolean;
    copyMarkdown?: () => Promise<boolean>;
  } = $props();

  let shareOpen = $state(false);

  type CopyFeedback = "idle" | "copied" | "failed";
  let copyState: CopyFeedback = $state("idle");
  let menuOpen = $state(false);
  let menuRoot: HTMLDivElement | undefined = $state();

  async function handleCopy() {
    menuOpen = false;
    if (!copyMarkdown) return;
    const ok = await copyMarkdown();
    copyState = ok ? "copied" : "failed";
    setTimeout(() => (copyState = "idle"), 1500);
  }

  function openInNewTab(path: string) {
    menuOpen = false;
    window.open(`/-/paper/api/docs/${docId}${path}`, "_blank", "noopener");
  }

  function onDocClick(evt: MouseEvent) {
    if (!menuOpen || !menuRoot) return;
    if (!menuRoot.contains(evt.target as Node)) menuOpen = false;
  }

  function onKey(evt: KeyboardEvent) {
    if (menuOpen && evt.key === "Escape") menuOpen = false;
  }

  $effect(() => {
    if (!menuOpen) return;
    untrack(() => {
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
    });
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  });

  type DocMeta = {
    name: string;
    created_by: string | null;
    updated_at: string;
    current_version: number;
  };

  let meta = $state<DocMeta | null>(null);
  let titleInput = $state("");
  let saving = $state(false);
  let savedRecently = $state(false);

  async function load() {
    // The bootstrap envelope returns doc state; the doc row's metadata
    // (name, created_by, updated_at) lives on the per-doc API. We fetch
    // it via the docs list, filtered by id.
    const { data, error } = await client.GET("/-/paper/api/docs");
    if (error || !data) return;
    const found = (data as unknown as Array<DocMeta & { id: number }>).find(
      (r) => String(r.id) === String(docId),
    );
    if (found) {
      meta = found;
      titleInput = found.name;
    }
  }

  async function commitTitle() {
    if (!meta || saving) return;
    const next = titleInput.trim();
    if (!next || next === meta.name) {
      titleInput = meta.name;
      return;
    }
    saving = true;
    const resp = await fetch(`/-/paper/api/docs/${docId}/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: next }),
    });
    saving = false;
    if (!resp.ok) {
      titleInput = meta.name;
      return;
    }
    const updated = await resp.json();
    meta = { ...meta, name: updated.name, updated_at: updated.updated_at };
    savedRecently = true;
    setTimeout(() => (savedRecently = false), 1500);
  }

  function relativeTime(iso: string): string {
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    if (diff < 60_000) return "just now";
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return new Date(t).toLocaleDateString();
  }

  onMount(load);
</script>

<header class="doc-header">
  {#if meta}
    <div class="title-row">
      <a class="doc-icon-link" href="/-/paper" aria-label="Back to all papers" title="Back to all papers">
        <!-- bootstrap-icons/file-text-fill — kept in sync with PAPER_ICON_SVG in datasette_paper/__init__.py -->
        <svg
          class="doc-icon"
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          fill="currentColor"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path d="M12 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2M5 4h6a.5.5 0 0 1 0 1H5a.5.5 0 0 1 0-1m-.5 2.5A.5.5 0 0 1 5 6h6a.5.5 0 0 1 0 1H5a.5.5 0 0 1-.5-.5M5 8h6a.5.5 0 0 1 0 1H5a.5.5 0 0 1 0-1m0 2h3a.5.5 0 0 1 0 1H5a.5.5 0 0 1 0-1"/>
        </svg>
      </a>
      <input
        class="title"
        type="text"
        bind:value={titleInput}
        onblur={commitTitle}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        aria-label="Document title"
        disabled={saving}
      />
    </div>
    <div class="meta">
      <span class="created-by">
        {#if meta.created_by}
          by <strong>{meta.created_by}</strong>
        {:else}
          anonymous
        {/if}
      </span>
      <span aria-hidden="true">·</span>
      <span class="updated-at" title={meta.updated_at}>
        edited {relativeTime(meta.updated_at)}
      </span>
      <span aria-hidden="true">·</span>
      <span class="users">
        {users} {users === 1 ? "user" : "users"} online
      </span>
      {#if savedRecently}
        <span class="saved" aria-live="polite">✓ saved</span>
      {/if}
      <span class="meta-actions">
        {#if canEdit}
          <button
            type="button"
            class="share-btn"
            onclick={() => (shareOpen = true)}
          >
            Share
          </button>
        {/if}
        {#if copyState !== "idle"}
          <span
            class="copy-feedback"
            class:copied={copyState === "copied"}
            class:failed={copyState === "failed"}
            aria-live="polite"
          >
            {copyState === "copied" ? "✓ Copied" : "✗ Failed"}
          </span>
        {/if}
        <span
          class="mode-slider"
          role="group"
          aria-label="Editor mode"
        >
          <button
            type="button"
            class="seg"
            class:active={mode === "edit"}
            aria-pressed={mode === "edit"}
            disabled={!canEdit}
            title={canEdit ? "Edit" : "Read-only — you don't have edit access"}
            onclick={() => (mode = "edit")}
          >
            Edit
          </button>
          <button
            type="button"
            class="seg"
            class:active={mode === "view"}
            aria-pressed={mode === "view"}
            onclick={() => (mode = "view")}
          >
            View
          </button>
        </span>
        <div class="overflow-wrap" bind:this={menuRoot}>
          <button
            type="button"
            class="overflow-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More actions"
            title="More actions"
            onclick={() => (menuOpen = !menuOpen)}
          >
            <!-- bootstrap-icons/three-dots -->
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path fill="currentColor" d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3"/>
            </svg>
          </button>
          {#if menuOpen}
            <div class="overflow-menu" role="menu">
              {#if copyMarkdown}
                <button type="button" role="menuitem" onclick={handleCopy}>
                  Copy as markdown
                </button>
              {/if}
              <button
                type="button"
                role="menuitem"
                onclick={() => openInNewTab("/document")}
              >
                Open API URL
              </button>
              <button
                type="button"
                role="menuitem"
                onclick={() => openInNewTab("/tasks")}
              >
                Open TODOs API URL
              </button>
            </div>
          {/if}
        </div>
      </span>
    </div>
  {:else}
    <div class="loading">Loading…</div>
  {/if}
</header>

<ShareDialog {docId} bind:open={shareOpen} />

<style>
  .doc-header {
    padding: 12px 4px;
    margin-bottom: 8px;
    border-bottom: 1px solid #eee;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .doc-icon-link {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    color: #276890;
    text-decoration: none;
    border-radius: 4px;
  }
  .doc-icon-link:hover {
    color: #0b5cad;
  }
  .doc-icon-link:focus-visible {
    outline: 2px solid #4a9eff;
    outline-offset: 2px;
  }
  .doc-icon {
    display: block;
  }
  .title {
    flex: 1;
    font-size: 22px;
    font-weight: 600;
    border: 1px solid transparent;
    background: transparent;
    padding: 4px 6px;
    width: 100%;
    box-sizing: border-box;
    border-radius: 4px;
  }
  .title:hover {
    border-color: #e0e0e0;
  }
  .title:focus {
    outline: none;
    border-color: #4a9eff;
    background: #fff;
  }
  .meta {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 4px;
    padding: 0 6px;
    font-size: 12px;
    color: #666;
  }
  .saved {
    color: #2a8a2a;
  }
  .meta-actions {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .copy-feedback {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 999px;
  }
  .copy-feedback.copied {
    background: #e1f5e2;
    color: #1f7a2a;
  }
  .copy-feedback.failed {
    background: #ffd6d6;
    color: #5a0000;
  }

  .share-btn {
    padding: 3px 12px;
    font-size: 12px;
    line-height: 1.4;
    border: 1px solid #0b5cad;
    background: #0b5cad;
    color: #fff;
    border-radius: 999px;
    cursor: pointer;
  }
  .share-btn:hover {
    background: #094a8b;
    border-color: #094a8b;
  }

  /* Segmented Edit/View slider */
  .mode-slider {
    display: inline-flex;
    border: 1px solid #d0d7de;
    background: #f6f8fa;
    border-radius: 999px;
    padding: 2px;
    gap: 0;
  }
  .seg {
    padding: 2px 12px;
    font-size: 12px;
    line-height: 1.4;
    border: none;
    background: transparent;
    color: #555;
    border-radius: 999px;
    cursor: pointer;
  }
  .seg:hover:not(.active) {
    color: #222;
  }
  .seg.active {
    background: #fff;
    color: #0b5cad;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }
  .seg:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .seg:disabled:hover {
    color: #555;
  }

  /* Overflow menu */
  .overflow-wrap {
    position: relative;
  }
  .overflow-btn {
    width: 28px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #d0d7de;
    background: #f6f8fa;
    color: #444;
    border-radius: 999px;
    cursor: pointer;
    padding: 0;
  }
  .overflow-btn:hover {
    background: #ebeef1;
  }
  .overflow-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    min-width: 180px;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 8px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
    padding: 4px;
    z-index: 20;
    display: flex;
    flex-direction: column;
  }
  .overflow-menu button {
    text-align: left;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-size: 13px;
    color: #222;
    cursor: pointer;
    white-space: nowrap;
  }
  .overflow-menu button:hover {
    background: #f0f3f6;
  }

  .loading {
    padding: 6px;
    color: #888;
    font-size: 13px;
  }
</style>
