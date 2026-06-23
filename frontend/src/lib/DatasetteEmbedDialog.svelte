<script lang="ts">
  /**
   * Searchable picker for inserting a Datasette embed. Reused by the `/` slash
   * menu (ticket 09). Search visible databases/tables/views by name, or paste a
   * full ref path (including a row, e.g. `/db/table/42`). The chosen ref + mode
   * is handed back via `oninsert`; the caller turns it into a `datasette_embed`
   * node (see datasetteEmbed.ts `insertDatasetteEmbed`).
   */
  import {
    searchResources,
    type SearchResult,
    type ProviderSource,
  } from "./datasetteEmbed";

  let {
    open = $bindable(false),
    source = null,
    oninsert,
  }: {
    open?: boolean;
    // null → the built-in core-Datasette picker (search tables/views/dbs +
    // paste a ref path). A ProviderSource → scope search to that provider
    // (e.g. "Places map") and insert with the provider's render mode.
    source?: ProviderSource | null;
    oninsert: (ref: string, mode: string) => void;
  } = $props();

  let dialogEl: HTMLDialogElement | undefined = $state();
  let query = $state("");
  let manualRef = $state("");
  let mode = $state("table");
  let results = $state<SearchResult[]>([]);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  // Core lets the user pick a table render mode + paste a raw ref path;
  // provider sources don't (the provider owns rendering + its own URL space).
  let isCore = $derived(source === null);
  let title = $derived(isCore ? "Insert Datasette embed" : `Insert ${source!.label}`);
  let placeholder = $derived(
    isCore ? "Search tables, views, databases…" : `Search ${source!.label.toLowerCase()}…`,
  );

  function reset() {
    query = "";
    manualRef = "";
    mode = "table";
    results = [];
  }

  // Drive the native <dialog> from the bound `open` prop.
  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      void runSearch("");
    } else if (!open && el.open) {
      el.close();
    }
  });

  async function runSearch(q: string) {
    results = await searchResources(q, 20, source?.id);
  }

  function onQueryInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void runSearch(query.trim()), 150);
  }

  function choose(ref: string) {
    // Provider sources carry a fixed render mode; core uses the dropdown.
    oninsert(ref, source ? source.mode : mode);
    open = false;
  }

  function cancel() {
    open = false;
  }

  function insertManual() {
    const ref = manualRef.trim();
    if (ref) choose(ref);
  }
</script>

<dialog
  bind:this={dialogEl}
  class="ds-embed-dialog"
  onclose={() => {
    open = false;
    reset();
  }}
>
  <div class="ds-embed-dialog__head">
    <strong>{title}</strong>
    <button type="button" class="ds-embed-dialog__x" aria-label="Close" onclick={cancel}
      >×</button
    >
  </div>

  <input
    class="ds-embed-search"
    type="text"
    {placeholder}
    bind:value={query}
    oninput={onQueryInput}
  />

  <ul class="ds-embed-results">
    {#each results as r (r.ref)}
      <li>
        <button type="button" class="ds-embed-result" onclick={() => choose(r.ref)}>
          <span class="ds-embed-result-kind">{r.kind}</span>
          <span class="ds-embed-result-label">{r.label}</span>
          <span class="ds-embed-result-db">{r.detail ?? r.db ?? ""}</span>
        </button>
      </li>
    {:else}
      <li class="ds-embed-empty">No matches</li>
    {/each}
  </ul>

  {#if isCore}
    <div class="ds-embed-manual">
      <label class="ds-embed-manual-label" for="ds-embed-manual-input">
        …or a ref path
      </label>
      <input
        id="ds-embed-manual-input"
        class="ds-embed-manual-input"
        type="text"
        placeholder="/db/table or /db/table/42"
        bind:value={manualRef}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            insertManual();
          }
        }}
      />
      <select class="ds-embed-mode" bind:value={mode} aria-label="Render mode">
        <option value="table">table</option>
        <option value="row">row</option>
      </select>
    </div>

    <div class="ds-embed-dialog__foot">
      <button type="button" class="ds-embed-cancel-btn" onclick={cancel}>Cancel</button>
      <button
        type="button"
        class="ds-embed-insert-btn"
        disabled={!manualRef.trim()}
        onclick={insertManual}>Insert ref</button
      >
    </div>
  {:else}
    <div class="ds-embed-dialog__foot">
      <button type="button" class="ds-embed-cancel-btn" onclick={cancel}>Cancel</button>
    </div>
  {/if}
</dialog>

<style>
  .ds-embed-dialog {
    width: min(480px, 92vw);
    border: 1px solid #d0d7de;
    border-radius: 10px;
    padding: 16px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
    font: inherit;
    color: #1a1a1a;
  }
  .ds-embed-dialog::backdrop {
    background: rgba(0, 0, 0, 0.35);
  }
  .ds-embed-dialog__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    font-size: 15px;
  }
  .ds-embed-dialog__x {
    border: none;
    background: transparent;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    color: #666;
    padding: 0 4px;
  }
  .ds-embed-search,
  .ds-embed-manual-input {
    width: 100%;
    padding: 7px 9px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    font: inherit;
    box-sizing: border-box;
  }
  .ds-embed-results {
    list-style: none;
    margin: 10px 0;
    padding: 0;
    max-height: 240px;
    overflow-y: auto;
    border: 1px solid #eee;
    border-radius: 6px;
  }
  .ds-embed-result {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    padding: 6px 10px;
    cursor: pointer;
    font: inherit;
  }
  .ds-embed-result:hover {
    background: #f2f8ff;
  }
  .ds-embed-result-kind {
    font-size: 11px;
    text-transform: uppercase;
    color: #888;
    min-width: 42px;
  }
  .ds-embed-result-label {
    font-weight: 500;
  }
  .ds-embed-result-db {
    margin-left: auto;
    font-size: 12px;
    color: #999;
  }
  .ds-embed-empty {
    padding: 10px;
    color: #999;
    font-size: 13px;
    text-align: center;
  }
  .ds-embed-manual {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
  }
  .ds-embed-manual-label {
    font-size: 12px;
    color: #555;
    white-space: nowrap;
  }
  .ds-embed-mode {
    padding: 6px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    font: inherit;
  }
  .ds-embed-dialog__foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .ds-embed-cancel-btn,
  .ds-embed-insert-btn {
    padding: 6px 14px;
    border-radius: 999px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid #d0d7de;
    background: #fff;
    color: #333;
  }
  .ds-embed-insert-btn {
    border-color: #0b5cad;
    background: #0b5cad;
    color: #fff;
  }
  .ds-embed-insert-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
