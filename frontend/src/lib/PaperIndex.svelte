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
    visibility: string;
    is_owner: boolean;
    state: DocState;
    archived_at: string | null;
    trashed_at: string | null;
    delete_at: string | null;
  };

  // Lazy per-tab caches. `null` means "not fetched yet"; switching tabs
  // triggers a fetch on first activation. We refetch a tab after each
  // mutation that lands on it.
  let active = $state<DocRow[] | null>(null);
  let archived = $state<DocRow[] | null>(null);
  let trashed = $state<DocRow[] | null>(null);

  let tab = $state<DocState>("active");
  let loading = $state(false);
  let error = $state<string | null>(null);
  let newName = $state("");
  let creating = $state(false);
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

  function bucket(state: DocState): DocRow[] | null {
    if (state === "active") return active;
    if (state === "archived") return archived;
    return trashed;
  }

  function setBucket(state: DocState, rows: DocRow[]): void {
    if (state === "active") active = rows;
    else if (state === "archived") archived = rows;
    else trashed = rows;
  }

  async function loadTab(target: DocState): Promise<void> {
    loading = true;
    error = null;
    const { data, error: err } = await client.GET("/-/paper/api/docs", {
      params: { query: { state: target } as never },
    });
    loading = false;
    if (err || !data) {
      error = "Failed to load papers";
      return;
    }
    setBucket(target, data as unknown as DocRow[]);
  }

  function selectTab(target: DocState): void {
    tab = target;
    if (bucket(target) === null) void loadTab(target);
  }

  async function create(e: Event) {
    e.preventDefault();
    if (!newName.trim() || creating) return;
    creating = true;
    error = null;
    const { data, error: err } = await client.POST("/-/paper/api/docs", {
      body: { name: newName.trim() } as never,
    });
    creating = false;
    if (err || !data) {
      error = "Failed to create paper";
      return;
    }
    const created = data as unknown as DocRow;
    window.location.href = `/-/paper/doc/${created.id}`;
  }

  async function mutate(
    doc: DocRow,
    path: "/archive" | "/unarchive" | "/trash" | "/restore",
    refetch: DocState[],
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
        | "/-/paper/api/docs/{doc_id}/restore";
      const { error: err } = await client.POST(url, {
        params: { path: { doc_id: doc.id } },
      });
      if (err) {
        error = "Action failed";
        return;
      }
      // Invalidate the affected tabs so they refetch on next view, and
      // refresh whichever one is currently visible immediately.
      for (const state of refetch) {
        if (state === tab) {
          await loadTab(state);
        } else {
          setBucket(state, [] as DocRow[]);
          if (state === "active") active = null;
          else if (state === "archived") archived = null;
          else trashed = null;
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

  onMount(() => {
    selectTab("active");
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
  </div>

  {#if loading && bucket(tab) === null}
    <p>Loading…</p>
  {:else if visibleRows.length === 0}
    {#if tab === "active"}
      <p>No papers yet.</p>
    {:else if tab === "archived"}
      <p>No archived papers.</p>
    {:else}
      <p>Trash is empty.</p>
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
            <td><a href="/-/paper/doc/{doc.id}">{doc.name}</a></td>
            <td>{doc.created_by ?? ""}</td>
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
                      {#if tab === "active"}
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
</style>
