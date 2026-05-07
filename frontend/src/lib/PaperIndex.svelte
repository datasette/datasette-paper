<script lang="ts">
  import { onMount } from "svelte";
  import { client } from "./client";

  type DocRow = {
    id: number;
    name: string;
    current_version: number;
    updated_at: string;
    created_by: string | null;
  };

  let docs = $state<DocRow[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let newName = $state("");
  let creating = $state(false);

  async function refresh() {
    loading = true;
    error = null;
    const { data, error: err } = await client.GET("/-/paper/api/docs");
    if (err || !data) {
      error = "Failed to load papers";
    } else {
      docs = data as unknown as DocRow[];
    }
    loading = false;
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

  onMount(refresh);
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

  {#if loading}
    <p>Loading…</p>
  {:else if docs.length === 0}
    <p>No papers yet.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Name</th><th>Updated</th><th>Created by</th></tr>
      </thead>
      <tbody>
        {#each docs as doc (doc.id)}
          <tr>
            <td><a href="/-/paper/doc/{doc.id}">{doc.name}</a></td>
            <td>{doc.updated_at}</td>
            <td>{doc.created_by ?? ""}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  /* Inherit the body font (Inter Variable + system fallbacks). */
  .paper-index { font-family: inherit; }
  .error { background: #ffd6d6; color: #5a0000; padding: 6px 10px; }
  table { border-collapse: collapse; width: 100%; margin-top: 1em; }
  th, td { border-bottom: 1px solid #eee; padding: 6px 8px; text-align: left; }
  form { margin: 1em 0; display: flex; gap: 0.5em; align-items: center; }
  input[type="text"] { width: 280px; max-width: 100%; padding: 6px 8px; }
</style>
