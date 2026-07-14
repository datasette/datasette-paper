<script lang="ts">
  /**
   * Shared modal shell around <LinkGraph>. Hosted by both the index page (no
   * focus → the full graph) and the doc shell (focusId → the doc-centred ego
   * view). Backdrop-click and Escape both dismiss via `onClose`.
   *
   * <LinkGraph> renders only while `open`, so its dynamic d3-force import stays
   * deferred until the modal is actually opened.
   */
  import LinkGraph from "./LinkGraph.svelte";

  let {
    open,
    onClose,
    focusId,
  }: { open: boolean; onClose: () => void; focusId?: number } = $props();

  // Dismiss on Escape while open.
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

{#if open}
  <!-- Backdrop closes on click outside the dialog; Escape is handled above. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="graph-backdrop"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <div class="graph-dialog" role="dialog" aria-modal="true" aria-label="Link graph">
      <div class="graph-dialog-header">
        <h2>Link graph</h2>
        <button type="button" class="graph-close" aria-label="Close" onclick={onClose}
          >×</button
        >
      </div>
      <LinkGraph {focusId} />
    </div>
  </div>
{/if}

<style>
  .graph-backdrop {
    position: fixed;
    inset: 0;
    /* deliberate literal: lighter modal backdrop than --pp-overlay (.35). */
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 16px;
  }
  .graph-dialog {
    background: var(--pp-bg);
    border-radius: 8px;
    /* deliberate literal: heavier dialog drop-shadow alpha than --pp-shadow. */
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);
    padding: 12px 16px 16px;
    max-width: min(720px, 95vw);
    max-height: 90vh;
    overflow: auto;
  }
  .graph-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1em;
    margin-bottom: 8px;
  }
  .graph-dialog-header h2 {
    margin: 0;
    font-size: 1.05em;
    color: var(--pp-fg);
  }
  .graph-close {
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    color: var(--pp-fg-muted);
    padding: 2px 6px;
    border-radius: 4px;
  }
  .graph-close:hover {
    background: var(--pp-surface-2);
    color: var(--pp-fg);
  }
</style>
