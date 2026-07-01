<script lang="ts">
  /**
   * Right-hand rail hosting the document's collapsible side panels.
   *
   * Each panel is a self-contained, self-collapsing component — the rail only
   * stacks them (with a divider between sections) and provides the card / sticky
   * / scroll chrome. It holds Sources (edit-mode only, `showSources`) and Links
   * (both modes). To add another panel, wrap it in a `.sidebar-section` below.
   *
   * ≥1400px it floats in the right gutter (fixed); 800–1400px it's a sticky rail
   * beside the editor; below 800px it stacks under the document (see the media
   * queries).
   */
  import type { EditorView } from "prosemirror-view";
  import SourcesPanel from "./SourcesPanel.svelte";
  import LinksPanel from "./LinksPanel.svelte";
  import type { SourceStore } from "./sourceStore";

  let {
    view,
    docId,
    sourceStore = null,
    showSources = false,
  }: {
    view: EditorView | null;
    docId: string;
    sourceStore?: SourceStore | null;
    showSources?: boolean;
  } = $props();
</script>

<aside class="paper-sidebar" aria-label="Document panels">
  {#if showSources}
    <div class="sidebar-section">
      <SourcesPanel {view} {sourceStore} initiallyOpen />
    </div>
  {/if}
  <div class="sidebar-section">
    <LinksPanel {docId} />
  </div>
</aside>

<style>
  /* Base (<800px): stacked below the document, in normal flow. */
  .paper-sidebar {
    margin-top: 12px;
    border-top: 1px solid #e2e8f0;
  }
  /* The panels carry their own top margin/rule (for standalone stacking); drop
   * it so the rail owns spacing and each section supplies its own divider. */
  .paper-sidebar :global(.sources-panel),
  .paper-sidebar :global(.links-panel) {
    margin: 0;
    border-top: none;
    padding-top: 0;
  }
  /* Divider between stacked sections. */
  .sidebar-section + .sidebar-section {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid #e2e8f0;
  }

  /* ≥800px: a self-contained card. A plain border-left would only span the
   * panel's own (often short) height, leaving a stub floating beside a tall
   * document — the card reads as intentional at any content height. */
  @media (min-width: 800px) {
    .paper-sidebar {
      margin-top: 0;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      background: #fff;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
      padding: 8px 14px;
      overflow-y: auto;
    }
  }

  /* 800–1400px: the card sits in-flow as a sticky rail beside the (shrunk)
   * editor. */
  @media (min-width: 800px) and (max-width: 1399.98px) {
    .paper-sidebar {
      flex: 0 0 260px;
      width: 260px;
      position: sticky;
      top: 16px;
      align-self: flex-start;
      max-height: calc(100vh - 32px);
    }
  }

  /* ≥1400px: the card floats in the right gutter so the centred document column
   * is unaffected. */
  @media (min-width: 1400px) {
    .paper-sidebar {
      position: fixed;
      top: 72px;
      right: 24px;
      width: 280px;
      max-height: calc(100vh - 96px);
    }
  }
</style>
