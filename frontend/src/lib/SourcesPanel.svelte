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
  import type { EditorView } from "prosemirror-view";
  import { schema } from "./schema";
  import { normalizeSourceName } from "./sourceBlockView";
  import { listQueryableDatabases, runSqlQuery, type SqlResult } from "./sqlQuery";

  let { view }: { view: EditorView | null } = $props();

  type Row = { name: string | null; db: string | null; sql: string; pos: number };

  let open = $state(false);
  let dbs = $state<string[]>([]);
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
    if (open && dbs.length === 0) void listQueryableDatabases().then((d) => (dbs = d));
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

  // Inline editor state. `editingPos === null` while adding; a number while
  // editing an existing source; `undefined` when the form is closed.
  let editingPos = $state<number | null | undefined>(undefined);
  let draftName = $state("");
  let draftDb = $state<string>("");
  let draftSql = $state("");
  let probe = $state<SqlResult | null>(null);
  let probing = $state(false);

  function toggle(): void {
    open = !open;
  }

  function openAdd(): void {
    editingPos = null;
    draftName = "";
    draftDb = dbs[0] ?? "";
    draftSql = "";
    probe = null;
  }

  function openEdit(s: Row): void {
    editingPos = s.pos;
    draftName = s.name ?? "";
    draftDb = s.db ?? "";
    draftSql = s.sql;
    probe = null;
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
    if (editingPos === s.pos) closeForm();
  }

  /** Drop a value chip at the cursor referencing this source's first column. */
  async function insertValue(s: Row): Promise<void> {
    if (!view || !s.name) return;
    const result = await runSqlQuery(s.db ?? "", s.sql);
    const column = result.status === "ok" ? (result.columns?.[0] ?? null) : null;
    const node = schema.nodes.value.create({ source: s.name, column, format: null });
    view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
    view.focus();
  }
</script>

<section class="sources-panel">
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
              <span class="sources-panel-name">
                {s.name ?? "(unnamed)"}
                {#if s.name && dupNames.includes(s.name)}
                  <span class="sources-panel-warn" title="Duplicate source name">⚠</span>
                {/if}
              </span>
              <span class="sources-panel-db">{s.db ?? "—"}</span>
              <span class="sources-panel-actions">
                <button type="button" onclick={() => insertValue(s)} disabled={!s.name}
                  >Insert value</button
                >
                <button type="button" onclick={() => openEdit(s)}>Edit</button>
                <button type="button" onclick={() => del(s)}>Delete</button>
              </span>
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
    border-top: 1px solid #e2e8f0;
    padding-top: 8px;
    font-size: 14px;
  }
  .sources-panel-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    padding: 4px 0;
    cursor: pointer;
    color: #334155;
    font-weight: 600;
  }
  .sources-panel-count {
    font-weight: 400;
    color: #94a3b8;
  }
  .sources-panel-body {
    padding: 6px 0 4px;
  }
  .sources-panel-none {
    color: #94a3b8;
    padding: 4px 0;
  }
  .sources-panel-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sources-panel-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 0;
    border-bottom: 1px solid #f1f5f9;
  }
  .sources-panel-name {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 500;
    color: #1e293b;
  }
  .sources-panel-warn {
    color: #b45309;
    cursor: help;
  }
  .sources-panel-db {
    color: #64748b;
    font-size: 12px;
  }
  .sources-panel-actions {
    margin-left: auto;
    display: flex;
    gap: 4px;
  }
  .sources-panel-actions button,
  .sources-panel-add,
  .sources-panel-form-actions button {
    border: 1px solid #cbd5e1;
    background: #fff;
    border-radius: 5px;
    padding: 2px 8px;
    font-size: 12px;
    color: #334155;
    cursor: pointer;
  }
  .sources-panel-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .sources-panel-add {
    margin-top: 8px;
  }
  .sources-panel-form {
    margin-top: 8px;
    padding: 10px;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    background: #f8fafc;
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
    color: #64748b;
  }
  .sources-panel-field input,
  .sources-panel-field select,
  .sources-panel-field textarea {
    border: 1px solid #cbd5e1;
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
  .sources-panel-form-actions button.primary {
    background: #1b4f86;
    color: #fff;
    border-color: #1b4f86;
  }
  .sources-panel-probe {
    margin-top: 8px;
    font-size: 12px;
    color: #64748b;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .sources-panel-probe.is-error {
    color: #b91c1c;
  }
</style>
