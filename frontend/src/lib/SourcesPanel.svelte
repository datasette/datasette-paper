<script lang="ts">
  /**
   * Doc-level panel listing the document's data sources (named `source` nodes)
   * with add / edit / delete and a Test probe. Sources live IN the ProseMirror
   * doc, so this is a view/editor over those nodes: it reads them from
   * `view.state.doc` and every mutation dispatches a PM transaction (which
   * collaborates via the step log like any edit).
   *
   * PM transactions don't trigger Svelte rerenders, so we RAF-poll a `tick`
   * (the Toolbar pattern) and `$derived` the source list off it. Editing uses
   * an inline expanding form rather than a separate <dialog> — simpler, and it
   * keeps the panel self-contained.
   */
  import { untrack } from "svelte";
  import type { EditorView } from "prosemirror-view";
  import { schema } from "./schema";
  import { normalizeSourceName } from "./sourceBlockView";
  import { listQueryableDatabases, runSqlQuery, type SqlResult } from "./sqlQuery";
  import { TOOLBAR_ICONS, type ToolbarIconName } from "./icons";
  import type { SourceStore } from "./sourceStore";

  // `initiallyOpen` lets a host (the right sidebar) expand the panel on mount;
  // stacked inline it defaults collapsed. `embedded` renders the panel headless
  // — no self-collapse caret, always open — for a host (the icon rail) that owns
  // open/closed itself. `sourceStore` (when provided) is the live source runner,
  // read for each source's column count ("N values").
  let {
    view,
    initiallyOpen = false,
    embedded = false,
    sourceStore = null,
  }: {
    view: EditorView | null;
    initiallyOpen?: boolean;
    embedded?: boolean;
    sourceStore?: SourceStore | null;
  } = $props();

  type Row = { name: string | null; db: string | null; sql: string; pos: number };

  // Capture the host's initial preference once; toggling is local thereafter.
  // Embedded: always open (the rail owns visibility, so there's no toggle here).
  let open = $state(untrack(() => (embedded ? true : initiallyOpen)));
  let dbs = $state<string[]>([]);
  // One-shot latch for the db-list fetch. Guarding on `dbs.length === 0`
  // instead would re-arm forever when `/.json` exposes no queryable database:
  // the effect reads `dbs.length`, assigns a fresh `dbs = []`, and Svelte
  // re-runs it on the new-array reference → a `/.json` request per frame.
  let dbsRequested = $state(false);
  let tick = $state(0);

  // RAF-poll so the list reflects doc edits (PM txns don't rerender Svelte).
  $effect(() => {
    if (!open) return;
    let raf = 0;
    const loop = () => {
      tick++;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  });

  $effect(() => {
    if (open && !dbsRequested) {
      dbsRequested = true;
      void listQueryableDatabases().then((d) => (dbs = d));
    }
  });

  const sources = $derived.by<Row[]>(() => {
    void tick;
    if (!view) return [];
    const out: Row[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "source") {
        out.push({
          name: node.attrs.name ?? null,
          db: node.attrs.db ?? null,
          sql: node.textContent,
          pos,
        });
        return false;
      }
      return true;
    });
    return out;
  });

  // Duplicate names are ambiguous for ${{name.col}}; flag them.
  const dupNames = $derived.by<string[]>(() => {
    const counts: Record<string, number> = {};
    for (const s of sources) {
      if (s.name) counts[s.name] = (counts[s.name] ?? 0) + 1;
    }
    return Object.keys(counts).filter((n) => counts[n] > 1);
  });

  // How many `value` atoms reference each source name, so a row can show
  // "Used N times" (and flag unused sources). Walk the doc counting value
  // nodes by their `source` attr.
  const usage = $derived.by<Record<string, number>>(() => {
    void tick;
    const counts: Record<string, number> = {};
    if (!view) return counts;
    view.state.doc.descendants((node) => {
      if (node.type.name === "value" && node.attrs.source) {
        const name = String(node.attrs.source);
        counts[name] = (counts[name] ?? 0) + 1;
      }
    });
    return counts;
  });

  // Column counts per source ("N values"), fed live from the source store — the
  // same deduped runs that resolve value chips, so no extra queries here. Keyed
  // by name; absent until a source resolves (or when no store is wired).
  let columnCounts = $state<Record<string, number>>({});
  // Stable dependency: only re-subscribe when the *set* of names changes, not on
  // every RAF tick (sources is rebuilt each frame).
  const sourceNamesKey = $derived(
    sources
      .map((s) => s.name)
      .filter((n): n is string => !!n)
      .join("\n"),
  );
  $effect(() => {
    const key = sourceNamesKey;
    if (!sourceStore) return;
    const names = key ? key.split("\n") : [];
    const unsubs = names.map((name) =>
      sourceStore.subscribe(name, (state) => {
        columnCounts[name] = state.status === "ok" ? state.columns.length : 0;
      }),
    );
    return () => unsubs.forEach((u) => u());
  });

  function isUnused(s: Row): boolean {
    return (s.name ? (usage[s.name] ?? 0) : 0) === 0;
  }

  function usageLabel(s: Row): string {
    const n = s.name ? (usage[s.name] ?? 0) : 0;
    const usedPart = n === 0 ? "not used" : `used ${n} ${n === 1 ? "time" : "times"}`;
    const cols = s.name && s.name in columnCounts ? columnCounts[s.name] : null;
    // Without a known column count (no store / not resolved yet) show the
    // stand-alone usage phrase; otherwise prefix "N values".
    if (cols === null) return n === 0 ? "Not used" : `Used ${n} ${n === 1 ? "time" : "times"}`;
    return `${cols} value${cols === 1 ? "" : "s"}, ${usedPart}`;
  }

  // Inline editor state. `editingPos === null` while adding; a number while
  // editing an existing source; `undefined` when the form is closed.
  let editingPos = $state<number | null | undefined>(undefined);
  let draftName = $state("");
  let draftDb = $state<string>("");
  let draftSql = $state("");
  let probe = $state<SqlResult | null>(null);
  let probing = $state(false);
  // Deleting is two-step: the trash icon arms a per-row confirmation (holds the
  // source's pos) rather than deleting immediately.
  let confirmDeletePos = $state<number | null>(null);

  function toggle(): void {
    open = !open;
  }

  function openAdd(): void {
    editingPos = null;
    draftName = "";
    draftDb = dbs[0] ?? "";
    draftSql = "";
    probe = null;
    confirmDeletePos = null;
  }

  function openEdit(s: Row): void {
    editingPos = s.pos;
    draftName = s.name ?? "";
    draftDb = s.db ?? "";
    draftSql = s.sql;
    probe = null;
    confirmDeletePos = null;
  }

  function closeForm(): void {
    editingPos = undefined;
    probe = null;
  }

  async function test(): Promise<void> {
    probing = true;
    probe = await runSqlQuery(draftDb, draftSql);
    probing = false;
  }

  function save(): void {
    if (!view) return;
    const name = normalizeSourceName(draftName) || null;
    const db = draftDb || null;
    const content = draftSql ? [schema.text(draftSql)] : [];
    const node = schema.nodes.source.create({ name, db }, content);
    const { state } = view;
    if (editingPos == null) {
      // Append a new source at the end of the doc.
      view.dispatch(state.tr.insert(state.doc.content.size, node).scrollIntoView());
    } else {
      const existing = state.doc.nodeAt(editingPos);
      if (existing && existing.type.name === "source") {
        view.dispatch(
          state.tr.replaceWith(editingPos, editingPos + existing.nodeSize, node),
        );
      }
    }
    view.focus();
    closeForm();
  }

  function del(s: Row): void {
    if (!view) return;
    const { state } = view;
    const node = state.doc.nodeAt(s.pos);
    if (node && node.type.name === "source") {
      view.dispatch(state.tr.delete(s.pos, s.pos + node.nodeSize));
      view.focus();
    }
    confirmDeletePos = null;
    if (editingPos === s.pos) closeForm();
  }
</script>

{#snippet icon(name: ToolbarIconName)}
  <svg
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

<section class="sources-panel" class:is-embedded={embedded}>
  {#if embedded}
    <h3 class="sources-panel-heading">
      Sources
      {#if sources.length}<span class="sources-panel-count">{sources.length}</span>{/if}
    </h3>
  {:else}
    <button
      type="button"
      class="sources-panel-toggle"
      aria-expanded={open}
      onclick={toggle}
    >
      <span class="sources-panel-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      Sources
      {#if sources.length}<span class="sources-panel-count">{sources.length}</span>{/if}
    </button>
  {/if}

  {#if open}
    <div class="sources-panel-body">
      {#if sources.length === 0}
        <div class="sources-panel-none">
          No data sources yet. Add one, then reference it inline as
          <code>{"${{name.column}}"}</code>.
        </div>
      {:else}
        <ul class="sources-panel-list">
          {#each sources as s (s.pos)}
            <li class="sources-panel-item">
              <div class="sources-panel-item-head">
                <span class="sources-panel-name" title={s.name ?? "(unnamed)"}>
                  {s.name ?? "(unnamed)"}
                  {#if s.name && dupNames.includes(s.name)}
                    <span class="sources-panel-warn" title="Duplicate source name">⚠</span>
                  {/if}
                </span>
                <span class="sources-panel-row-actions">
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label="Edit source"
                    title="Edit source"
                    onclick={() => openEdit(s)}>{@render icon("pencil")}</button
                  >
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label="Delete source"
                    title="Delete source"
                    onclick={() => (confirmDeletePos = s.pos)}>{@render icon("trash3")}</button
                  >
                </span>
              </div>
              {#if s.db}
                <a class="sources-panel-db" href={`/${encodeURIComponent(s.db)}`} title={`Open ${s.db} in Datasette`}>
                  {@render icon("database")}<span>{s.db}</span>
                </a>
              {:else}
                <span class="sources-panel-db is-none">{@render icon("database")}<span>—</span></span>
              {/if}
              <span class="sources-panel-usage" class:is-unused={isUnused(s)}
                >{usageLabel(s)}</span
              >
              {#if confirmDeletePos === s.pos}
                <div class="sources-panel-confirm">
                  <span class="sources-panel-confirm-text">Delete this source?</span>
                  <button type="button" onclick={() => (confirmDeletePos = null)}>Cancel</button>
                  <button type="button" class="danger" onclick={() => del(s)}>Delete</button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if editingPos === undefined}
        <button type="button" class="sources-panel-add" onclick={openAdd}>+ Add source</button>
      {:else}
        <div class="sources-panel-form">
          <label class="sources-panel-field">
            <span>Name</span>
            <input type="text" bind:value={draftName} placeholder="revenue" />
          </label>
          <label class="sources-panel-field">
            <span>Database</span>
            <select bind:value={draftDb}>
              {#each dbs as db (db)}
                <option value={db}>{db}</option>
              {/each}
            </select>
          </label>
          <label class="sources-panel-field">
            <span>SQL</span>
            <textarea bind:value={draftSql} rows="3" placeholder="select … "></textarea>
          </label>
          <div class="sources-panel-form-actions">
            <button type="button" onclick={test} disabled={probing}>Test</button>
            <span class="sources-panel-spacer"></span>
            <button type="button" onclick={closeForm}>Cancel</button>
            <button type="button" class="primary" onclick={save}>Save</button>
          </div>
          {#if probe}
            <div class="sources-panel-probe" class:is-error={probe.status !== "ok"}>
              {#if probe.status === "ok"}
                {(probe.columns ?? []).length} columns: {(probe.columns ?? []).join(", ")}
                · {(probe.rows ?? []).length} rows
              {:else if probe.status === "denied"}
                No access to this database
              {:else if probe.status === "empty"}
                Enter a database and query
              {:else}
                {probe.error}
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .sources-panel {
    margin-top: 12px;
    border-top: 1px solid var(--pp-border);
    padding-top: 8px;
    font-size: 14px;
  }
  /* Embedded (icon-rail flyout): the host supplies the card chrome, so drop the
   * standalone top rule and the body's nesting indent. */
  .sources-panel.is-embedded {
    margin-top: 0;
    border-top: none;
    padding-top: 0;
  }
  .sources-panel.is-embedded .sources-panel-body {
    padding-left: 0;
  }
  .sources-panel-heading {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--pp-fg-muted);
  }
  .sources-panel-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    padding: 4px 0;
    cursor: pointer;
    color: var(--pp-fg);
    font-weight: 600;
  }
  .sources-panel-count {
    font-weight: 400;
    color: var(--pp-fg-subtle);
  }
  .sources-panel-body {
    /* Slight indent so the body reads as nested under the toggle header. */
    padding: 6px 0 4px 10px;
  }
  .sources-panel-none {
    color: var(--pp-fg-subtle);
    padding: 4px 0;
  }
  .sources-panel-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sources-panel-item {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
    padding: 8px 0;
    border-bottom: 1px solid var(--pp-surface-2);
  }
  /* Name row: title left, edit/delete icons floated right. */
  .sources-panel-item-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .sources-panel-name {
    flex: 1;
    min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 600;
    font-size: 13px;
    color: var(--pp-fg);
    /* Title: never let a long source name blow out the panel width. */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* deliberate literal: one-off amber warn, distinct from --pp-warn. */
  .sources-panel-warn {
    color: #b45309;
    cursor: help;
  }
  .sources-panel-row-actions {
    flex-shrink: 0;
    display: flex;
    gap: 2px;
  }
  /* Database: icon + name, linking to the Datasette database page. */
  .sources-panel-db {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    width: fit-content;
    max-width: 100%;
    font-size: 12px;
    color: var(--pp-accent);
    text-decoration: none;
  }
  .sources-panel-db > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  a.sources-panel-db:hover {
    text-decoration: underline;
  }
  .sources-panel-db.is-none {
    color: var(--pp-fg-subtle);
  }
  .sources-panel-db :global(svg) {
    flex-shrink: 0;
    opacity: 0.75;
  }
  /* "Used N times" on its own line after the database. */
  .sources-panel-usage {
    font-size: 12px;
    color: var(--pp-fg-muted);
  }
  .sources-panel-usage.is-unused {
    color: var(--pp-fg-subtle);
    font-style: italic;
  }
  .sources-panel-item button,
  .sources-panel-add,
  .sources-panel-form-actions button {
    border: 1px solid var(--pp-border);
    background: var(--pp-bg);
    border-radius: 5px;
    padding: 2px 8px;
    font-size: 12px;
    color: var(--pp-fg);
    cursor: pointer;
  }
  .sources-panel-item button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* Edit / Delete are square icon buttons. */
  .sources-panel-item .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px;
    color: var(--pp-fg-muted);
  }
  .sources-panel-item .icon-btn:hover {
    color: var(--pp-fg);
    background: var(--pp-surface-2);
  }
  .sources-panel-confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin-top: 2px;
  }
  .sources-panel-confirm-text {
    font-size: 12px;
    color: var(--pp-danger);
  }
  /* deliberate literal: brighter filled-danger button (red-600), distinct from
     the --pp-danger text color; its hover settles to --pp-danger. */
  .sources-panel-item button.danger {
    border-color: #dc2626;
    background: #dc2626;
    color: var(--pp-accent-fg);
  }
  .sources-panel-item button.danger:hover {
    background: var(--pp-danger);
  }
  .sources-panel-add {
    margin-top: 8px;
  }
  .sources-panel-form {
    margin-top: 8px;
    padding: 10px;
    border: 1px solid var(--pp-border);
    border-radius: 8px;
    background: var(--pp-surface);
  }
  .sources-panel-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 8px;
  }
  .sources-panel-field span {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--pp-fg-muted);
  }
  .sources-panel-field input,
  .sources-panel-field select,
  .sources-panel-field textarea {
    border: 1px solid var(--pp-border);
    border-radius: 5px;
    padding: 4px 6px;
    font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .sources-panel-form-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sources-panel-spacer {
    flex: 1;
  }
  /* deliberate literal: deep-navy primary button, distinct from --pp-accent. */
  .sources-panel-form-actions button.primary {
    background: #1b4f86;
    color: var(--pp-accent-fg);
    border-color: #1b4f86;
  }
  .sources-panel-probe {
    margin-top: 8px;
    font-size: 12px;
    color: var(--pp-fg-muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .sources-panel-probe.is-error {
    color: var(--pp-danger);
  }
</style>
