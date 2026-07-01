<script lang="ts">
  /**
   * Sidebar panel for the document's authors byline — a manager-curated,
   * ordered list of credited actors (distinct from who created the doc and
   * from who can access it).
   *
   * Read-only for everyone: it fetches `GET /authors`, which returns the
   * ordered byline already resolved to `{id, name, avatar_url}` (name/avatar
   * degrade to id-as-name when the viewer lacks `profile_access`). When
   * `canManage` is true it also exposes add (via a collaborator picker backed
   * by the manage-gated `/author-candidates`), remove, and up/down reorder —
   * every mutation returns the full resolved byline, so we replace local state
   * from the response with no re-fetch.
   *
   * @feat authors: the byline UI — read-only credits for viewers, add/remove/
   * reorder for managers.
   */
  type Author = { id: string; name: string; avatar_url: string | null };

  let { docId, canManage = false }: { docId: string; canManage?: boolean } =
    $props();

  let open = $state(true);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let authors = $state<Author[]>([]);
  // Bumped per load; a stale response (token !== loadToken) is dropped.
  let loadToken = 0;
  // A mutation (add/remove/reorder) is in flight — disable controls.
  let busy = $state(false);

  // Candidate picker (managers only).
  let pickerOpen = $state(false);
  let query = $state("");
  let candidates = $state<Author[]>([]);
  let candLoading = $state(false);
  let candToken = 0;

  async function load(): Promise<void> {
    const token = ++loadToken;
    loading = true;
    error = null;
    try {
      const resp = await fetch(`/-/paper/api/docs/${docId}/authors`);
      if (!resp.ok) throw new Error("load failed");
      const data = (await resp.json()) as { authors: Author[] };
      if (token !== loadToken) return;
      authors = data.authors ?? [];
    } catch {
      if (token !== loadToken) return;
      error = "Could not load authors.";
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  // (Re)load whenever the panel is open or the doc changes. Reading `open` and
  // `docId` registers them as effect dependencies.
  $effect(() => {
    if (!open) return;
    void docId;
    load();
  });

  async function loadCandidates(): Promise<void> {
    const token = ++candToken;
    candLoading = true;
    try {
      const url = `/-/paper/api/docs/${docId}/author-candidates?q=${encodeURIComponent(
        query,
      )}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("candidates failed");
      const data = (await resp.json()) as { results: Author[] };
      if (token !== candToken) return;
      candidates = data.results ?? [];
    } catch {
      if (token !== candToken) return;
      candidates = [];
    } finally {
      if (token === candToken) candLoading = false;
    }
  }

  // Fetch candidates when the picker opens and on every query change.
  $effect(() => {
    if (!pickerOpen) return;
    void query;
    loadCandidates();
  });

  async function post(path: string, body: unknown): Promise<boolean> {
    busy = true;
    try {
      const resp = await fetch(`/-/paper/api/docs/${docId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) return false;
      const data = (await resp.json()) as { authors?: Author[] };
      authors = data.authors ?? [];
      return true;
    } catch {
      return false;
    } finally {
      busy = false;
    }
  }

  function openPicker(): void {
    query = "";
    pickerOpen = true;
  }

  async function addAuthor(id: string): Promise<void> {
    if (await post("authors/add", { actor_id: id })) {
      // The added collaborator drops out of the eligible set.
      if (pickerOpen) loadCandidates();
    }
  }

  async function removeAuthor(id: string): Promise<void> {
    await post("authors/remove", { actor_id: id });
    if (pickerOpen) loadCandidates();
  }

  async function move(index: number, delta: number): Promise<void> {
    const j = index + delta;
    if (j < 0 || j >= authors.length) return;
    const next = authors.map((a) => a.id);
    [next[index], next[j]] = [next[j], next[index]];
    await post("authors/replace", { authors: next });
  }
</script>

<section class="authors-panel">
  <button
    type="button"
    class="authors-panel-toggle"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <span class="authors-panel-caret" aria-hidden="true">{open ? "▾" : "▸"}</span
    >
    Authors
  </button>

  {#if open}
    <div class="authors-panel-body">
      {#if loading}
        <div class="authors-panel-state">Loading…</div>
      {:else if error}
        <div class="authors-panel-state authors-panel-error">{error}</div>
      {:else}
        {#if authors.length === 0}
          <div class="authors-panel-none">No authors yet</div>
        {:else}
          <ul class="authors-panel-list">
            {#each authors as a, i (a.id)}
              <li class="authors-panel-item">
                {#if a.avatar_url}
                  <img class="authors-panel-avatar" src={a.avatar_url} alt="" />
                {:else}
                  <span
                    class="authors-panel-avatar authors-panel-avatar-blank"
                    aria-hidden="true"
                  ></span>
                {/if}
                <span class="authors-panel-name">{a.name}</span>
                {#if canManage}
                  <span class="authors-panel-actions">
                    <button
                      type="button"
                      class="authors-panel-move"
                      title="Move up"
                      aria-label="Move up"
                      disabled={busy || i === 0}
                      onclick={() => move(i, -1)}>↑</button
                    >
                    <button
                      type="button"
                      class="authors-panel-move"
                      title="Move down"
                      aria-label="Move down"
                      disabled={busy || i === authors.length - 1}
                      onclick={() => move(i, 1)}>↓</button
                    >
                    <button
                      type="button"
                      class="authors-panel-remove"
                      title="Remove author"
                      aria-label="Remove author"
                      disabled={busy}
                      onclick={() => removeAuthor(a.id)}>×</button
                    >
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if canManage}
          <div class="authors-panel-add">
            {#if !pickerOpen}
              <button
                type="button"
                class="authors-panel-addbtn"
                onclick={openPicker}>+ Add author</button
              >
            {:else}
              <input
                class="authors-panel-search"
                type="text"
                placeholder="Search collaborators…"
                bind:value={query}
              />
              {#if candLoading}
                <div class="authors-panel-state">Searching…</div>
              {:else if candidates.length === 0}
                <div class="authors-panel-none">No eligible collaborators</div>
              {:else}
                <ul class="authors-panel-candidates">
                  {#each candidates as c (c.id)}
                    <li>
                      <button
                        type="button"
                        class="authors-panel-candidate"
                        disabled={busy}
                        onclick={() => addAuthor(c.id)}
                      >
                        {#if c.avatar_url}
                          <img
                            class="authors-panel-avatar"
                            src={c.avatar_url}
                            alt=""
                          />
                        {:else}
                          <span
                            class="authors-panel-avatar authors-panel-avatar-blank"
                            aria-hidden="true"
                          ></span>
                        {/if}
                        {c.name}
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
              <button
                type="button"
                class="authors-panel-cancel"
                onclick={() => (pickerOpen = false)}>Done</button
              >
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</section>

<style>
  .authors-panel {
    margin: 16px 0;
    border-top: 1px solid #e0e4e8;
    font-size: 14px;
  }
  .authors-panel-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    padding: 4px 0;
    background: transparent;
    border: none;
    color: #4a5568;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .authors-panel-toggle:hover {
    color: #1a1a1a;
  }
  .authors-panel-caret {
    font-size: 0.8em;
    color: #888;
  }
  .authors-panel-body {
    padding: 4px 0 8px 10px;
  }
  .authors-panel-state {
    color: #888;
    padding: 4px 0;
  }
  .authors-panel-error {
    color: #8a2a2a;
  }
  .authors-panel-none {
    color: #999;
    font-style: italic;
    padding: 2px 0;
  }
  .authors-panel-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .authors-panel-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
  }
  .authors-panel-avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    object-fit: cover;
    flex: 0 0 auto;
  }
  .authors-panel-avatar-blank {
    background: #dfe3e8;
  }
  .authors-panel-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .authors-panel-actions {
    display: inline-flex;
    gap: 2px;
    flex: 0 0 auto;
  }
  .authors-panel-move,
  .authors-panel-remove {
    background: transparent;
    border: none;
    color: #888;
    cursor: pointer;
    padding: 0 3px;
    line-height: 1;
    font: inherit;
  }
  .authors-panel-move:hover:not(:disabled),
  .authors-panel-remove:hover:not(:disabled) {
    color: #1a1a1a;
  }
  .authors-panel-move:disabled,
  .authors-panel-remove:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .authors-panel-add {
    margin-top: 8px;
  }
  .authors-panel-addbtn,
  .authors-panel-cancel {
    background: transparent;
    border: none;
    color: #0b5cad;
    cursor: pointer;
    padding: 2px 0;
    font: inherit;
  }
  .authors-panel-addbtn:hover,
  .authors-panel-cancel:hover {
    text-decoration: underline;
  }
  .authors-panel-search {
    width: 100%;
    box-sizing: border-box;
    padding: 4px 6px;
    border: 1px solid #d0d5db;
    border-radius: 6px;
    font: inherit;
    margin-bottom: 4px;
  }
  .authors-panel-candidates {
    list-style: none;
    margin: 0 0 4px;
    padding: 0;
    max-height: 180px;
    overflow-y: auto;
  }
  .authors-panel-candidate {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    padding: 3px 2px;
    cursor: pointer;
    font: inherit;
    border-radius: 4px;
  }
  .authors-panel-candidate:hover:not(:disabled) {
    background: #f1f4f8;
  }
  .authors-panel-candidate:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
