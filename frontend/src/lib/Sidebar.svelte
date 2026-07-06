<script lang="ts">
  /**
   * Right-hand icon rail (Observable-style) for the document's side panels.
   *
   * Collapsed by default: a thin vertical strip of icons pinned to the viewport's
   * right edge. Clicking an icon opens that section as a flyout card to the left
   * of the rail; clicking the active icon again (or Escape) closes it. Only one
   * section is open at a time — the rail owns open/closed, so the panels render
   * in `embedded` mode (no self-collapse caret).
   *
   * Sections: Sources (edit-mode only, `showSources`) and Links (both modes). To
   * add another, give it a rail entry below and a branch in the flyout.
   */
  import type { EditorView } from "prosemirror-view";
  import SourcesPanel from "./SourcesPanel.svelte";
  import LinksPanel from "./LinksPanel.svelte";
  import { TOOLBAR_ICONS, type ToolbarIconName } from "./icons";
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

  type SectionId = "sources" | "links";
  type Section = { id: SectionId; label: string; icon: ToolbarIconName };

  // Rail order (top → bottom). Sources is edit-mode only.
  const sections = $derived<Section[]>([
    ...(showSources
      ? [{ id: "sources", label: "Sources", icon: "database" } as Section]
      : []),
    { id: "links", label: "Links", icon: "link" },
  ]);

  let active = $state<SectionId | null>(null);

  function toggleSection(id: SectionId): void {
    active = active === id ? null : id;
  }

  // If Sources disappears (mode → view) while it's the open section, close.
  $effect(() => {
    if (active && !sections.some((s) => s.id === active)) active = null;
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && active) {
      active = null;
      e.stopPropagation();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="paper-rail-wrap">
  <nav class="paper-rail" aria-label="Document panels">
    {#each sections as s (s.id)}
      <button
        type="button"
        class="paper-rail-btn"
        class:is-active={active === s.id}
        aria-label={s.label}
        aria-pressed={active === s.id}
        title={s.label}
        onclick={() => toggleSection(s.id)}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-hidden="true"
        >
          <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
          {@html TOOLBAR_ICONS[s.icon]}
        </svg>
      </button>
    {/each}
  </nav>

  {#if active}
    <div class="paper-rail-flyout" role="region" aria-label={active === "sources" ? "Sources" : "Links"}>
      {#if active === "sources"}
        <SourcesPanel {view} {sourceStore} embedded />
      {:else if active === "links"}
        <LinksPanel {docId} embedded />
      {/if}
    </div>
  {/if}
</div>

<style>
  /* The rail is pinned to the viewport's right edge at all widths; the flyout
   * floats over the (centred) document rather than reflowing it, so the editor
   * column never shifts as sections open and close. */
  .paper-rail {
    position: fixed;
    top: 72px;
    right: 8px;
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
  }
  .paper-rail-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border: none;
    border-radius: 7px;
    background: none;
    color: #64748b;
    cursor: pointer;
  }
  .paper-rail-btn:hover {
    background: #f1f5f9;
    color: #1e293b;
  }
  .paper-rail-btn.is-active {
    background: #e6effb;
    color: #1b4f86;
  }

  /* Flyout card, opening leftward from the rail. Own scroll so a long source /
   * link list never runs off-screen. */
  .paper-rail-flyout {
    position: fixed;
    top: 72px;
    right: 56px;
    z-index: 19;
    width: 300px;
    max-width: calc(100vw - 72px);
    max-height: calc(100vh - 96px);
    overflow-y: auto;
    padding: 12px 16px;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    box-shadow: 0 6px 24px rgba(15, 23, 42, 0.12);
    font-size: 14px;
  }
</style>
