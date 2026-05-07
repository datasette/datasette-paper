<script lang="ts">
  import { onMount } from "svelte";
  import { client } from "./client";

  type Visibility = "private" | "link-view" | "link-edit";
  type Role = "viewer" | "editor";

  type Share = { actorID: string; role: Role; grantedAt?: string };

  type ShareState = {
    visibility: Visibility;
    owner: string | null;
    shares: Share[];
    canManage: boolean;
  };

  let {
    docId,
    open = $bindable(false),
  }: { docId: string; open?: boolean } = $props();

  let server = $state<ShareState | null>(null);
  let draftVisibility = $state<Visibility>("private");
  let draftShares = $state<Share[]>([]);
  let addActor = $state("");
  let addRole = $state<Role>("viewer");
  let saving = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);

  // Save is enabled iff the draft differs from server state. We compute
  // a stable key for each list to compare regardless of order.
  let draftKey = $derived(
    server === null
      ? ""
      : `${draftVisibility}:${[...draftShares]
          .sort((a, b) => a.actorID.localeCompare(b.actorID))
          .map((s) => `${s.actorID}=${s.role}`)
          .join(",")}`,
  );
  let serverKey = $derived(
    server === null
      ? ""
      : `${server.visibility}:${[...server.shares]
          .sort((a, b) => a.actorID.localeCompare(b.actorID))
          .map((s) => `${s.actorID}=${s.role}`)
          .join(",")}`,
  );
  let dirty = $derived(server !== null && draftKey !== serverKey);

  $effect(() => {
    if (open) void load();
  });

  async function load() {
    loading = true;
    error = null;
    const { data, error: err } = await client.GET(
      "/-/paper/api/docs/{doc_id}/share",
      { params: { path: { doc_id: Number(docId) } } },
    );
    loading = false;
    if (err || !data) {
      error = "Failed to load share state";
      return;
    }
    const state = data as unknown as ShareState;
    server = state;
    draftVisibility = state.visibility;
    draftShares = state.shares.map((s) => ({ ...s }));
  }

  function close() {
    open = false;
    addActor = "";
    error = null;
  }

  function removeShare(actorId: string) {
    draftShares = draftShares.filter((s) => s.actorID !== actorId);
  }

  function changeRole(actorId: string, role: Role) {
    draftShares = draftShares.map((s) =>
      s.actorID === actorId ? { ...s, role } : s,
    );
  }

  function addShare(e?: Event) {
    e?.preventDefault();
    const id = addActor.trim();
    if (!id) return;
    if (id === server?.owner) {
      error = "Owner is already in the access list";
      return;
    }
    if (draftShares.some((s) => s.actorID === id)) {
      error = `${id} is already in the access list`;
      return;
    }
    draftShares = [...draftShares, { actorID: id, role: addRole }];
    addActor = "";
    error = null;
  }

  async function save() {
    if (!server || saving || !dirty) return;
    saving = true;
    error = null;
    const body = {
      visibility: draftVisibility,
      shares: draftShares.map((s) => ({
        actorID: s.actorID,
        role: s.role,
      })),
    };
    const { data, error: err } = await client.POST(
      "/-/paper/api/docs/{doc_id}/share",
      {
        params: { path: { doc_id: Number(docId) } },
        body: body as never,
      },
    );
    saving = false;
    if (err || !data) {
      error = "Failed to save share state";
      return;
    }
    // Reload bootstrap so PaperApp picks up any permission change (e.g.
    // visibility flipping affects the user's own canEdit).
    window.location.reload();
  }

  onMount(() => {
    if (open) void load();
  });
</script>

{#if open}
  <div
    class="share-dialog-backdrop"
    role="presentation"
    onclick={close}
    onkeydown={(e) => {
      if (e.key === "Escape") close();
    }}
  >
    <div
      class="share-dialog"
      role="dialog"
      aria-label="Share dialog"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <h2>Share</h2>

      {#if loading && server === null}
        <p class="loading">Loading…</p>
      {:else if server}
        <section>
          <h3>General access</h3>
          <label>
            <input
              type="radio"
              value="private"
              bind:group={draftVisibility}
              disabled={!server.canManage}
            />
            Restricted (only specific people)
          </label>
          <label>
            <input
              type="radio"
              value="link-view"
              bind:group={draftVisibility}
              disabled={!server.canManage}
            />
            Anyone with paper access can view
          </label>
          <label>
            <input
              type="radio"
              value="link-edit"
              bind:group={draftVisibility}
              disabled={!server.canManage}
            />
            Anyone with paper access can edit
          </label>
        </section>

        <section>
          <h3>People with access</h3>
          <ul class="actor-list">
            <li class="owner-row">
              <span class="actor-id">{server.owner ?? "anonymous"}</span>
              <span class="role-tag">Owner</span>
            </li>
            {#each draftShares as share (share.actorID)}
              <li>
                <span class="actor-id">{share.actorID}</span>
                {#if server.canManage}
                  <select
                    aria-label={`Role for ${share.actorID}`}
                    value={share.role}
                    onchange={(e) =>
                      changeRole(
                        share.actorID,
                        (e.currentTarget as HTMLSelectElement).value as Role,
                      )}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button
                    type="button"
                    class="remove-btn"
                    aria-label={`Remove ${share.actorID}`}
                    onclick={() => removeShare(share.actorID)}
                  >
                    Remove
                  </button>
                {:else}
                  <span class="role-tag">
                    {share.role === "editor" ? "Editor" : "Viewer"}
                  </span>
                {/if}
              </li>
            {/each}
          </ul>

          {#if server.canManage}
            <form class="add-row" onsubmit={addShare}>
              <input
                type="text"
                placeholder="actor id"
                aria-label="Add person — actor id"
                bind:value={addActor}
              />
              <select aria-label="Role for new person" bind:value={addRole}>
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <button type="submit" disabled={!addActor.trim()}>Add</button>
            </form>
          {/if}
        </section>

        {#if error}
          <p class="error">{error}</p>
        {/if}

        <footer class="dialog-footer">
          {#if server.canManage}
            <button type="button" class="secondary" onclick={close}>
              Cancel
            </button>
            <button
              type="button"
              class="primary"
              disabled={!dirty || saving}
              onclick={save}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          {:else}
            <button type="button" class="primary" onclick={close}>Close</button>
          {/if}
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .share-dialog-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .share-dialog {
    background: #fff;
    border-radius: 8px;
    padding: 20px 24px;
    width: 480px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
  }
  .share-dialog h2 {
    margin: 0 0 12px;
    font-size: 18px;
  }
  .share-dialog h3 {
    margin: 16px 0 6px;
    font-size: 13px;
    color: #555;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .share-dialog label {
    display: block;
    padding: 4px 0;
    font-size: 14px;
    cursor: pointer;
  }
  .actor-list {
    list-style: none;
    padding: 0;
    margin: 8px 0;
  }
  .actor-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid #f0f0f0;
  }
  .actor-list li.owner-row {
    color: #555;
  }
  .actor-id {
    flex: 1;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
  }
  .role-tag {
    font-size: 12px;
    color: #666;
    padding: 2px 8px;
    background: #f0f3f6;
    border-radius: 4px;
  }
  .remove-btn {
    font-size: 12px;
    background: transparent;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    color: #555;
  }
  .remove-btn:hover {
    background: #fff5f5;
    border-color: #f5b1b1;
    color: #a02020;
  }
  .add-row {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .add-row input[type="text"] {
    flex: 1;
    padding: 6px 8px;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
  }
  .add-row select,
  .actor-list select {
    padding: 4px 6px;
    font-size: 13px;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    background: #fff;
  }
  .add-row button {
    padding: 6px 12px;
    background: #0b5cad;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  .add-row button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .error {
    color: #a02020;
    background: #ffd6d6;
    padding: 6px 10px;
    border-radius: 4px;
    margin: 8px 0;
    font-size: 13px;
  }
  .dialog-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .dialog-footer button {
    padding: 6px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
  }
  .dialog-footer .primary {
    background: #0b5cad;
    color: white;
    border: 1px solid #0b5cad;
  }
  .dialog-footer .primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .dialog-footer .secondary {
    background: #fff;
    color: #333;
    border: 1px solid #d0d7de;
  }
  .loading {
    color: #888;
    padding: 12px;
  }
</style>
