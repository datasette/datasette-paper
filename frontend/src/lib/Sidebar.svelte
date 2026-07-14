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
    onOpenGraph,
  }: {
    view: EditorView | null;
    docId: string;
    sourceStore?: SourceStore | null;
    showSources?: boolean;
    // Opens the doc-centred link graph (a modal owned by the doc shell). The
    // rail hosts the trigger because it owns docId + the icon vocabulary; unlike
    // Sources/Links it opens an overlay, not a flyout section.
    onOpenGraph?: () => void;
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
    if (e.key === "Escape" && (active || menuOpen)) {
      active = null;
      menuOpen = false;
      e.stopPropagation();
    }
  }

  // ─── mobile ─────────────────────────────────────────────────────────────
  // On phones the always-on vertical rail floats over the header and forces an
  // awkward reserved right margin on the document (PaperApp). Collapse it to a
  // single 3-dot button that opens a section picker; the chosen panel opens as
  // a near-full-width overlay with a tap-to-dismiss backdrop.
  let isMobile = $state(false);
  $effect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => (isMobile = mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  let menuOpen = $state(false);
  let mobileRoot: HTMLDivElement | undefined = $state();

  function pickSection(id: SectionId): void {
    active = active === id ? null : id;
    menuOpen = false;
  }

  // Close the mobile section picker on outside-click.
  $effect(() => {
    if (!menuOpen) return;
    const onClick = (evt: MouseEvent) => {
      if (mobileRoot && !mobileRoot.contains(evt.target as Node)) menuOpen = false;
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  });
</script>

<svelte:window on:keydown={onKeydown} />

<div class="paper-rail-wrap">
  {#if isMobile}
    <!-- Collapsed rail: one 3-dot button + a section-picker menu. -->
    <div class="paper-rail-mobile" bind:this={mobileRoot}>
      <button
        type="button"
        class="paper-rail-mobile-btn"
        class:is-active={menuOpen || active !== null}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Document panels"
        title="Document panels"
        onclick={() => (menuOpen = !menuOpen)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
          {@html TOOLBAR_ICONS["threeDotsVertical"]}
        </svg>
      </button>
      {#if menuOpen}
        <div class="paper-rail-menu" role="menu">
          {#each sections as s (s.id)}
            <button
              type="button"
              role="menuitem"
              class="paper-rail-mi"
              class:is-active={active === s.id}
              onclick={() => pickSection(s.id)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
                {@html TOOLBAR_ICONS[s.icon]}
              </svg>
              <span>{s.label}</span>
            </button>
          {/each}
          {#if onOpenGraph}
            <button
              type="button"
              role="menuitem"
              class="paper-rail-mi"
              onclick={() => {
                menuOpen = false;
                onOpenGraph?.();
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
                {@html TOOLBAR_ICONS["diagram3"]}
              </svg>
              <span>View in graph</span>
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
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
      {#if onOpenGraph}
        <!-- Not a flyout section: opens the doc-centred link graph modal. -->
        <button
          type="button"
          class="paper-rail-btn"
          aria-label="View in graph"
          title="View in graph"
          onclick={onOpenGraph}
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
            {@html TOOLBAR_ICONS["diagram3"]}
          </svg>
        </button>
      {/if}
    </nav>
  {/if}

  {#if active && isMobile}
    <!-- Tap-to-dismiss backdrop for the mobile overlay panel. -->
    <button
      type="button"
      class="paper-rail-backdrop"
      aria-label="Close panel"
      onclick={() => (active = null)}
    ></button>
  {/if}

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
    background: var(--pp-bg);
    border: 1px solid var(--pp-border);
    border-radius: 10px;
    box-shadow: 0 1px 3px var(--pp-shadow);
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
    color: var(--pp-fg-muted);
    cursor: pointer;
  }
  .paper-rail-btn:hover {
    background: var(--pp-surface-2);
    color: var(--pp-fg);
  }
  /* deliberate literals: the blue active-pill identity (light-blue fill + deep-
     navy glyph), kept as its own palette, distinct from the neutral tokens. */
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
    background: var(--pp-bg);
    border: 1px solid var(--pp-border);
    border-radius: 10px;
    box-shadow: 0 6px 24px var(--pp-shadow);
    font-size: 14px;
  }

  /* ─── mobile: collapsed 3-dot rail ─────────────────────────────────────── */
  .paper-rail-mobile {
    position: fixed;
    top: 66px;
    right: 8px;
    z-index: 20;
  }
  .paper-rail-mobile-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    color: var(--pp-fg-muted);
    cursor: pointer;
    background: var(--pp-bg);
    border: 1px solid var(--pp-border);
    border-radius: 9px;
    box-shadow: 0 1px 3px var(--pp-shadow);
  }
  /* deliberate literals: blue active-pill identity (see .paper-rail-btn.is-active). */
  .paper-rail-mobile-btn.is-active {
    background: #e6effb;
    color: #1b4f86;
    border-color: #c4d9f2;
  }
  .paper-rail-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 168px;
    background: var(--pp-bg);
    border: 1px solid var(--pp-border);
    border-radius: 10px;
    box-shadow: 0 6px 24px var(--pp-shadow);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .paper-rail-mi {
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    color: var(--pp-fg);
    cursor: pointer;
  }
  .paper-rail-mi:hover,
  .paper-rail-mi.is-active {
    background: var(--pp-surface-2);
  }
  .paper-rail-mi svg {
    flex: 0 0 auto;
    color: var(--pp-fg-muted);
  }
  /* Full-screen tap target that sits behind the overlay panel to dismiss it. */
  .paper-rail-backdrop {
    position: fixed;
    inset: 0;
    z-index: 18;
    border: none;
    padding: 0;
    /* deliberate literal: light slate-tinted mobile backdrop, distinct from the
       darker --pp-overlay. */
    background: rgba(15, 23, 42, 0.18);
    cursor: default;
  }
  /* On phones the flyout becomes a near-full-width overlay panel instead of a
   * card tucked beside the (now absent) rail. */
  @media (max-width: 640px) {
    .paper-rail-flyout {
      top: 108px;
      left: 8px;
      right: 8px;
      width: auto;
      max-width: none;
      max-height: 60vh;
    }
  }

  /* --- Dark theme (append-only; light rules untouched). The active-pill's
     light-blue fill would glare on dark, so swap it for a translucent-accent
     fill + lifted-blue glyph. Both theme conditions covered. --- */
  :global([data-theme="dark"]) .paper-rail-btn.is-active,
  :global([data-theme="dark"]) .paper-rail-mobile-btn.is-active {
    background: rgba(74, 158, 255, 0.18);
    color: #9dc3ff;
  }
  :global([data-theme="dark"]) .paper-rail-mobile-btn.is-active {
    border-color: rgba(74, 158, 255, 0.35);
  }
  @media (prefers-color-scheme: dark) {
    :global(:root[data-theme="system"]) .paper-rail-btn.is-active,
    :global(:root[data-theme="system"]) .paper-rail-mobile-btn.is-active {
      background: rgba(74, 158, 255, 0.18);
      color: #9dc3ff;
    }
    :global(:root[data-theme="system"])
      .paper-rail-mobile-btn.is-active {
      border-color: rgba(74, 158, 255, 0.35);
    }
  }
</style>
