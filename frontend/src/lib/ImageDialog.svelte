<script lang="ts">
  /**
   * Insert-image dialog opened from the toolbar. Two ways to supply an image —
   * paste into a drop/paste zone, or upload from the computer — then preview it
   * and confirm with Insert. The chosen image is handed back as a `data:` URL
   * via `oninsert`; the toolbar turns it into an `image` node. See image.ts.
   */
  import { readImageFile } from "./image";

  let {
    open = $bindable(false),
    oninsert,
  }: {
    open?: boolean;
    oninsert: (src: string, alt: string) => void;
  } = $props();

  let dialogEl: HTMLDialogElement | undefined = $state();
  let mode = $state<"paste" | "upload">("paste");
  let dataUrl = $state<string | null>(null);
  let alt = $state("");
  let error = $state<string | null>(null);

  function reset() {
    mode = "paste";
    dataUrl = null;
    alt = "";
    error = null;
  }

  // Drive the native <dialog> from the bound `open` prop.
  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  });

  async function take(file: File | undefined, fallbackAlt = "") {
    if (!file) return;
    error = null;
    try {
      dataUrl = await readImageFile(file);
      // Default the alt text to the file name without its extension.
      if (!alt) alt = fallbackAlt.replace(/\.[^.]+$/, "");
    } catch (err) {
      dataUrl = null;
      error = err instanceof Error ? err.message : "Could not read the image.";
    }
  }

  function onPaste(e: ClipboardEvent) {
    const file = Array.from(e.clipboardData?.items ?? [])
      .find((i) => i.kind === "file" && i.type.startsWith("image/"))
      ?.getAsFile();
    if (file) {
      e.preventDefault();
      void take(file);
    }
  }

  function onUpload(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    void take(input.files?.[0], input.files?.[0]?.name ?? "");
  }

  function cancel() {
    open = false;
  }

  function confirmInsert() {
    if (!dataUrl) return;
    oninsert(dataUrl, alt.trim());
    open = false;
  }
</script>

<dialog
  bind:this={dialogEl}
  class="image-dialog"
  onclose={() => {
    open = false;
    reset();
  }}
>
  <div class="image-dialog__head">
    <strong>Insert image</strong>
    <button type="button" class="image-dialog__x" aria-label="Close" onclick={cancel}>×</button>
  </div>

  <div class="image-dialog__tabs" role="tablist">
    <button
      type="button"
      role="tab"
      class="img-tab"
      class:active={mode === "paste"}
      aria-selected={mode === "paste"}
      onclick={() => (mode = "paste")}
    >
      Paste image
    </button>
    <button
      type="button"
      role="tab"
      class="img-tab"
      class:active={mode === "upload"}
      aria-selected={mode === "upload"}
      onclick={() => (mode = "upload")}
    >
      Upload from computer
    </button>
  </div>

  {#if mode === "paste"}
    <div
      class="image-paste-zone"
      tabindex="0"
      role="button"
      onpaste={onPaste}
      aria-label="Paste an image here"
    >
      Click here, then paste an image (⌘V / Ctrl+V)
    </div>
  {:else}
    <label class="image-upload">
      <input
        class="image-upload-input"
        type="file"
        accept="image/*"
        onchange={onUpload}
      />
      <span>Choose an image file…</span>
    </label>
  {/if}

  {#if error}
    <p class="image-dialog__error" role="alert">{error}</p>
  {/if}

  {#if dataUrl}
    <div class="image-preview-wrap">
      <img class="image-preview" src={dataUrl} alt={alt || "Preview"} />
    </div>
    <label class="image-alt">
      Alt text
      <input type="text" bind:value={alt} placeholder="Describe the image" />
    </label>
  {/if}

  <div class="image-dialog__foot">
    <button type="button" class="image-cancel-btn" onclick={cancel}>Cancel</button>
    <button
      type="button"
      class="image-insert-btn"
      disabled={!dataUrl}
      onclick={confirmInsert}
    >
      Insert
    </button>
  </div>
</dialog>

<style>
  .image-dialog {
    width: min(440px, 92vw);
    border: 1px solid var(--pp-border);
    border-radius: 10px;
    padding: 16px;
    /* deliberate literal: heavier dialog drop-shadow alpha than --pp-shadow. */
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
    font: inherit;
    color: var(--pp-fg);
  }
  .image-dialog::backdrop {
    background: var(--pp-overlay);
  }
  .image-dialog__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    font-size: 15px;
  }
  .image-dialog__x {
    border: none;
    background: transparent;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    color: var(--pp-fg-muted);
    padding: 0 4px;
  }
  .image-dialog__tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--pp-border);
    margin-bottom: 12px;
  }
  .img-tab {
    border: none;
    background: transparent;
    padding: 6px 10px;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    color: var(--pp-fg-muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .img-tab.active {
    color: var(--pp-accent);
    border-bottom-color: var(--pp-accent);
  }
  .image-paste-zone {
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    min-height: 110px;
    padding: 12px;
    border: 2px dashed var(--pp-border-strong);
    border-radius: 8px;
    color: var(--pp-fg-muted);
    font-size: 13px;
    cursor: text;
    background: var(--pp-surface);
  }
  /* deliberate literals: sky-blue focus/drag-active ring + tint, no matching
     accent-focus tokens (--pp-focus-ring is the darker brand blue). */
  .image-paste-zone:focus {
    outline: none;
    border-color: #4a9eff;
    background: #f2f8ff;
  }
  .image-upload {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 110px;
    padding: 12px;
    border: 2px dashed var(--pp-border-strong);
    border-radius: 8px;
    background: var(--pp-surface);
    font-size: 13px;
    color: var(--pp-fg-muted);
    cursor: pointer;
  }
  /* deliberate literal: solid error-box pink/maroon, distinct from the faint
     --pp-danger-bg wash. */
  .image-dialog__error {
    margin: 10px 0 0;
    padding: 6px 10px;
    background: #ffd6d6;
    color: #5a0000;
    border-radius: 6px;
    font-size: 12px;
  }
  .image-preview-wrap {
    margin-top: 12px;
    padding: 8px;
    border: 1px solid var(--pp-border);
    border-radius: 8px;
    background: var(--pp-bg);
    text-align: center;
  }
  .image-preview {
    max-width: 100%;
    max-height: 220px;
    height: auto;
    border-radius: 4px;
  }
  .image-alt {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 12px;
    font-size: 12px;
    color: var(--pp-fg-muted);
  }
  .image-alt input {
    padding: 6px 8px;
    border: 1px solid var(--pp-border);
    border-radius: 6px;
    font: inherit;
  }
  .image-dialog__foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  .image-cancel-btn,
  .image-insert-btn {
    padding: 6px 14px;
    border-radius: 999px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid var(--pp-border);
    background: var(--pp-bg);
    color: var(--pp-fg);
  }
  .image-insert-btn {
    border-color: var(--pp-accent);
    background: var(--pp-accent);
    color: var(--pp-accent-fg);
  }
  .image-insert-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
