<script lang="ts">
  import { onMount } from "svelte";
  import { client } from "./client";

  type DocState = "active" | "archived" | "trashed";

  type DocRow = {
    id: number;
    name: string;
    current_version: number;
    updated_at: string;
    created_by: string | null;
    created_by_name: string | null;
    created_by_avatar: string | null;
    visibility: string;
    is_owner: boolean;
    state: DocState;
    archived_at: string | null;
    trashed_at: string | null;
    delete_at: string | null;
    kind: "doc" | "template";
    locked: boolean;
  };

  // Lazy per-tab caches. `null` means "not fetched yet"; switching tabs
  // triggers a fetch on first activation. We refetch a tab after each
  // mutation that lands on it.
  let active = $state<DocRow[] | null>(null);
  let archived = $state<DocRow[] | null>(null);
  let trashed = $state<DocRow[] | null>(null);
  // Templates are a separate tab — kept in a flat cache keyed by tab
  // name in addition to the lifecycle tabs. They use the same DocRow
  // shape (templates are real papers with kind='template').
  let templates = $state<DocRow[] | null>(null);

  type IndexTab = DocState | "templates";

  let tab = $state<IndexTab>("active");
  let loading = $state(false);
  let error = $state<string | null>(null);
  let newName = $state("");
  let creating = $state(false);
  // Template picker on the New paper form. Empty string means "blank".
  let newTemplateId = $state<string>("");
  // Per-row mutation in flight (keyed by `${state}:${id}`) so we can
  // disable just that row's buttons rather than the whole tab.
  let busyKey = $state<string | null>(null);
  // Which row's overflow menu is open, keyed the same way as busyKey.
  let openMenuKey = $state<string | null>(null);

  // Each minute, recompute relative-time + "deletes in N days" labels by
  // bumping a timestamp the derived helpers read. Cheap; one tick across
  // the visible list.
  let nowTick = $state(Date.now());
  let nowTimer: ReturnType<typeof setInterval> | undefined;

  function bucket(t: IndexTab): DocRow[] | null {
    if (t === "active") return active;
    if (t === "archived") return archived;
    if (t === "trashed") return trashed;
    return templates;
  }

  function setBucket(t: IndexTab, rows: DocRow[]): void {
    if (t === "active") active = rows;
    else if (t === "archived") archived = rows;
    else if (t === "trashed") trashed = rows;
    else templates = rows;
  }

  function invalidateBucket(t: IndexTab): void {
    if (t === "active") active = null;
    else if (t === "archived") archived = null;
    else if (t === "trashed") trashed = null;
    else templates = null;
  }

  async function loadTab(target: IndexTab): Promise<void> {
    loading = true;
    error = null;
    // Templates tab queries the kind=template variant; the other tabs
    // filter by lifecycle state and stick with the default kind=doc.
    const query =
      target === "templates"
        ? { kind: "template" }
        : { state: target };
    const { data, error: err } = await client.GET("/-/paper/api/docs", {
      params: { query: query as never },
    });
    loading = false;
    if (err || !data) {
      error = "Failed to load papers";
      return;
    }
    setBucket(target, data as unknown as DocRow[]);
  }

  function selectTab(target: IndexTab): void {
    tab = target;
    if (bucket(target) === null) void loadTab(target);
  }

  async function create(e: Event) {
    e.preventDefault();
    if (!newName.trim() || creating) return;
    creating = true;
    error = null;
    // Default-blank: empty select → no template_id in the payload.
    // Pick a template → server clones it as the seed snapshot.
    const body: Record<string, unknown> = { name: newName.trim() };
    if (newTemplateId !== "") body.template_id = Number(newTemplateId);
    const { data, error: err } = await client.POST("/-/paper/api/docs", {
      body: body as never,
    });
    creating = false;
    if (err || !data) {
      error = "Failed to create paper";
      return;
    }
    const created = data as unknown as DocRow;
    window.location.href = `/-/paper/doc/${created.id}`;
  }

  async function makeTemplate(doc: DocRow) {
    return mutate(doc, "/make_template", ["active", "archived", "templates"]);
  }

  async function unmakeTemplate(doc: DocRow) {
    return mutate(doc, "/unmake_template", ["active", "archived", "templates"]);
  }

  async function mutate(
    doc: DocRow,
    path:
      | "/archive"
      | "/unarchive"
      | "/trash"
      | "/restore"
      | "/lock"
      | "/unlock"
      | "/make_template"
      | "/unmake_template",
    refetch: IndexTab[],
  ): Promise<void> {
    const key = `${doc.state}:${doc.id}`;
    if (busyKey) return;
    busyKey = key;
    error = null;
    try {
      const url = `/-/paper/api/docs/${doc.id}${path}` as
        | "/-/paper/api/docs/{doc_id}/archive"
        | "/-/paper/api/docs/{doc_id}/unarchive"
        | "/-/paper/api/docs/{doc_id}/trash"
        | "/-/paper/api/docs/{doc_id}/restore"
        | "/-/paper/api/docs/{doc_id}/lock"
        | "/-/paper/api/docs/{doc_id}/unlock"
        | "/-/paper/api/docs/{doc_id}/make_template"
        | "/-/paper/api/docs/{doc_id}/unmake_template";
      const { error: err } = await client.POST(url, {
        params: { path: { doc_id: doc.id } },
      });
      if (err) {
        error = "Action failed";
        return;
      }
      // Invalidate the affected tabs so they refetch on next view, and
      // refresh whichever one is currently visible immediately.
      for (const t of refetch) {
        if (t === tab) {
          await loadTab(t);
        } else {
          invalidateBucket(t);
        }
      }
    } finally {
      busyKey = null;
    }
  }

  function archiveRow(d: DocRow) {
    return mutate(d, "/archive", ["active", "archived"]);
  }

  function unarchiveRow(d: DocRow) {
    return mutate(d, "/unarchive", ["active", "archived"]);
  }

  function trashRow(d: DocRow) {
    if (
      !window.confirm(
        `Move "${d.name}" to the trash? It auto-deletes in 7 days unless restored.`,
      )
    ) {
      return Promise.resolve();
    }
    return mutate(d, "/trash", ["active", "archived", "trashed"]);
  }

  function restoreRow(d: DocRow) {
    return mutate(d, "/restore", ["active", "trashed"]);
  }

  // Tab the row is currently being shown in (templates show under their
  // own tab regardless of state). Used by lock/unlock to refresh the
  // visible row in place.
  function rowTab(d: DocRow): IndexTab {
    return d.kind === "template" ? "templates" : d.state;
  }

  function lockRow(d: DocRow) {
    // Lock/unlock only mutates the same row; refresh the current tab so
    // the badge appears immediately.
    return mutate(d, "/lock", [rowTab(d)]);
  }

  function unlockRow(d: DocRow) {
    return mutate(d, "/unlock", [rowTab(d)]);
  }

  function deletesInLabel(deleteAt: string | null): string {
    if (!deleteAt) return "";
    // ISO-8601 with millisecond precision and trailing Z parses fine in
    // every modern engine; nowTick is read here so the label re-renders
    // each minute.
    const target = Date.parse(deleteAt);
    if (Number.isNaN(target)) return "";
    const diffMs = target - nowTick;
    if (diffMs <= 0) return "Deleting…";
    const days = Math.floor(diffMs / 86_400_000);
    if (days >= 1) return `Deletes in ${days} day${days === 1 ? "" : "s"}`;
    const hours = Math.floor(diffMs / 3_600_000);
    if (hours >= 1) return `Deletes in ${hours} hour${hours === 1 ? "" : "s"}`;
    return "Deletes within the hour";
  }

  function relativeTime(iso: string): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const diff = nowTick - t;
    if (diff < 45_000) return "just now";
    const mins = Math.round(diff / 60_000);
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const hours = Math.round(diff / 3_600_000);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.round(diff / 86_400_000);
    if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
    const weeks = Math.round(days / 7);
    if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
    const years = Math.round(days / 365);
    return `${years} year${years === 1 ? "" : "s"} ago`;
  }

  function toggleMenu(key: string, e: MouseEvent): void {
    e.stopPropagation();
    openMenuKey = openMenuKey === key ? null : key;
  }

  function closeMenu(): void {
    openMenuKey = null;
  }

  // While a menu is open, dismiss on outside click or Escape. The
  // listeners are only attached for the lifetime of the open state so
  // they don't cost anything when nothing is open.
  $effect(() => {
    if (openMenuKey === null) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest(".menu-wrapper")) return;
      openMenuKey = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") openMenuKey = null;
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  });

  function tabLabel(label: string, rows: DocRow[] | null): string {
    return rows === null ? label : `${label} (${rows.length})`;
  }

  // Templates are loaded lazily into the dropdown so the index page
  // doesn't pay for an extra round-trip until the user opens the
  // "create from template" widget. After any make/unmake mutation we
  // invalidate the cached list so the picker reflects the new state.
  let pickerTemplates = $state<DocRow[] | null>(null);
  let pickerLoading = $state(false);

  async function ensurePickerTemplates(): Promise<void> {
    if (pickerTemplates !== null || pickerLoading) return;
    pickerLoading = true;
    const { data } = await client.GET("/-/paper/api/docs", {
      params: { query: { kind: "template" } as never },
    });
    pickerLoading = false;
    pickerTemplates = ((data as unknown as DocRow[]) ?? []) as DocRow[];
  }

  // Refresh the picker list whenever the templates tab cache changes
  // (make/unmake mutations invalidate it via the refetch list).
  $effect(() => {
    // Read templates so this effect re-runs on every reassignment.
    if (templates === null) pickerTemplates = null;
    else pickerTemplates = templates;
  });

  onMount(() => {
    selectTab("active");
    void ensurePickerTemplates();
    nowTimer = setInterval(() => {
      nowTick = Date.now();
    }, 60_000);
    return () => {
      if (nowTimer) clearInterval(nowTimer);
    };
  });

  let visibleRows = $derived(bucket(tab) ?? []);
</script>

<div class="paper-index">
  <h1>Papers</h1>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <form onsubmit={create}>
    <input
      type="text"
      bind:value={newName}
      placeholder="Paper name"
      disabled={creating}
      required
    />
    <select
      bind:value={newTemplateId}
      disabled={creating}
      title="Start from a template, or blank"
    >
      <option value="">Blank</option>
      {#if pickerTemplates}
        {#each pickerTemplates as t (t.id)}
          <option value={String(t.id)}>From: {t.name}</option>
        {/each}
      {/if}
    </select>
    <button type="submit" disabled={creating || !newName.trim()}>
      {creating ? "Creating…" : "New paper"}
    </button>
  </form>

  <div class="tabs" role="tablist">
    <button
      type="button"
      role="tab"
      aria-selected={tab === "active"}
      class:active={tab === "active"}
      onclick={() => selectTab("active")}
    >
      {tabLabel("Active", active)}
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={tab === "archived"}
      class:active={tab === "archived"}
      onclick={() => selectTab("archived")}
    >
      {tabLabel("Archive", archived)}
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={tab === "trashed"}
      class:active={tab === "trashed"}
      onclick={() => selectTab("trashed")}
    >
      {tabLabel("Trash", trashed)}
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={tab === "templates"}
      class:active={tab === "templates"}
      onclick={() => selectTab("templates")}
    >
      {tabLabel("Templates", templates)}
    </button>
  </div>

  {#if loading && bucket(tab) === null}
    <p>Loading…</p>
  {:else if visibleRows.length === 0}
    {#if tab === "active"}
      <p>No papers yet.</p>
    {:else if tab === "archived"}
      <p>No archived papers.</p>
    {:else if tab === "trashed"}
      <p>Trash is empty.</p>
    {:else}
      <p>No templates yet. Create one from the menu on any active paper.</p>
    {/if}
  {:else}
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Created by</th>
          <th>Updated</th>
          {#if tab === "trashed"}
            <th>Status</th>
          {/if}
          <th class="actions-col"></th>
        </tr>
      </thead>
      <tbody>
        {#each visibleRows as doc (doc.id)}
          {@const key = `${doc.state}:${doc.id}`}
          {@const busy = busyKey === key}
          {@const menuOpen = openMenuKey === key}
          <tr class:busy>
            <td>
              <a href="/-/paper/doc/{doc.id}">{doc.name}</a>
              {#if doc.locked}
                <span class="badge badge-locked" title="Read-only">Locked</span>
              {/if}
            </td>
            <td title={doc.created_by ?? ""}>
              {#if doc.created_by}
                <span class="creator">
                  {#if doc.created_by_avatar}
                    <img
                      class="creator-avatar"
                      src={doc.created_by_avatar}
                      alt=""
                      onerror={(e) =>
                        ((e.currentTarget as HTMLImageElement).style.display =
                          "none")}
                    />
                  {/if}
                  {doc.created_by_name ?? doc.created_by}
                </span>
              {/if}
            </td>
            <td title={doc.updated_at}>{relativeTime(doc.updated_at)}</td>
            {#if tab === "trashed"}
              <td class="delete-at">{deletesInLabel(doc.delete_at)}</td>
            {/if}
            <td class="actions">
              {#if doc.is_owner}
                <div class="menu-wrapper">
                  <button
                    type="button"
                    class="menu-trigger"
                    aria-label="Actions"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    disabled={busy}
                    onclick={(e) => toggleMenu(key, e)}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      fill="currentColor"
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                    >
                      <path
                        d="M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0"
                      />
                    </svg>
                  </button>
                  {#if menuOpen}
                    <div class="menu" role="menu">
                      {#if tab === "templates"}
                        {#if doc.locked}
                          <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                              closeMenu();
                              void unlockRow(doc);
                            }}
                          >
                            Unlock
                          </button>
                        {:else}
                          <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                              closeMenu();
                              void lockRow(doc);
                            }}
                          >
                            Lock
                          </button>
                        {/if}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            closeMenu();
                            void unmakeTemplate(doc);
                          }}
                        >
                          Demote to doc
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          class="danger"
                          onclick={() => {
                            closeMenu();
                            void trashRow(doc);
                          }}
                        >
                          Trash
                        </button>
                      {:else if tab === "active"}
                        {#if doc.locked}
                          <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                              closeMenu();
                              void unlockRow(doc);
                            }}
                          >
                            Unlock
                          </button>
                        {:else}
                          <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                              closeMenu();
                              void lockRow(doc);
                            }}
                          >
                            Lock
                          </button>
                        {/if}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            closeMenu();
                            void makeTemplate(doc);
                          }}
                        >
                          Make template
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            closeMenu();
                            void archiveRow(doc);
                          }}
                        >
                          Archive
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          class="danger"
                          onclick={() => {
                            closeMenu();
                            void trashRow(doc);
                          }}
                        >
                          Trash
                        </button>
                      {:else if tab === "archived"}
                        {#if doc.locked}
                          <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                              closeMenu();
                              void unlockRow(doc);
                            }}
                          >
                            Unlock
                          </button>
                        {:else}
                          <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                              closeMenu();
                              void lockRow(doc);
                            }}
                          >
                            Lock
                          </button>
                        {/if}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            closeMenu();
                            void unarchiveRow(doc);
                          }}
                        >
                          Unarchive
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          class="danger"
                          onclick={() => {
                            closeMenu();
                            void trashRow(doc);
                          }}
                        >
                          Trash
                        </button>
                      {:else}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            closeMenu();
                            void restoreRow(doc);
                          }}
                        >
                          Restore
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  /* Inherit the body font (Inter Variable + system fallbacks). */
  .paper-index {
    font-family: inherit;
    max-width: 880px;
    margin-left: auto;
    margin-right: auto;
  }
  .error {
    background: #ffd6d6;
    color: #5a0000;
    padding: 6px 10px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin-top: 1em;
  }
  th,
  td {
    border-bottom: 1px solid #eee;
    padding: 6px 8px;
    text-align: left;
  }
  form {
    margin: 1em 0;
    display: flex;
    gap: 0.5em;
    align-items: center;
  }
  input[type="text"] {
    width: 280px;
    max-width: 100%;
    padding: 6px 8px;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid #ddd;
    margin-top: 1em;
  }
  .tabs button {
    border: none;
    background: transparent;
    padding: 8px 14px;
    cursor: pointer;
    font: inherit;
    color: #555;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tabs button.active {
    color: #1a1a1a;
    border-bottom-color: #0b5cad;
  }
  .tabs button:hover:not(.active) {
    color: #1a1a1a;
  }
  .actions-col {
    width: 1%;
    white-space: nowrap;
  }
  td.actions {
    text-align: right;
    white-space: nowrap;
  }
  .menu-wrapper {
    position: relative;
    display: inline-block;
  }
  .menu-trigger {
    border: none;
    background: transparent;
    padding: 4px 6px;
    cursor: pointer;
    border-radius: 3px;
    color: #555;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .menu-trigger:hover:not(:disabled),
  .menu-trigger[aria-expanded="true"] {
    background: #f0f3f6;
    color: #1a1a1a;
  }
  .menu-trigger:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .menu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 10;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    min-width: 140px;
    padding: 4px 0;
    display: flex;
    flex-direction: column;
  }
  .menu button {
    border: none;
    background: transparent;
    padding: 6px 14px;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: 0.95em;
    color: inherit;
  }
  .menu button:hover {
    background: #f0f3f6;
  }
  .menu button.danger {
    color: #8a1a1a;
  }
  .menu button.danger:hover {
    background: #fbecec;
  }
  td.delete-at {
    color: #8a5a00;
    font-size: 0.9em;
  }
  tr.busy {
    opacity: 0.6;
  }
  .badge {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 7px;
    font-size: 11px;
    line-height: 1.4;
    border-radius: 9px;
    vertical-align: 1px;
  }
  .badge-locked {
    background: #eef2f7;
    color: #4a5568;
    border: 1px solid #d0d7e0;
  }
  .creator {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
  }
  .creator-avatar {
    width: 1.4em;
    height: 1.4em;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
  }
</style>
