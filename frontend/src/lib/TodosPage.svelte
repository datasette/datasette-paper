<!--
  @feat task-assign: the dedicated /-/paper/todos page. Read-only cross-doc
  TODO list for one actor (the signed-in user by default, or ?actor=<id> to view
  someone else's — the API's viewer-acl filter still gates doc visibility).
  Rows link into their doc; checking off happens in the editor, never here.
  Buckets (Overdue / Today / This week / Later / No due date) are computed
  client-side in the viewer's timezone.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { ActorResolver } from "./actorResolver";
  import { TOOLBAR_ICONS } from "./icons";
  import { loadPageData } from "./pageData";
  import { bucketTodos, dueChip, sectionBreadcrumb } from "./todos";
  import type { TodoRow, TodosResponse } from "./todos";

  type Status = "open" | "done" | "all";
  const STATUSES: { key: Status; label: string }[] = [
    { key: "open", label: "Open" },
    { key: "done", label: "Done" },
    { key: "all", label: "All" },
  ];

  const pageData = loadPageData<{ actor_id: string | null }>();
  const params = new URLSearchParams(window.location.search);
  const paramActor = params.get("actor");
  const selfActor = pageData.actor_id;
  // ?actor= wins; otherwise the signed-in user. Null only for an anonymous
  // visitor with no ?actor — that renders the sign-in prompt.
  const targetActor = paramActor ?? selfActor;
  const isSelf = !!targetActor && targetActor === selfActor;

  const resolver = new ActorResolver();
  // id → display name (id shown until resolved, exactly like mentionView).
  let names = $state<Record<string, string>>({});
  function resolveName(id: string): void {
    if (id in names) return;
    names[id] = id;
    resolver.request(id, (s) => {
      if (s.status === "ok") names = { ...names, [id]: s.name };
    });
  }

  let status = $state<Status>("open");
  let rows = $state<TodoRow[] | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  const buckets = $derived(rows ? bucketTodos(rows, new Date()) : []);
  const targetName = $derived(
    targetActor ? (names[targetActor] ?? targetActor) : "",
  );
  const heading = $derived(isSelf ? "Your TODOs" : `${targetName}'s TODOs`);

  async function load(): Promise<void> {
    if (!targetActor) return;
    loading = true;
    error = null;
    try {
      const resp = await fetch(
        `/-/paper/api/profile/${encodeURIComponent(targetActor)}/todos?status=${status}`,
      );
      if (!resp.ok) {
        error = "Could not load TODOs.";
        rows = [];
        return;
      }
      const data = (await resp.json()) as TodosResponse;
      rows = data.todos ?? [];
      // Resolve co-assignee names for the chips we'll show (multi-assignee).
      for (const r of rows) {
        if (r.assignees.length > 1) for (const a of r.assignees) resolveName(a);
      }
    } catch {
      error = "Could not load TODOs.";
      rows = [];
    } finally {
      loading = false;
    }
  }

  function setStatus(s: Status): void {
    if (s === status) return;
    status = s;
    void load();
  }

  onMount(() => {
    if (targetActor) resolveName(targetActor);
    void load();
    return () => resolver.dispose();
  });

  const now = new Date();
</script>

<div class="todos-page">
  {#if !targetActor}
    <div class="todos-empty">
      <h1>TODOs</h1>
      <p>Sign in to see your TODOs.</p>
    </div>
  {:else}
    <header class="todos-header">
      <h1>
        <a class="todos-who" href="/-/profile/{encodeURIComponent(targetActor)}">
          {heading}
        </a>
      </h1>
      <div class="todos-status" role="group" aria-label="Filter by status">
        {#each STATUSES as s (s.key)}
          <button
            type="button"
            class="todos-status-btn"
            class:is-active={status === s.key}
            aria-pressed={status === s.key}
            onclick={() => setStatus(s.key)}
          >
            {s.label}
          </button>
        {/each}
      </div>
    </header>

    {#if error}
      <p class="todos-message todos-error">{error}</p>
    {:else if loading && rows === null}
      <p class="todos-message">Loading…</p>
    {:else if buckets.length === 0}
      <p class="todos-message">
        {status === "open" ? "No open TODOs." : "Nothing here."}
      </p>
    {:else}
      {#each buckets as bucket (bucket.key)}
        <section class="todos-bucket">
          <h2 class="todos-bucket-head">
            {bucket.label}
            <span class="todos-bucket-count">{bucket.rows.length}</span>
          </h2>
          <ul class="todos-list">
            {#each bucket.rows as row (`${row.doc_id}:${row.ordinal}`)}
              {@const chip = dueChip(row.due, now)}
              {@const crumb = sectionBreadcrumb(row.section)}
              <li class="todos-row" class:is-done={row.checked}>
                <input
                  type="checkbox"
                  class="todos-check"
                  checked={row.checked}
                  disabled
                  aria-hidden="true"
                />
                <a class="todos-text" href={row.doc_url}>
                  {row.text || "(untitled task)"}
                </a>
                {#if row.assignees.length > 1}
                  <span class="todos-assignees">
                    {#each row.assignees as a (a)}
                      <span
                        class="todos-assignee"
                        class:is-inherited={row.assignee_inherited}
                        title={row.assignee_inherited
                          ? "Inherited from a parent task"
                          : undefined}>@{names[a] ?? a}</span
                      >
                    {/each}
                  </span>
                {/if}
                {#if chip}
                  <span
                    class="todos-due"
                    class:is-overdue={chip.tint === "overdue"}
                    class:is-today={chip.tint === "today"}
                  >
                    <span class="todos-due-icon">{@render calendarIcon()}</span>
                    {chip.label}
                  </span>
                {/if}
                <span class="todos-meta">
                  {#if crumb}<span class="todos-crumb">{crumb}</span>{/if}
                  <span class="todos-doc">{row.doc_name}</span>
                </span>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  {/if}
</div>

{#snippet calendarIcon()}
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="12"
    height="12"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
    {@html TOOLBAR_ICONS.calendarEvent}
  </svg>
{/snippet}

<style>
  .todos-page {
    max-width: 820px;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
    color: var(--pp-fg);
  }

  .todos-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1.25rem;
  }

  .todos-header h1 {
    margin: 0;
    font-size: 1.5rem;
  }

  .todos-who {
    color: inherit;
    text-decoration: none;
  }
  .todos-who:hover {
    text-decoration: underline;
  }

  .todos-status {
    display: inline-flex;
    border: 1px solid var(--pp-border);
    border-radius: 8px;
    overflow: hidden;
  }
  .todos-status-btn {
    border: none;
    background: var(--pp-bg);
    color: var(--pp-fg-muted);
    padding: 0.3rem 0.75rem;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .todos-status-btn + .todos-status-btn {
    border-left: 1px solid var(--pp-border);
  }
  .todos-status-btn.is-active {
    background: var(--pp-accent);
    color: var(--pp-accent-fg, #fff);
  }

  .todos-message {
    color: var(--pp-fg-muted);
  }
  .todos-error {
    color: var(--pp-danger);
  }

  .todos-bucket {
    margin-bottom: 1.5rem;
  }
  .todos-bucket-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--pp-fg-subtle, var(--pp-fg-muted));
    margin: 0 0 0.5rem;
  }
  .todos-bucket-count {
    font-weight: 600;
    color: var(--pp-fg-muted);
    background: var(--pp-surface);
    border-radius: 10px;
    padding: 0 0.4rem;
    font-size: 0.75rem;
  }

  .todos-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .todos-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--pp-border);
  }
  .todos-row:last-child {
    border-bottom: none;
  }

  .todos-check {
    flex: 0 0 auto;
    align-self: center;
    margin: 0;
  }
  .todos-text {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--pp-fg);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .todos-text:hover {
    text-decoration: underline;
  }
  .todos-row.is-done .todos-text {
    color: var(--pp-fg-muted);
    text-decoration: line-through;
  }

  .todos-assignees {
    flex: 0 0 auto;
    display: inline-flex;
    gap: 0.25rem;
  }
  .todos-assignee {
    color: var(--pp-fg-muted);
    background: var(--pp-surface);
    border-radius: 10px;
    padding: 0.05rem 0.4rem;
    font-size: 0.6875rem;
    white-space: nowrap;
  }
  .todos-assignee.is-inherited {
    opacity: 0.6;
  }

  .todos-due {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    color: var(--pp-fg-muted);
    font-size: 0.75rem;
    white-space: nowrap;
  }
  .todos-due-icon {
    display: inline-flex;
    align-items: center;
  }
  .todos-due-icon :global(svg) {
    width: 0.8em;
    height: 0.8em;
  }
  .todos-due.is-overdue {
    color: var(--pp-danger);
  }
  .todos-due.is-today {
    color: var(--pp-warn);
  }

  .todos-meta {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: var(--pp-fg-muted);
    max-width: 40%;
    overflow: hidden;
  }
  .todos-crumb {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .todos-doc {
    font-weight: 600;
    color: var(--pp-fg);
    white-space: nowrap;
  }

  .todos-empty h1 {
    font-size: 1.5rem;
  }
</style>
