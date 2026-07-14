<script lang="ts">
  // @feat breadcrumbs: GitHub-style paper switcher on the doc-page crumb — a
  // chevron next to the doc-name segment opens a searchable popup of every
  // active paper the actor can view (server order: updated_at DESC). Mounted
  // into the server-rendered #paper-crumb-switcher span by pages/doc/main.ts,
  // so it lives inside Datasette's header bar, outside #app-root.
  import { client } from "./client";
  import { TOOLBAR_ICONS } from "./icons";

  let { docId }: { docId: string } = $props();

  type Row = { id: number; name: string; updated_at: string };

  let open = $state(false);
  let query = $state("");
  let docs = $state<Row[] | null>(null);
  let failed = $state(false);
  let active = $state(0);
  let root = $state<HTMLElement | null>(null);
  let btnEl = $state<HTMLButtonElement | null>(null);
  let searchEl = $state<HTMLInputElement | null>(null);
  // Document-coord left edge for the popup, measured from the chevron at
  // open time (the popup positions against the document, not the wrapper —
  // see the .crumb-switcher style comment), clamped to the viewport.
  let popupLeft = $state(8);

  let filtered = $derived.by(() => {
    if (!docs) return [];
    const q = query.trim().toLowerCase();
    return q ? docs.filter((d) => d.name.toLowerCase().includes(q)) : docs;
  });

  async function load() {
    failed = false;
    // Defaults (state=active, kind=doc) match the main index listing; the
    // response is already updated_at DESC and acl-filtered to the actor.
    const { data, error } = await client.GET("/-/paper/api/docs");
    if (error || !data) {
      failed = true;
      docs = [];
      return;
    }
    docs = data as unknown as Row[];
  }

  const POPUP_WIDTH = 280;

  function toggle() {
    open = !open;
    if (open) {
      // Align the popup's left edge with the chevron (GitHub-style), but
      // keep it on-screen when a long doc name pushes the chevron right.
      const r = btnEl?.getBoundingClientRect();
      const left = (r?.left ?? 0) + window.scrollX;
      popupLeft = Math.max(
        8,
        Math.min(left, window.scrollX + window.innerWidth - POPUP_WIDTH - 8),
      );
      query = "";
      active = 0;
      docs = null;
      void load();
      requestAnimationFrame(() => searchEl?.focus());
    }
  }

  // Close on click/tap outside the whole widget (button + popup), and on
  // Escape wherever focus is — the search input's rAF autofocus may not have
  // landed yet, and rows/the button hold focus after keyboard use.
  $effect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root && !root.contains(e.target as Node)) open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open = false;
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  });

  function onSearchKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(active + 1, filtered.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Rows are real anchors so click/middle-click/cmd-click all work;
      // Enter delegates to the active row's anchor for the same navigation.
      root
        ?.querySelector<HTMLAnchorElement>(`a[data-idx="${active}"]`)
        ?.click();
    }
  }
</script>

<span class="crumb-switcher" bind:this={root}>
  <button
    bind:this={btnEl}
    type="button"
    class="chevron"
    aria-label="Switch paper"
    aria-expanded={open}
    onclick={toggle}
  >
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
      <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
      {@html TOOLBAR_ICONS.chevronDown}
    </svg>
  </button>
  {#if open}
    <div class="popup" style="left: {popupLeft}px" aria-label="Switch paper">
      <div class="popup-title">Switch paper</div>
      <input
        bind:this={searchEl}
        bind:value={query}
        oninput={() => (active = 0)}
        onkeydown={onSearchKeydown}
        type="search"
        placeholder="Search papers"
        aria-label="Search papers"
      />
      <ul>
        {#if docs === null}
          <li class="empty">Loading…</li>
        {:else if failed}
          <li class="empty">Couldn't load papers</li>
        {:else if filtered.length === 0}
          <li class="empty">No matching papers</li>
        {:else}
          {#each filtered as d, i (d.id)}
            <li>
              <a
                href="/-/paper/doc/{d.id}"
                data-idx={i}
                class:active={i === active}
                class:current={String(d.id) === String(docId)}
                onmousemove={() => (active = i)}
              >
                <span class="tick">
                  {#if String(d.id) === String(docId)}
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
                      <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
                      {@html TOOLBAR_ICONS.check}
                    </svg>
                  {/if}
                </span>
                <span class="name">{d.name}</span>
              </a>
            </li>
          {/each}
        {/if}
      </ul>
    </div>
  {/if}
</span>

<style>
  .crumb-switcher {
    /* NO position: relative — header.hd is overflow:hidden (float clearfix),
     * and an abs-positioned popup only escapes that clip when its containing
     * block is an ancestor OF the header. Same trick as Datasette's own
     * .nav-menu-inner (position:absolute against the document, top 2.6rem). */
    display: inline-flex;
    align-items: center;
  }
  .chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px 3px;
    margin-left: 2px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    opacity: 0.75;
  }
  .chevron:hover,
  .chevron[aria-expanded="true"] {
    opacity: 1;
    background: rgba(255, 255, 255, 0.15);
  }
  .popup {
    /* Anchored under the chevron: `left` is set inline, measured from the
     * button at open time in document coords (the containing block is the
     * document, not the wrapper — see above). z matches Datasette's nav
     * menu (1000). Width is mirrored by POPUP_WIDTH in the script for the
     * viewport clamp. */
    position: absolute;
    top: 2.8rem;
    z-index: 1000;
    width: 280px;
    padding: 6px;
    background: var(--pp-bg);
    color: var(--pp-fg);
    border: 1px solid var(--pp-border);
    border-radius: 8px;
    box-shadow: 0 8px 24px var(--pp-shadow);
  }
  .popup-title {
    padding: 4px 6px 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--pp-fg-muted);
  }
  input {
    box-sizing: border-box;
    width: 100%;
    padding: 5px 8px;
    font-size: 13px;
    color: var(--pp-fg);
    background: var(--pp-bg);
    border: 1px solid var(--pp-border);
    border-radius: 6px;
  }
  ul {
    max-height: 300px;
    margin: 6px 0 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  /* Row anchors live inside header.hd, whose `.hd a:link/:visited/:hover`
   * chain paints links near-white — out-specify it (0,3,1 beats 0,2,2) so
   * the popup rows read as normal surface text in both themes. */
  .crumb-switcher .popup a {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 6px;
    font-size: 13px;
    color: var(--pp-fg);
    text-decoration: none;
    border-radius: 6px;
  }
  .crumb-switcher .popup a.active {
    background: var(--pp-surface-2);
  }
  .crumb-switcher .popup a.current .name {
    font-weight: 600;
  }
  .tick {
    display: inline-flex;
    width: 12px;
    flex: none;
  }
  .name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .empty {
    padding: 8px 6px;
    font-size: 13px;
    color: var(--pp-fg-subtle);
  }
</style>
