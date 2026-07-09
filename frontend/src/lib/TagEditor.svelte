<script lang="ts">
  import { client } from "./client";

  // Owner-only modal to edit one doc's tags. Each add/remove hits the API
  // immediately (the server normalizes + returns the canonical set) and the
  // result is pushed back to the parent via onChange so the list chips stay
  // in sync. `vocab` is the instance-wide tag vocabulary for autocomplete.
  let {
    docId,
    docName,
    tags,
    vocab = [],
    onChange,
    onClose,
  }: {
    docId: number;
    docName: string;
    tags: string[];
    vocab?: string[];
    onChange: (docId: number, tags: string[]) => void;
    onClose: () => void;
  } = $props();

  // Snapshot the doc's tags once when the editor opens; subsequent edits
  // mutate this local copy (the modal unmounts on close, so no staleness).
  // svelte-ignore state_referenced_locally
  let current = $state<string[]>([...tags]);
  let draft = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  // Suggestions: known tags not already applied, prefix/substring on draft.
  let suggestions = $derived(
    vocab
      .filter((t) => !current.includes(t))
      .filter((t) => draft.trim() === "" || t.includes(draft.trim().toLowerCase())),
  );

  async function add(raw: string) {
    const tag = raw.trim();
    if (!tag || busy) return;
    busy = true;
    error = null;
    const { data, error: err } = await client.POST(
      "/-/paper/api/docs/{doc_id}/tags/add",
      {
        params: { path: { doc_id: docId } },
        body: { tag } as never,
      },
    );
    busy = false;
    if (err || !data) {
      error = "Could not add tag";
      return;
    }
    current = (data as { tags: string[] }).tags;
    draft = "";
    onChange(docId, current);
  }

  async function remove(tag: string) {
    if (busy) return;
    busy = true;
    error = null;
    const { data, error: err } = await client.POST(
      "/-/paper/api/docs/{doc_id}/tags/remove",
      {
        params: { path: { doc_id: docId } },
        body: { tag } as never,
      },
    );
    busy = false;
    if (err || !data) {
      error = "Could not remove tag";
      return;
    }
    current = (data as { tags: string[] }).tags;
    onChange(docId, current);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void add(draft);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }
</script>

<!-- Backdrop closes on click outside the dialog; Escape is handled by the input. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="tag-editor-backdrop"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div
    class="tag-editor"
    role="dialog"
    aria-label="Edit tags for {docName}"
    tabindex="-1"
  >
    <h2>Tags · {docName}</h2>

    {#if error}<div class="te-error">{error}</div>{/if}

    <div class="te-chips">
      {#each current as tag (tag)}
        <span class="tag-chip">
          {tag}
          <button
            type="button"
            class="te-remove"
            aria-label="Remove {tag}"
            disabled={busy}
            onclick={() => remove(tag)}>×</button
          >
        </span>
      {:else}
        <span class="te-empty">No tags yet.</span>
      {/each}
    </div>

    <div class="te-add">
      <input
        type="text"
        list="tag-vocab-{docId}"
        placeholder="Add a tag…"
        bind:value={draft}
        disabled={busy}
        onkeydown={onKeydown}
      />
      <datalist id="tag-vocab-{docId}">
        {#each suggestions as s (s)}
          <option value={s}></option>
        {/each}
      </datalist>
      <button type="button" disabled={busy || !draft.trim()} onclick={() => add(draft)}
        >Add</button
      >
    </div>

    <div class="te-footer">
      <button type="button" class="te-done" onclick={onClose}>Done</button>
    </div>
  </div>
</div>

<style>
  .tag-editor-backdrop {
    position: fixed;
    inset: 0;
    /* deliberate literal: lighter modal backdrop than --pp-overlay (.35). */
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .tag-editor {
    background: var(--pp-bg);
    border-radius: 8px;
    /* deliberate literal: heavier dialog drop-shadow alpha than --pp-shadow. */
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);
    padding: 18px 20px;
    width: 380px;
    max-width: 90vw;
    font-family: inherit;
  }
  .tag-editor h2 {
    margin: 0 0 12px;
    font-size: 1.05em;
    color: var(--pp-fg);
  }
  /* deliberate literal: solid error-box pink/maroon, distinct from the faint
     --pp-danger-bg wash. */
  .te-error {
    background: #ffd6d6;
    color: #5a0000;
    padding: 4px 8px;
    border-radius: 4px;
    margin-bottom: 8px;
    font-size: 0.9em;
  }
  .te-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-height: 1.8em;
    margin-bottom: 12px;
  }
  .te-empty {
    color: var(--pp-fg-subtle);
    font-size: 0.9em;
  }
  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    background: var(--pp-surface-2);
    color: var(--pp-fg);
    border: 1px solid var(--pp-border);
    border-radius: 9px;
    padding: 1px 4px 1px 8px;
    font-size: 12px;
    line-height: 1.5;
  }
  .te-remove {
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--pp-fg-muted);
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
  }
  /* deliberate literal: one-off dark danger red, distinct from --pp-danger. */
  .te-remove:hover:not(:disabled) {
    color: #8a1a1a;
  }
  .te-add {
    display: flex;
    gap: 6px;
  }
  .te-add input {
    flex: 1;
    padding: 6px 8px;
    font: inherit;
  }
  .te-add button,
  .te-done {
    border: 1px solid var(--pp-border-strong);
    background: var(--pp-bg);
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
    font: inherit;
  }
  .te-add button:hover:not(:disabled),
  .te-done:hover {
    background: var(--pp-surface-2);
  }
  .te-footer {
    margin-top: 14px;
    text-align: right;
  }

  /* --- Dark theme (append-only; light rules untouched). Solid pink error box +
     dark-red remove-hover both fail on dark; swap for dark wash + lifted red.
     Both theme conditions. --- */
  :global([data-theme="dark"]) .te-error {
    background: #3a1d1d;
    color: #ffb4ab;
  }
  :global([data-theme="dark"]) .te-remove:hover:not(:disabled) {
    color: #ff7b72;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root[data-theme="system"]) .te-error {
      background: #3a1d1d;
      color: #ffb4ab;
    }
    :global(:root[data-theme="system"])
      .te-remove:hover:not(:disabled) {
      color: #ff7b72;
    }
  }
</style>
