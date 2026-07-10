<script lang="ts">
  /**
   * Collapsible doc-view panel listing the document's forward links and
   * backlinks. Starts collapsed; opening (or changing docId while open)
   * fetches both `/links` and `/backlinks` in parallel and renders the
   * results. A request token guards against races so only the latest
   * response is applied, and each (re)open re-fetches so the panel reflects
   * recent edits.
   *
   * The render vocabulary mirrors paperLinkView.ts: ok/active plain,
   * archived muted with "(archived)" hint, trashed muted with "(in trash)"
   * hint, denied shows "Permission denied" (never a title, never clickable),
   * not_found shows a struck-through "Paper #<id>" (never clickable).
   */
  import { untrack } from "svelte";

  type LinkItem = {
    id: number;
    occurrences: number;
    status: "ok" | "denied" | "not_found";
    title?: string;
    state?: string;
    kind?: string;
    href?: string;
  };

  // `embedded` renders the panel headless — no self-collapse caret, always open —
  // for a host (the icon rail) that owns open/closed itself.
  let { docId, embedded = false }: { docId: string; embedded?: boolean } = $props();

  let open = $state(untrack(() => embedded));
  let loading = $state(false);
  let error = $state<string | null>(null);
  let links = $state<LinkItem[]>([]);
  let backlinks = $state<LinkItem[]>([]);

  // Bumped on every load; a stale response (token !== loadToken) is dropped.
  let loadToken = 0;

  async function load(): Promise<void> {
    const token = ++loadToken;
    loading = true;
    error = null;
    try {
      const [linksResp, backlinksResp] = await Promise.all([
        fetch(`/-/paper/api/docs/${docId}/links`),
        fetch(`/-/paper/api/docs/${docId}/backlinks`),
      ]);
      if (!linksResp.ok || !backlinksResp.ok) {
        throw new Error("Failed to load links");
      }
      const linksData = (await linksResp.json()) as { links: LinkItem[] };
      const backlinksData = (await backlinksResp.json()) as {
        backlinks: LinkItem[];
      };
      // Drop a response that a newer load (or a docId change) superseded.
      if (token !== loadToken) return;
      links = linksData.links ?? [];
      backlinks = backlinksData.backlinks ?? [];
    } catch {
      if (token !== loadToken) return;
      error = "Could not load links.";
    } finally {
      if (token === loadToken) loading = false;
    }
  }

  function toggle(): void {
    open = !open;
  }

  // Refresh whenever the panel is open — including a docId change while open.
  // Reading `open` and `docId` registers them as effect dependencies.
  //
  // Backlinks change from edits in OTHER docs (whoever links to this one),
  // with no local signal here, so a single fetch-on-open can go stale while
  // the panel stays open. Re-fetch when the tab regains focus/visibility —
  // the natural moment a user returns to this doc after creating a link to it
  // elsewhere (e.g. the `[[`-create flow, which navigates away and back).
  $effect(() => {
    if (!open) return;
    // Touch docId so the effect re-runs (and re-binds listeners) on doc change.
    void docId;
    load();

    const refresh = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  });

  function hint(item: LinkItem): string {
    if (item.state === "archived") return " (archived)";
    if (item.state === "trashed") return " (in trash)";
    return "";
  }
</script>

<section class="links-panel" class:is-embedded={embedded}>
  {#if embedded}
    <h3 class="links-panel-heading-top">Links</h3>
  {:else}
    <button
      type="button"
      class="links-panel-toggle"
      aria-expanded={open}
      onclick={toggle}
    >
      <span class="links-panel-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      Links
    </button>
  {/if}

  {#if open}
    <div class="links-panel-body">
      {#if loading}
        <div class="links-panel-state">Loading…</div>
      {:else if error}
        <div class="links-panel-state links-panel-error">{error}</div>
      {:else}
        <div class="links-panel-section">
          <h4 class="links-panel-heading">Links</h4>
          {#if links.length === 0}
            <div class="links-panel-none">None</div>
          {:else}
            <ul class="links-panel-list">
              {#each links as item (item.id)}
                <li class="links-panel-item">
                  {#if item.status === "ok"}
                    <a class="pm-paper-link" href={item.href}>
                      {item.title}{hint(item)}
                    </a>
                  {:else if item.status === "denied"}
                    <span class="links-panel-denied">Permission denied</span>
                  {:else}
                    <span class="links-panel-missing">Paper #{item.id}</span>
                  {/if}
                  {#if item.occurrences > 1}
                    <span class="links-panel-count">× {item.occurrences}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div class="links-panel-section">
          <h4 class="links-panel-heading">Linked from</h4>
          {#if backlinks.length === 0}
            <div class="links-panel-none">None</div>
          {:else}
            <ul class="links-panel-list">
              {#each backlinks as item (item.id)}
                <li class="links-panel-item">
                  {#if item.status === "ok"}
                    <a class="pm-paper-link" href={item.href}>
                      {item.title}{hint(item)}
                    </a>
                  {:else if item.status === "denied"}
                    <span class="links-panel-denied">Permission denied</span>
                  {:else}
                    <span class="links-panel-missing">Paper #{item.id}</span>
                  {/if}
                  {#if item.occurrences > 1}
                    <span class="links-panel-count">× {item.occurrences}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .links-panel {
    margin: 16px 0;
    border-top: 1px solid var(--pp-border);
    font-size: 14px;
  }
  /* Embedded (icon-rail flyout): the host supplies the card chrome, so drop the
   * standalone top rule/margin and the body's nesting indent. */
  .links-panel.is-embedded {
    margin: 0;
    border-top: none;
  }
  .links-panel.is-embedded .links-panel-body {
    padding-left: 0;
  }
  .links-panel-heading-top {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--pp-fg-muted);
  }
  .links-panel-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    padding: 4px 0;
    background: transparent;
    border: none;
    color: var(--pp-fg-muted);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .links-panel-toggle:hover {
    color: var(--pp-fg);
  }
  .links-panel-caret {
    font-size: 0.8em;
    color: var(--pp-fg-subtle);
  }
  .links-panel-body {
    /* Slight indent so the body reads as nested under the toggle header. */
    padding: 4px 0 8px 10px;
  }
  .links-panel-state {
    color: var(--pp-fg-subtle);
    padding: 4px 0;
  }
  /* deliberate literal: one-off error red, distinct from --pp-danger. */
  .links-panel-error {
    color: #8a2a2a;
  }
  .links-panel-section {
    margin: 8px 0;
  }
  .links-panel-heading {
    margin: 0 0 4px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--pp-fg-subtle);
    font-weight: 600;
  }
  .links-panel-none {
    color: var(--pp-fg-subtle);
    font-style: italic;
  }
  .links-panel-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .links-panel-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 0;
  }
  .links-panel-item .pm-paper-link {
    color: var(--pp-accent);
    text-decoration: none;
  }
  .links-panel-item .pm-paper-link:hover {
    text-decoration: underline;
  }
  .links-panel-denied {
    color: var(--pp-fg-subtle);
  }
  .links-panel-missing {
    color: var(--pp-fg-subtle);
    text-decoration: line-through;
  }
  .links-panel-count {
    color: var(--pp-fg-subtle);
    font-size: 0.85em;
  }
</style>
