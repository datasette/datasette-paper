<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { client } from "./client";
  // Importing the bundle is unnecessary here: datasette-acl-share's JS is included
  // on the doc page by paper's extra_js_urls hook, which registers the
  // <datasette-acl-share-dialog> custom element before this component mounts.
  import { TOOLBAR_ICONS, type ToolbarIconName } from "./icons";

  // acl resource identity for a paper doc: type "paper-doc", a fixed parent
  // sentinel ("_paper", == PAPER_DOCS_PARENT in permissions.py), child = doc id.
  const SHARE_RESOURCE_TYPE = "paper-doc";
  const SHARE_PARENT = "_paper";

  let {
    docId,
    users,
    mode = $bindable("edit"),
    canEdit = true,
    isOwner = false,
    docState = "active",
    locked = false,
    kind = "doc",
    selfActor = null,
    copyMarkdown,
  }: {
    docId: string;
    users: number;
    mode?: "edit" | "view";
    canEdit?: boolean;
    isOwner?: boolean;
    docState?: "active" | "archived" | "trashed";
    locked?: boolean;
    kind?: "doc" | "template";
    selfActor?: string | null;
    copyMarkdown?: () => Promise<boolean>;
  } = $props();

  // actor-json the dialog reads to mark the current user's row "(you)".
  let actorJson = $derived(selfActor ? JSON.stringify({ id: selfActor }) : "");

  // A revoke/grant in the dialog mutates acl directly; ask paper to sweep any
  // open SSE subscribers whose access just changed so a demoted/removed editor
  // gets disconnected (revoke_unauthorized on the server). Fire-and-forget —
  // the sweep is best-effort and the dialog has already persisted the change.
  async function sweepSubscribers() {
    try {
      await fetch(`/-/paper/api/docs/${docId}/sweep-subscribers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      // best-effort; subscribers re-check on their next bootstrap anyway.
    }
  }

  // Attachment: wire the share dialog's bubbling `share-changed` event, which
  // the element fires after any grant/update/revoke. It drives the SSE sweep so
  // a removed or demoted editor gets disconnected: a plain revoke and an
  // Editor→Viewer downgrade both reduce access, and `share-changed` covers both
  // (the narrower `share-revoked` would miss the downgrade). The event bubbles +
  // is composed, so listening on the element catches it.
  function shareEvents(node: HTMLElement) {
    const onChanged = () => void sweepSubscribers();
    node.addEventListener("share-changed", onChanged);
    return () => {
      node.removeEventListener("share-changed", onChanged);
    };
  }

  type CopyFeedback = "idle" | "copied" | "failed";
  let copyState: CopyFeedback = $state("idle");
  let menuOpen = $state(false);
  let apiSubOpen = $state(false);
  let menuRoot: HTMLDivElement | undefined = $state();

  function closeMenu() {
    menuOpen = false;
    apiSubOpen = false;
  }

  async function handleCopy() {
    closeMenu();
    if (!copyMarkdown) return;
    const ok = await copyMarkdown();
    copyState = ok ? "copied" : "failed";
    setTimeout(() => (copyState = "idle"), 1500);
  }

  function openInNewTab(path: string) {
    closeMenu();
    window.open(`/-/paper/api/docs/${docId}${path}`, "_blank", "noopener");
  }

  async function postTemplateAction(path: "/make_template" | "/unmake_template") {
    closeMenu();
    const url = `/-/paper/api/docs/${docId}${path}` as
      | "/-/paper/api/docs/{doc_id}/make_template"
      | "/-/paper/api/docs/{doc_id}/unmake_template";
    const { error: err, data } = await client.POST(url, {
      params: { path: { doc_id: Number(docId) } },
    });
    if (err) {
      window.alert(
        `Failed to ${path === "/make_template" ? "promote" : "demote"} this paper.`,
      );
      return;
    }
    // No SSE broadcast for kind changes (it doesn't affect live editors
    // — they keep editing as normal); reload so the badge picks up the
    // new kind value.
    if (data && (data as { kind?: string }).kind) window.location.reload();
  }

  async function postLockAction(path: "/lock" | "/unlock") {
    closeMenu();
    const url = `/-/paper/api/docs/${docId}${path}` as
      | "/-/paper/api/docs/{doc_id}/lock"
      | "/-/paper/api/docs/{doc_id}/unlock";
    const { error: err } = await client.POST(url, {
      params: { path: { doc_id: Number(docId) } },
    });
    if (err) {
      window.alert(`Failed to ${path === "/lock" ? "lock" : "unlock"} this paper.`);
    }
    // On success the permissions-changed SSE refreshes canEdit + locked;
    // no local override needed.
  }

  async function postStateAction(path: "/archive" | "/trash") {
    closeMenu();
    const label = path === "/archive" ? "archive" : "trash";
    const question =
      path === "/archive"
        ? `Archive "${meta?.name ?? "this paper"}"?`
        : `Move "${meta?.name ?? "this paper"}" to the trash? It auto-deletes in 7 days unless restored.`;
    if (!window.confirm(question)) return;
    const url = `/-/paper/api/docs/${docId}${path}` as
      | "/-/paper/api/docs/{doc_id}/archive"
      | "/-/paper/api/docs/{doc_id}/trash";
    const { error: err } = await client.POST(url, {
      params: { path: { doc_id: Number(docId) } },
    });
    if (err) {
      window.alert(`Failed to ${label} this paper.`);
    }
    // On success the state-changed SSE updates docState; no local
    // override needed.
  }

  function onDocClick(evt: MouseEvent) {
    if (!menuOpen || !menuRoot) return;
    if (!menuRoot.contains(evt.target as Node)) closeMenu();
  }

  function onKey(evt: KeyboardEvent) {
    if (!menuOpen || evt.key !== "Escape") return;
    if (apiSubOpen) apiSubOpen = false;
    else menuOpen = false;
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
    created_by_name: string | null;
    created_by_avatar: string | null;
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
    // via the docs list with kind=all so the row is reachable whether
    // this paper is a regular doc or a template — the default kind=doc
    // filter would silently exclude templates and leave the header
    // stuck in "Loading…".
    const { data, error } = await client.GET("/-/paper/api/docs", {
      params: { query: { kind: "all" } as never },
    });
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
    const { data, error: err } = await client.POST(
      "/-/paper/api/docs/{doc_id}/rename",
      {
        params: { path: { doc_id: Number(docId) } },
        body: { name: next } as never,
      },
    );
    saving = false;
    if (err || !data) {
      titleInput = meta.name;
      return;
    }
    const updated = data as { name: string; updated_at: string };
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
      {#if kind === "template"}
        <span
          class="template-pill"
          title="This paper is a template — placeholders are resolved when somebody creates from it"
        >
          Template
        </span>
      {/if}
      {#if locked}
        <span class="locked-pill" title="Read-only — only the owner can unlock">
          {@render icon("lock")}
          <span>Locked</span>
        </span>
      {/if}
    </div>
    <div class="meta">
      <span class="created-by">
        {#if meta.created_by}
          by
          {#if meta.created_by_avatar}
            <img
              class="creator-avatar"
              src={meta.created_by_avatar}
              alt=""
              onerror={(e) =>
                ((e.currentTarget as HTMLImageElement).style.display = "none")}
            />
          {/if}
          <strong title={meta.created_by}
            >{meta.created_by_name ?? meta.created_by}</strong
          >
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
        <!-- The <datasette-acl-share-dialog> custom element renders its own
             share-icon trigger button and a native <dialog> modal; paper only
             feeds it the acl resource identity + current actor and listens for
             `share-changed` to run its SSE subscriber sweep. The element
             degrades to a read-only "who has access" view when the actor can't
             manage, so it is shown to every viewer (not gated on canManage). -->
        <datasette-acl-share-dialog
          resource-type={SHARE_RESOURCE_TYPE}
          parent={SHARE_PARENT}
          child={docId}
          resource-label={meta?.name ?? ""}
          actor-json={actorJson}
          trigger-label="Share"
          {@attach shareEvents}
        ></datasette-acl-share-dialog>
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
                <button
                  type="button"
                  role="menuitem"
                  class="mi"
                  onclick={handleCopy}
                  onmouseenter={() => (apiSubOpen = false)}
                >
                  {@render icon("copy")}
                  <span>Copy as markdown</span>
                </button>
              {/if}
              <div
                class="sub-wrap"
                role="none"
                onmouseenter={() => (apiSubOpen = true)}
              >
                <button
                  type="button"
                  role="menuitem"
                  class="mi"
                  aria-haspopup="menu"
                  aria-expanded={apiSubOpen}
                  onclick={() => (apiSubOpen = !apiSubOpen)}
                >
                  {@render icon("braces")}
                  <span>Open API URL</span>
                  <span class="mi-caret">{@render icon("chevronRight")}</span>
                </button>
                {#if apiSubOpen}
                  <div class="overflow-menu submenu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      class="mi"
                      onclick={() => openInNewTab("/document")}
                    >
                      {@render icon("fileText")}
                      <span>Document</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="mi"
                      onclick={() => openInNewTab("/tasks")}
                    >
                      {@render icon("taskList")}
                      <span>TODOs</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      class="mi"
                      onclick={() => openInNewTab("/tables")}
                    >
                      {@render icon("table")}
                      <span>Tables</span>
                    </button>
                  </div>
                {/if}
              </div>
              {#if isOwner && docState !== "trashed"}
                <hr class="mi-sep" />
                {#if kind === "template"}
                  <button
                    type="button"
                    role="menuitem"
                    class="mi"
                    onclick={() => postTemplateAction("/unmake_template")}
                    onmouseenter={() => (apiSubOpen = false)}
                  >
                    {@render icon("fileText")}
                    <span>Demote to doc</span>
                  </button>
                {:else}
                  <button
                    type="button"
                    role="menuitem"
                    class="mi"
                    onclick={() => postTemplateAction("/make_template")}
                    onmouseenter={() => (apiSubOpen = false)}
                  >
                    {@render icon("copy")}
                    <span>Make template</span>
                  </button>
                {/if}
                <hr class="mi-sep" />
                {#if locked}
                  <button
                    type="button"
                    role="menuitem"
                    class="mi"
                    onclick={() => postLockAction("/unlock")}
                    onmouseenter={() => (apiSubOpen = false)}
                  >
                    {@render icon("unlock")}
                    <span>Unlock (make editable)</span>
                  </button>
                {:else}
                  <button
                    type="button"
                    role="menuitem"
                    class="mi"
                    onclick={() => postLockAction("/lock")}
                    onmouseenter={() => (apiSubOpen = false)}
                  >
                    {@render icon("lock")}
                    <span>Lock (read-only)</span>
                  </button>
                {/if}
                <hr class="mi-sep" />
                <div class="mi-section" role="presentation">Danger zone</div>
                {#if docState === "active"}
                  <button
                    type="button"
                    role="menuitem"
                    class="mi"
                    onclick={() => postStateAction("/archive")}
                    onmouseenter={() => (apiSubOpen = false)}
                  >
                    {@render icon("archive")}
                    <span>Archive</span>
                  </button>
                {/if}
                <button
                  type="button"
                  role="menuitem"
                  class="mi mi-danger"
                  onclick={() => postStateAction("/trash")}
                  onmouseenter={() => (apiSubOpen = false)}
                >
                  {@render icon("trash3")}
                  <span>Move to trash</span>
                </button>
              {/if}
            </div>
          {/if}
        </div>
      </span>
    </div>
  {:else}
    <div class="loading">Loading…</div>
  {/if}
</header>

{#snippet icon(name: ToolbarIconName)}
  <svg
    class="mi-icon"
    xmlns="http://www.w3.org/2000/svg"
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
    {@html TOOLBAR_ICONS[name]}
  </svg>
{/snippet}

<style>
  .doc-header {
    padding: 12px 4px;
    margin-bottom: 8px;
    border-bottom: 1px solid var(--pp-border);
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
    /* deliberate literal: a deliberately desaturated blue, not --pp-accent. */
    color: #276890;
    text-decoration: none;
    border-radius: 4px;
  }
  .doc-icon-link:hover {
    color: var(--pp-accent);
  }
  .doc-icon-link:focus-visible {
    /* deliberate literal: sky-blue focus ring, distinct from the darker
       --pp-focus-ring brand blue. */
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
    border-color: var(--pp-border);
  }
  .title:focus {
    outline: none;
    /* deliberate literal: sky-blue focus border, distinct from --pp-focus-ring. */
    border-color: #4a9eff;
    background: var(--pp-bg);
  }
  .meta {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 4px;
    padding: 0 6px;
    font-size: 12px;
    color: var(--pp-fg-muted);
  }
  .created-by {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .creator-avatar {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
  }
  /* deliberate literal: one-off success green — no "success" role token. */
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
  /* deliberate literals: one-off success-green and error-box pink/maroon pills,
     each its own palette with no matching role token. */
  .copy-feedback.copied {
    background: #e1f5e2;
    color: #1f7a2a;
  }
  .copy-feedback.failed {
    background: #ffd6d6;
    color: #5a0000;
  }

  /* Restyle the <datasette-acl-share-dialog> trigger button (light DOM, so its
     class is reachable) into paper's blue toolbar pill. The descendant selector
     under .meta-actions outranks acl-share's own bundled trigger CSS regardless
     of stylesheet order. The dialog/modal itself keeps acl-share's styling. */
  .meta-actions :global(.datasette-acl-share__trigger.has-label) {
    padding: 3px 12px;
    font-size: 12px;
    line-height: 1.4;
    border: 1px solid var(--pp-accent);
    background: var(--pp-accent);
    color: var(--pp-accent-fg);
    border-radius: 999px;
    cursor: pointer;
  }
  /* deliberate literal: hover-darken of --pp-accent, no dedicated hover token. */
  .meta-actions :global(.datasette-acl-share__trigger.has-label:hover) {
    background: #094a8b;
    border-color: #094a8b;
  }
  .meta-actions :global(.datasette-acl-share__trigger-text) {
    font-size: 12px;
  }

  /* Segmented Edit/View slider */
  .mode-slider {
    display: inline-flex;
    border: 1px solid var(--pp-border);
    background: var(--pp-surface-2);
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
    color: var(--pp-fg-muted);
    border-radius: 999px;
    cursor: pointer;
  }
  .seg:hover:not(.active) {
    color: var(--pp-fg);
  }
  .seg.active {
    background: var(--pp-bg);
    color: var(--pp-accent);
    box-shadow: 0 1px 2px var(--pp-shadow);
  }
  .seg:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .seg:disabled:hover {
    color: var(--pp-fg-muted);
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
    border: 1px solid var(--pp-border);
    background: var(--pp-surface);
    color: var(--pp-fg-muted);
    border-radius: 999px;
    cursor: pointer;
    padding: 0;
  }
  .overflow-btn:hover {
    background: var(--pp-surface-2);
  }
  .overflow-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    min-width: 200px;
    background: var(--pp-bg);
    border: 1px solid var(--pp-border);
    border-radius: 8px;
    box-shadow: 0 4px 14px var(--pp-shadow);
    padding: 4px;
    z-index: 20;
    display: flex;
    flex-direction: column;
  }
  .mi {
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-size: 13px;
    color: var(--pp-fg);
    cursor: pointer;
    white-space: nowrap;
    width: 100%;
  }
  .mi:hover {
    background: var(--pp-surface-2);
  }
  .mi-icon {
    flex: 0 0 auto;
    color: var(--pp-fg-muted);
  }
  .mi-caret {
    margin-left: auto;
    display: inline-flex;
    color: var(--pp-fg-subtle);
  }
  .mi-sep {
    border: none;
    border-top: 1px solid var(--pp-border);
    margin: 4px 0;
  }
  .mi-section {
    padding: 4px 10px 2px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--pp-fg-subtle);
  }
  /* deliberate literals: one-off crimson danger text + its faint hover wash,
     distinct from --pp-danger / --pp-danger-bg. */
  .mi-danger {
    color: #a40e26;
  }
  .mi-danger .mi-icon {
    color: #a40e26;
  }
  .mi-danger:hover {
    background: #fdecef;
  }
  .sub-wrap {
    position: relative;
  }
  .submenu {
    top: -4px;
    right: calc(100% + 4px);
    left: auto;
    min-width: 160px;
  }

  .loading {
    padding: 6px;
    color: var(--pp-fg-subtle);
    font-size: 13px;
  }
  .locked-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 6px;
    padding: 2px 9px 2px 7px;
    background: var(--pp-surface-2);
    color: var(--pp-fg-muted);
    border: 1px solid var(--pp-border);
    border-radius: 999px;
    font-size: 11px;
    line-height: 1.5;
    font-weight: 600;
  }
  .locked-pill :global(.mi-icon) {
    color: inherit;
  }
  .template-pill {
    display: inline-flex;
    margin-left: 6px;
    padding: 2px 10px;
    /* deliberate literals: the template pill's own pastel-blue identity palette
       (light-blue fill / deep-navy text / blue border), distinct from the
       neutral + accent tokens. */
    background: #e6f0ff;
    color: #0b3b8a;
    border: 1px solid #b9d0f5;
    border-radius: 999px;
    font-size: 11px;
    line-height: 1.5;
    font-weight: 600;
  }

  /* On phones the single meta row (by · edited · users · Share/Edit/View · ⋯)
   * has nowhere near the width it needs, so the text columns collapse and wrap
   * mid-phrase ("edited / 1h / ago"). Let the row wrap, keep each phrase intact,
   * and drop the action buttons onto their own full-width line below. */
  @media (max-width: 640px) {
    .meta {
      flex-wrap: wrap;
      row-gap: 4px;
    }
    .created-by,
    .updated-at,
    .users {
      white-space: nowrap;
    }
    .meta-actions {
      margin-left: 0;
      flex-basis: 100%;
      margin-top: 6px;
      flex-wrap: wrap;
      row-gap: 6px;
    }
  }

  /* --- Dark theme (append-only; the light rules above are untouched, so light
     pixels can't change). Each override is written twice: for the explicit
     `[data-theme="dark"]` choice and, in the media query, for the "system"/unset
     case that follows the OS. `:global(...)` keeps the component scope hash on
     the descendant class. The .title input had NO explicit color, so it fell to
     the browser default (near-black) and vanished on dark — the biggest fix
     here. --- */
  :global([data-theme="dark"]) .title {
    color: var(--pp-fg);
  }
  :global([data-theme="dark"]) .doc-icon-link {
    color: #6cb0ff;
  }
  :global([data-theme="dark"]) .saved {
    color: #7ee787;
  }
  :global([data-theme="dark"]) .copy-feedback.copied {
    background: rgba(63, 185, 80, 0.15);
    color: #7ee787;
  }
  :global([data-theme="dark"]) .copy-feedback.failed {
    background: #3a1d1d;
    color: #ffb4ab;
  }
  :global([data-theme="dark"]) .mi-danger,
  :global([data-theme="dark"]) .mi-danger .mi-icon {
    color: #ff7b72;
  }
  :global([data-theme="dark"]) .mi-danger:hover {
    background: rgba(248, 81, 73, 0.15);
  }
  :global([data-theme="dark"]) .template-pill {
    background: #182a44;
    color: #9dc3ff;
    border-color: #2f4d78;
  }
  :global([data-theme="dark"])
    .meta-actions
    :global(.datasette-acl-share__trigger.has-label:hover) {
    background: #6cb0ff;
    border-color: #6cb0ff;
  }
  @media (prefers-color-scheme: dark) {
    :global(:is([data-theme="system"], :root:not([data-theme]))) .title {
      color: var(--pp-fg);
    }
    :global(:is([data-theme="system"], :root:not([data-theme]))) .doc-icon-link {
      color: #6cb0ff;
    }
    :global(:is([data-theme="system"], :root:not([data-theme]))) .saved {
      color: #7ee787;
    }
    :global(:is([data-theme="system"], :root:not([data-theme])))
      .copy-feedback.copied {
      background: rgba(63, 185, 80, 0.15);
      color: #7ee787;
    }
    :global(:is([data-theme="system"], :root:not([data-theme])))
      .copy-feedback.failed {
      background: #3a1d1d;
      color: #ffb4ab;
    }
    :global(:is([data-theme="system"], :root:not([data-theme]))) .mi-danger,
    :global(:is([data-theme="system"], :root:not([data-theme]))) .mi-danger .mi-icon {
      color: #ff7b72;
    }
    :global(:is([data-theme="system"], :root:not([data-theme]))) .mi-danger:hover {
      background: rgba(248, 81, 73, 0.15);
    }
    :global(:is([data-theme="system"], :root:not([data-theme]))) .template-pill {
      background: #182a44;
      color: #9dc3ff;
      border-color: #2f4d78;
    }
    :global(:is([data-theme="system"], :root:not([data-theme])))
      .meta-actions
      :global(.datasette-acl-share__trigger.has-label:hover) {
      background: #6cb0ff;
      border-color: #6cb0ff;
    }
  }
</style>
