<script lang="ts">
  /**
   * Create-a-new-page dialog opened from the `[[`-autocomplete's
   * "Create … page" row. Prefilled with the title the user typed after
   * `[[`, it POSTs to /-/paper/api/docs (the creator becomes the new
   * paper's manager server-side) and hands the new doc id back via
   * `onresult`; the editor turns that into a `paper_link`. A cancel /
   * Esc / failed create resolves `onresult` with null so the wiki-link
   * flow leaves the typed text alone. See wikiLinkSuggest.ts.
   */
  import { client } from "./client";

  let {
    open = $bindable(false),
    initialTitle = "",
    onresult,
  }: {
    open?: boolean;
    initialTitle?: string;
    /** Called exactly once per open: the new doc id, or null if cancelled. */
    onresult: (docId: number | null) => void;
  } = $props();

  let dialogEl: HTMLDialogElement | undefined = $state();
  let title = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  // Guards `onresult` to a single call per open — the success path closes the
  // dialog, which also fires `onclose` (the cancel route); without this both
  // would resolve the host's promise.
  let settled = false;

  function settle(result: number | null) {
    if (settled) return;
    settled = true;
    onresult(result);
  }

  // Drive the native <dialog> from `open`, reseeding the field from the
  // current `[[query` each time it opens.
  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    if (open && !el.open) {
      title = initialTitle;
      error = null;
      busy = false;
      settled = false;
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  });

  function cancel() {
    open = false;
  }

  async function submit(e: Event) {
    e.preventDefault();
    const name = title.trim();
    if (!name || busy) return;
    busy = true;
    error = null;
    const { data, error: err } = await client.POST("/-/paper/api/docs", {
      body: { name } as never,
    });
    busy = false;
    if (err || !data) {
      error = "Could not create the page. You may not have permission.";
      return;
    }
    const created = data as unknown as { id: number };
    settle(created.id);
    open = false;
  }
</script>

<dialog
  bind:this={dialogEl}
  class="create-page-dialog"
  onclose={() => {
    open = false;
    settle(null);
  }}
>
  <form onsubmit={submit}>
    <div class="create-page-dialog__head">
      <strong>Create page</strong>
      <button
        type="button"
        class="create-page-dialog__x"
        aria-label="Close"
        onclick={cancel}>×</button
      >
    </div>

    <label class="create-page-title">
      Title
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        bind:value={title}
        placeholder="Page title"
        autofocus
        disabled={busy}
      />
    </label>

    <p class="create-page-dialog__note">
      You'll be the manager of this new page.
    </p>

    {#if error}
      <p class="create-page-dialog__error" role="alert">{error}</p>
    {/if}

    <div class="create-page-dialog__foot">
      <button
        type="button"
        class="create-page-cancel-btn"
        onclick={cancel}
        disabled={busy}>Cancel</button
      >
      <button
        type="submit"
        class="create-page-create-btn"
        disabled={!title.trim() || busy}
      >
        {busy ? "Creating…" : "Create"}
      </button>
    </div>
  </form>
</dialog>

<style>
  .create-page-dialog {
    width: min(420px, 92vw);
    border: 1px solid var(--pp-border);
    border-radius: 10px;
    padding: 16px;
    /* deliberate literal: heavier dialog drop-shadow alpha than --pp-shadow. */
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
    font: inherit;
    color: var(--pp-fg);
  }
  .create-page-dialog::backdrop {
    background: var(--pp-overlay);
  }
  .create-page-dialog__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    font-size: 15px;
  }
  .create-page-dialog__x {
    border: none;
    background: transparent;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    color: var(--pp-fg-muted);
    padding: 0 4px;
  }
  .create-page-title {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--pp-fg-muted);
  }
  .create-page-title input {
    padding: 7px 9px;
    border: 1px solid var(--pp-border);
    border-radius: 6px;
    font: inherit;
    font-size: 14px;
  }
  .create-page-dialog__note {
    margin: 10px 0 0;
    font-size: 12px;
    color: var(--pp-fg-subtle);
  }
  /* deliberate literal: solid error-box pink/maroon, distinct from the faint
     --pp-danger-bg wash. */
  .create-page-dialog__error {
    margin: 10px 0 0;
    padding: 6px 10px;
    background: #ffd6d6;
    color: #5a0000;
    border-radius: 6px;
    font-size: 12px;
  }
  .create-page-dialog__foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .create-page-cancel-btn,
  .create-page-create-btn {
    padding: 6px 14px;
    border-radius: 999px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid var(--pp-border);
    background: var(--pp-bg);
    color: var(--pp-fg);
  }
  .create-page-create-btn {
    border-color: var(--pp-accent);
    background: var(--pp-accent);
    color: var(--pp-accent-fg);
  }
  .create-page-create-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* --- Dark theme (append-only; light rules untouched). Solid pink error box
     glares on dark; swap for a dark wash. Both theme conditions. --- */
  :global([data-theme="dark"]) .create-page-dialog__error {
    background: #3a1d1d;
    color: #ffb4ab;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root[data-theme="system"]) .create-page-dialog__error {
      background: #3a1d1d;
      color: #ffb4ab;
    }
  }
</style>
