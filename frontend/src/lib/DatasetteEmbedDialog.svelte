<script lang="ts">
  /**
   * Searchable picker for inserting an embed. Reused by the `/` slash menu.
   * Two modes, by the `source` prop:
   *   - undefined (core Datasette): search visible databases/tables/views by
   *     name via the native `.json` API (datasetteEmbed.ts `searchResources`).
   *   - a third-party provider source id: delegate search to that provider's
   *     registered `search()` (embedRegistry.ts) — the provider owns its
   *     permission filtering + leak discipline.
   * A full ref path can also be typed directly (incl. a row, `/db/table/42`).
   * The chosen ref + mode is handed back via `oninsert`; the caller turns it
   * into a `block_embed` node (datasetteEmbed.ts `insertDatasetteEmbed`).
   */
  import { searchResources } from "./datasetteEmbed";
  import { embedRegistry, type PaperEmbedSource } from "./embedRegistry";
  import {
    ensureProvider,
    manifestKindForSource,
    manifestSources,
  } from "./embedProviders";

  let {
    open = $bindable(false),
    source = undefined,
    filter = undefined,
    oninsert,
  }: {
    open?: boolean;
    source?: string;
    // Restricts the core Datasette picker to one resource kind: "table" lists
    // tables + views, "database" lists databases. Ignored for provider sources
    // (they own their own search); undefined lists everything.
    filter?: "table" | "database";
    oninsert: (ref: string, mode: string) => void;
  } = $props();

  /** Normalized display row for both core and provider results. */
  type DisplayResult = {
    ref: string;
    label: string;
    kind?: string;
    secondary?: string;
  };

  let dialogEl: HTMLDialogElement | undefined = $state();
  let query = $state("");
  let manualRef = $state("");
  let mode = $state("table");
  let results = $state<DisplayResult[]>([]);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  // The active provider source spec — populated only once the provider's bundle
  // is loaded (a provider source is lazy: its picker()/search() don't exist
  // until then). Core source (no `source`) leaves it undefined.
  let sourceSpec = $state<PaperEmbedSource | undefined>(undefined);
  let providerLoading = $state(false);
  // Set when a provider source was requested but its bundle never registered
  // (failed import, malformed export, or unknown source). We show this instead
  // of silently falling back to the core Datasette picker — which would search
  // a provider that isn't there ("No matches" forever) under a misleading title.
  let loadError = $state<string | null>(null);

  // The provider source's manifest label — known before its bundle loads, so we
  // can title the dialog correctly during the load and in the error state.
  const sourceLabel = $derived(
    source ? (manifestSources().find((s) => s.id === source)?.label ?? source) : "",
  );

  const title = $derived(
    sourceSpec
      ? `Insert ${sourceSpec.label}`
      : source
        ? `Insert ${sourceLabel}`
        : filter === "database"
          ? "Embed a database"
          : filter === "table"
            ? "Embed a table"
            : "Insert Datasette embed",
  );

  // Core-picker search placeholder, narrowed to the active kind filter.
  const corePlaceholder = $derived(
    filter === "database"
      ? "Search databases…"
      : filter === "table"
        ? "Search tables, views…"
        : "Search tables, views, databases…",
  );

  function reset() {
    query = "";
    manualRef = "";
    mode = sourceSpec?.mode ?? "table";
    results = [];
    loadError = null;
  }

  // Drive the native <dialog> from the bound `open` prop.
  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      void openSource();
    } else if (!open && el.open) {
      el.close();
    }
  });

  // On open: a provider source lazy-injects its bundle (so the doc only pulls
  // provider JS the author actually reaches for), then reads its picker() spec;
  // the core source needs no load. Then runs an initial empty search.
  async function openSource() {
    loadError = null;
    if (source) {
      const kind = manifestKindForSource(source);
      if (kind) {
        providerLoading = true;
        await ensureProvider(kind);
        providerLoading = false;
      }
      sourceSpec = embedRegistry().providerForSource(source)?.picker?.();
      if (!sourceSpec) {
        // Bundle didn't register — surface it rather than impersonating the
        // core picker. (Common cause: the provider route is served by a
        // different origin than this module under `dev-with-hmr`.)
        loadError = `Couldn't load the ${sourceLabel} embed provider. Reload the page and try again.`;
        return;
      }
    } else {
      sourceSpec = undefined;
    }
    mode = sourceSpec?.mode ?? "table";
    await runSearch("");
  }

  async function runSearch(q: string) {
    if (source) {
      const provider = embedRegistry().providerForSource(source);
      const hits = (await provider?.search?.(q, 20)) ?? [];
      results = hits.map((h) => ({
        ref: h.ref,
        label: h.label,
        kind: h.kind,
        secondary: h.detail,
      }));
      return;
    }
    const hits = await searchResources(q, 20);
    results = hits
      .filter((h) => matchesFilter(h.kind))
      .map((h) => ({
        ref: h.ref,
        label: h.label,
        kind: h.kind,
        secondary: h.db,
      }));
  }

  // "table" keeps tables + views (both embed as a table); "database" keeps only
  // databases; undefined keeps everything. Only the core picker is filtered.
  function matchesFilter(kind: string): boolean {
    if (!filter) return true;
    if (filter === "database") return kind === "database";
    return kind === "table" || kind === "view";
  }

  function onQueryInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void runSearch(query.trim()), 150);
  }

  function choose(ref: string) {
    oninsert(ref, mode);
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

  {#if loadError}
    <p class="ds-embed-error">{loadError}</p>
    <div class="ds-embed-dialog__foot">
      <button type="button" class="ds-embed-cancel-btn" onclick={cancel}>Close</button>
    </div>
  {:else}
  <input
    class="ds-embed-search"
    type="text"
    placeholder={sourceSpec ? `Search ${sourceSpec.label}…` : corePlaceholder}
    bind:value={query}
    oninput={onQueryInput}
  />

  <ul class="ds-embed-results">
    {#if providerLoading}
      <li class="ds-embed-empty">Loading…</li>
    {:else}
      {#each results as r (r.ref)}
        <li>
          <button type="button" class="ds-embed-result" onclick={() => choose(r.ref)}>
            {#if r.kind}<span class="ds-embed-result-kind">{r.kind}</span>{/if}
            <span class="ds-embed-result-label">{r.label}</span>
            {#if r.secondary}<span class="ds-embed-result-db">{r.secondary}</span>{/if}
          </button>
        </li>
      {:else}
        <li class="ds-embed-empty">No matches</li>
      {/each}
    {/if}
  </ul>

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
  {/if}
</dialog>

<style>
  .ds-embed-dialog {
    width: min(480px, 92vw);
    border: 1px solid var(--pp-border);
    border-radius: 10px;
    padding: 16px;
    /* deliberate literal: heavier dialog drop-shadow alpha than --pp-shadow. */
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
    font: inherit;
    color: var(--pp-fg);
  }
  .ds-embed-dialog::backdrop {
    background: var(--pp-overlay);
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
    color: var(--pp-fg-muted);
    padding: 0 4px;
  }
  .ds-embed-error {
    margin: 4px 0 12px;
    padding: 10px 12px;
    border-radius: 6px;
    /* deliberate literal: light danger-callout background (red-50), distinct
       from the --pp-danger-bg wash. */
    background: #fef2f2;
    color: var(--pp-danger);
    font-size: 14px;
  }
  .ds-embed-search,
  .ds-embed-manual-input {
    width: 100%;
    padding: 7px 9px;
    border: 1px solid var(--pp-border);
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
    border: 1px solid var(--pp-border);
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
    /* deliberate literal: light-blue hover tint, no matching surface token. */
    background: #f2f8ff;
  }
  .ds-embed-result-kind {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--pp-fg-subtle);
    min-width: 42px;
  }
  .ds-embed-result-label {
    font-weight: 500;
  }
  .ds-embed-result-db {
    margin-left: auto;
    font-size: 12px;
    color: var(--pp-fg-subtle);
  }
  .ds-embed-empty {
    padding: 10px;
    color: var(--pp-fg-subtle);
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
    color: var(--pp-fg-muted);
    white-space: nowrap;
  }
  .ds-embed-mode {
    padding: 6px;
    border: 1px solid var(--pp-border);
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
    border: 1px solid var(--pp-border);
    background: var(--pp-bg);
    color: var(--pp-fg);
  }
  .ds-embed-insert-btn {
    border-color: var(--pp-accent);
    background: var(--pp-accent);
    color: var(--pp-accent-fg);
  }
  .ds-embed-insert-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
