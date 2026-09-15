<script lang="ts">
  import { onMount, tick } from "svelte";
  import { client } from "./client";
  import GraphModal from "./GraphModal.svelte";
  import TagEditor from "./TagEditor.svelte";
  import { TOOLBAR_ICONS, type ToolbarIconName } from "./icons";
  import { loadPageData } from "./pageData";
  import { cycleTheme, getStoredTheme, type Theme } from "./theme";

  // @feat task-assign: the signed-in actor (null for anonymous) gates the
  // "My TODOs" header link — it points at the /-/paper/todos page, which
  // defaults to this same actor server-side. Tolerate a missing pageData blob
  // (component-mount tests): no blob → treat as anonymous, hide the link.
  function readSignedInActor(): string | null {
    try {
      return loadPageData<{ actor_id: string | null }>().actor_id;
    } catch {
      return null;
    }
  }
  const signedInActor = readSignedInActor();

  // Per-device theme, cycled Light → Dark → System by the header button.
  // Initialised from the persisted value so the label reflects reality
  // (defaults to Light; dark/system are explicit opt-ins).
  let currentTheme = $state<Theme>(getStoredTheme());
  const THEME_LABELS: Record<Theme, string> = {
    system: "System",
    light: "Light",
    dark: "Dark",
  };
  let themeLabel = $derived(THEME_LABELS[currentTheme]);

  function advanceTheme(): void {
    currentTheme = cycleTheme(currentTheme);
  }

  type DocState = "active" | "archived" | "trashed";

  type DocRow = {
    id: number;
    name: string;
    current_version: number;
    updated_at: string;
    created_by: string | null;
    created_by_name: string | null;
    created_by_avatar: string | null;
    visibility: string;
    is_owner: boolean;
    state: DocState;
    archived_at: string | null;
    trashed_at: string | null;
    delete_at: string | null;
    kind: "doc" | "template";
    locked: boolean;
    tags: string[];
    // @feat last-edited-indicator: latest attributed editor off the
    // doc-activity rollup; null when the doc has none (anonymous-only
    // edits or pre-rollup history).
    last_edited_by: string | null;
    last_edited_by_name: string | null;
  };

  // Lazy per-tab caches. `null` means "not fetched yet"; switching tabs
  // triggers a fetch on first activation. We refetch a tab after each
  // mutation that lands on it.
  let active = $state<DocRow[] | null>(null);
  let archived = $state<DocRow[] | null>(null);
  let trashed = $state<DocRow[] | null>(null);
  // Templates are a separate tab — kept in a flat cache keyed by tab
  // name in addition to the lifecycle tabs. They use the same DocRow
  // shape (templates are real papers with kind='template').
  let templates = $state<DocRow[] | null>(null);

  type IndexTab = DocState | "templates";

  // Per-tab presentation: the tab-bar label, the URL hash slug that
  // deep-links to it (#active/#archive/#trash/#templates), a short
  // tooltip on the tab button, and a one-line description shown above
  // the listing while the tab is selected.
  const TAB_META: Record<
    IndexTab,
    { label: string; hash: string; title: string; description: string }
  > = {
    active: {
      label: "Active",
      hash: "active",
      title: "Papers you're currently working on",
      description: "Papers you're currently working on.",
    },
    archived: {
      label: "Archive",
      hash: "archive",
      title: "Papers you've archived — hidden from Active but kept",
      description:
        "Archived papers are hidden from Active but kept. Unarchive one to bring it back.",
    },
    trashed: {
      label: "Trash",
      hash: "trash",
      title: "Papers you've trashed — restore within 7 days",
      description:
        "Trashed papers are scheduled to be deleted 7 days after they were trashed. Restore one to recover it.",
    },
    templates: {
      label: "Templates",
      hash: "templates",
      title: "Reusable starting points for new papers",
      description:
        "Templates are reusable starting points. Pick one from the arrow next to “New paper” to copy its contents.",
    },
  };

  const TAB_ORDER: IndexTab[] = ["active", "archived", "trashed", "templates"];

  // Reverse lookup: URL hash slug → tab. Built from TAB_META so the two
  // never drift.
  function tabFromHash(): IndexTab | null {
    const slug = window.location.hash.replace(/^#/, "");
    return TAB_ORDER.find((t) => TAB_META[t].hash === slug) ?? null;
  }

  let tab = $state<IndexTab>("active");
  let loading = $state(false);
  let error = $state<string | null>(null);
  let creating = $state(false);
  // Templates offered in the New paper caret menu (null = not loaded yet).
  let pickerTemplates = $state<DocRow[] | null>(null);
  let pickerLoading = $state(false);
  // Per-row mutation in flight (keyed by `${state}:${id}`) so we can
  // disable just that row's buttons rather than the whole tab.
  let busyKey = $state<string | null>(null);
  // Which row's overflow menu is open, keyed the same way as busyKey.
  let openMenuKey = $state<string | null>(null);

  // Tag vocabulary (instance-wide, for the filter bar + editor autocomplete)
  // and the currently-selected document-tag filter (AND/intersection). The
  // row currently being tag-edited (owner-only modal), or null.
  let vocab = $state<string[]>([]);
  let tagFilter = $state<string[]>([]);
  let editingDoc = $state<DocRow | null>(null);

  async function loadVocab(): Promise<void> {
    const { data } = await client.GET("/-/paper/api/tags");
    const tags = (data as unknown as { tags: { tag: string }[] } | undefined)?.tags;
    vocab = (tags ?? []).map((t) => t.tag);
  }

  function toggleFilter(tag: string): void {
    tagFilter = tagFilter.includes(tag)
      ? tagFilter.filter((t) => t !== tag)
      : [...tagFilter, tag];
    // The per-tab caches don't encode the filter, so drop them all and
    // refetch the visible tab with the new ?tag= set.
    active = archived = trashed = templates = null;
    void loadTab(tab);
  }

  function clearFilter(): void {
    if (!tagFilter.length) return;
    tagFilter = [];
    active = archived = trashed = templates = null;
    void loadTab(tab);
  }

  function openTagEditor(doc: DocRow): void {
    closeMenu();
    editingDoc = doc;
  }

  // Patch a doc's tags across every cached bucket after an edit, and refresh
  // the vocabulary (counts/new tags may have changed).
  function patchDocTags(docId: number, tags: string[]): void {
    const apply = (rows: DocRow[] | null) =>
      rows ? rows.map((d) => (d.id === docId ? { ...d, tags } : d)) : rows;
    active = apply(active);
    archived = apply(archived);
    trashed = apply(trashed);
    templates = apply(templates);
    if (editingDoc && editingDoc.id === docId) {
      editingDoc = { ...editingDoc, tags };
    }
    void loadVocab();
  }

  // Each minute, recompute relative-time + "deletes in N days" labels by
  // bumping a timestamp the derived helpers read. Cheap; one tick across
  // the visible list.
  let nowTick = $state(Date.now());
  let nowTimer: ReturnType<typeof setInterval> | undefined;

  function bucket(t: IndexTab): DocRow[] | null {
    if (t === "active") return active;
    if (t === "archived") return archived;
    if (t === "trashed") return trashed;
    return templates;
  }

  function setBucket(t: IndexTab, rows: DocRow[]): void {
    if (t === "active") active = rows;
    else if (t === "archived") archived = rows;
    else if (t === "trashed") trashed = rows;
    else templates = rows;
  }

  function invalidateBucket(t: IndexTab): void {
    if (t === "active") active = null;
    else if (t === "archived") archived = null;
    else if (t === "trashed") trashed = null;
    else templates = null;
  }

  async function loadTab(target: IndexTab): Promise<void> {
    loading = true;
    error = null;
    // Templates tab queries the kind=template variant; the other tabs
    // filter by lifecycle state and stick with the default kind=doc. The
    // optional document-tag filter (?tag=…) ANDs across the chosen tags.
    const query: Record<string, unknown> =
      target === "templates" ? { kind: "template" } : { state: target };
    if (tagFilter.length) query.tag = tagFilter;
    const { data, error: err } = await client.GET("/-/paper/api/docs", {
      params: { query: query as never },
    });
    loading = false;
    if (err || !data) {
      error = "Failed to load papers";
      return;
    }
    setBucket(target, data as unknown as DocRow[]);
  }

  function selectTab(target: IndexTab): void {
    tab = target;
    // Reflect the active tab in the URL hash so it's deep-linkable and
    // survives reload / back-forward. Assigning the same value is a
    // no-op and won't refire hashchange.
    const slug = `#${TAB_META[target].hash}`;
    if (window.location.hash !== slug) window.location.hash = slug;
    if (bucket(target) === null) void loadTab(target);
  }

  // @feat new-paper: one POST then a nav to the editor. Blank omits `name`
  // (server defaults to "Untitled"); a template seeds from `template_id` and
  // takes the template's name; `kind: "template"` makes a blank template.
  // `?new=1` tells DocHeader to focus + select the title so the default name
  // is one keystroke from gone.
  async function createPaper(
    body: { template_id?: number; name?: string; kind?: "template" },
  ): Promise<void> {
    if (creating) return;
    closeNewMenu();
    creating = true;
    error = null;
    const { data, error: err } = await client.POST("/-/paper/api/docs", {
      body: body as never,
    });
    creating = false;
    if (err || !data) {
      error =
        body.kind === "template"
          ? "Failed to create template"
          : "Failed to create paper";
      return;
    }
    const created = data as unknown as DocRow;
    window.location.href = `/-/paper/doc/${created.id}?new=1`;
  }

  function createBlank(): Promise<void> {
    return createPaper({});
  }

  function createFromTemplate(t: DocRow): Promise<void> {
    return createPaper({ template_id: t.id, name: t.name });
  }

  function createTemplate(): Promise<void> {
    return createPaper({ name: "Untitled template", kind: "template" });
  }

  // @feat new-paper: the split button's caret menu (templates, New template,
  // Manage templates). Arrow/Home/End rove focus across its menuitems; the
  // filter input only appears past FILTER_THRESHOLD templates.
  const FILTER_THRESHOLD = 8;
  let newMenuOpen = $state(false);
  let newMenuFilter = $state("");
  let newMenuEl = $state<HTMLDivElement | null>(null);
  let newCaretEl = $state<HTMLButtonElement | null>(null);

  let filteredTemplates = $derived.by(() => {
    const all = pickerTemplates ?? [];
    const q = newMenuFilter.trim().toLowerCase();
    return q ? all.filter((t) => t.name.toLowerCase().includes(q)) : all;
  });
  let showTemplateFilter = $derived(
    (pickerTemplates?.length ?? 0) > FILTER_THRESHOLD,
  );

  function menuItems(): HTMLElement[] {
    return newMenuEl
      ? Array.from(newMenuEl.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      : [];
  }

  async function openNewMenu(): Promise<void> {
    newMenuFilter = "";
    newMenuOpen = true;
    await ensurePickerTemplates();
    await tick();
    if (!newMenuOpen) return;
    const filter = newMenuEl?.querySelector<HTMLInputElement>(".new-menu-filter");
    (filter ?? menuItems()[0])?.focus();
  }

  function closeNewMenu(returnFocus = false): void {
    if (!newMenuOpen) return;
    newMenuOpen = false;
    if (returnFocus) newCaretEl?.focus();
  }

  function toggleNewMenu(): void {
    if (newMenuOpen) closeNewMenu();
    else void openNewMenu();
  }

  function onNewMenuKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      // Claim it so the row-menu window listener doesn't also act.
      e.preventDefault();
      e.stopPropagation();
      closeNewMenu(true);
      return;
    }
    const inFilter = (e.target as Element | null)?.classList.contains(
      "new-menu-filter",
    );
    if (inFilter && e.key === "Enter") {
      e.preventDefault();
      if (filteredTemplates[0]) void createFromTemplate(filteredTemplates[0]);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = menuItems();
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % items.length;
    else next = i <= 0 ? items.length - 1 : i - 1;
    items[next].focus();
  }

  function manageTemplates(): void {
    closeNewMenu();
    selectTab("templates");
  }

  // Outside click closes the caret menu.
  $effect(() => {
    if (!newMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest(".new-paper")) return;
      closeNewMenu();
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  });

  async function makeTemplate(doc: DocRow) {
    return mutate(doc, "/make_template", ["active", "archived", "templates"]);
  }

  async function unmakeTemplate(doc: DocRow) {
    return mutate(doc, "/unmake_template", ["active", "archived", "templates"]);
  }

  async function mutate(
    doc: DocRow,
    path:
      | "/archive"
      | "/unarchive"
      | "/trash"
      | "/restore"
      | "/lock"
      | "/unlock"
      | "/make_template"
      | "/unmake_template",
    refetch: IndexTab[],
  ): Promise<void> {
    const key = `${doc.state}:${doc.id}`;
    if (busyKey) return;
    busyKey = key;
    error = null;
    try {
      const url = `/-/paper/api/docs/${doc.id}${path}` as
        | "/-/paper/api/docs/{doc_id}/archive"
        | "/-/paper/api/docs/{doc_id}/unarchive"
        | "/-/paper/api/docs/{doc_id}/trash"
        | "/-/paper/api/docs/{doc_id}/restore"
        | "/-/paper/api/docs/{doc_id}/lock"
        | "/-/paper/api/docs/{doc_id}/unlock"
        | "/-/paper/api/docs/{doc_id}/make_template"
        | "/-/paper/api/docs/{doc_id}/unmake_template";
      const { error: err } = await client.POST(url, {
        params: { path: { doc_id: doc.id } },
      });
      if (err) {
        error = "Action failed";
        return;
      }
      // Invalidate the affected tabs so they refetch on next view, and
      // refresh whichever one is currently visible immediately.
      for (const t of refetch) {
        if (t === tab) {
          await loadTab(t);
        } else {
          invalidateBucket(t);
        }
      }
    } finally {
      busyKey = null;
    }
  }

  function archiveRow(d: DocRow) {
    return mutate(d, "/archive", ["active", "archived"]);
  }

  function unarchiveRow(d: DocRow) {
    return mutate(d, "/unarchive", ["active", "archived"]);
  }

  function trashRow(d: DocRow) {
    if (
      !window.confirm(
        `Move "${d.name}" to the trash? It auto-deletes in 7 days unless restored.`,
      )
    ) {
      return Promise.resolve();
    }
    return mutate(d, "/trash", ["active", "archived", "trashed"]);
  }

  function restoreRow(d: DocRow) {
    return mutate(d, "/restore", ["active", "trashed"]);
  }

  // Tab the row is currently being shown in (templates show under their
  // own tab regardless of state). Used by lock/unlock to refresh the
  // visible row in place.
  function rowTab(d: DocRow): IndexTab {
    return d.kind === "template" ? "templates" : d.state;
  }

  function lockRow(d: DocRow) {
    // Lock/unlock only mutates the same row; refresh the current tab so
    // the badge appears immediately.
    return mutate(d, "/lock", [rowTab(d)]);
  }

  function unlockRow(d: DocRow) {
    return mutate(d, "/unlock", [rowTab(d)]);
  }

  function deletesInLabel(deleteAt: string | null): string {
    if (!deleteAt) return "";
    // ISO-8601 with millisecond precision and trailing Z parses fine in
    // every modern engine; nowTick is read here so the label re-renders
    // each minute.
    const target = Date.parse(deleteAt);
    if (Number.isNaN(target)) return "";
    const diffMs = target - nowTick;
    // Past its retention window: due for deletion on the next cleanup
    // sweep. Not "Deleting…" — that reads as an in-progress action, but
    // the row just sits here until the sweep runs.
    if (diffMs <= 0) return "Due for deletion";
    const days = Math.floor(diffMs / 86_400_000);
    if (days >= 1) return `Deletes in ${days} day${days === 1 ? "" : "s"}`;
    const hours = Math.floor(diffMs / 3_600_000);
    if (hours >= 1) return `Deletes in ${hours} hour${hours === 1 ? "" : "s"}`;
    return "Deletes within the hour";
  }

  function relativeTime(iso: string): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const diff = nowTick - t;
    if (diff < 45_000) return "just now";
    const mins = Math.round(diff / 60_000);
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const hours = Math.round(diff / 3_600_000);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.round(diff / 86_400_000);
    if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
    const weeks = Math.round(days / 7);
    if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
    const years = Math.round(days / 365);
    return `${years} year${years === 1 ? "" : "s"} ago`;
  }

  function toggleMenu(key: string, e: MouseEvent): void {
    e.stopPropagation();
    openMenuKey = openMenuKey === key ? null : key;
  }

  function closeMenu(): void {
    openMenuKey = null;
  }

  // While a menu is open, dismiss on outside click or Escape. The
  // listeners are only attached for the lifetime of the open state so
  // they don't cost anything when nothing is open.
  $effect(() => {
    if (openMenuKey === null) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest(".menu-wrapper")) return;
      openMenuKey = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) openMenuKey = null;
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  });

  function tabLabel(label: string, rows: DocRow[] | null): string {
    return rows === null ? label : `${label} (${rows.length})`;
  }

  // Templates are loaded lazily into the New paper caret menu: prefetched
  // on mount and again (if invalidated) when the menu opens. After any
  // make/unmake mutation we invalidate the cached list so the menu
  // reflects the new state.

  async function ensurePickerTemplates(): Promise<void> {
    if (pickerTemplates !== null || pickerLoading) return;
    pickerLoading = true;
    const { data } = await client.GET("/-/paper/api/docs", {
      params: { query: { kind: "template" } as never },
    });
    pickerLoading = false;
    pickerTemplates = ((data as unknown as DocRow[]) ?? []) as DocRow[];
  }

  // Refresh the picker list whenever the templates tab cache changes
  // (make/unmake mutations invalidate it via the refetch list).
  $effect(() => {
    // Read templates so this effect re-runs on every reassignment.
    if (templates === null) pickerTemplates = null;
    else pickerTemplates = templates;
  });

  // Back/forward or a hand-edited hash switches tabs without a reload.
  function onHashChange(): void {
    const target = tabFromHash();
    if (target && target !== tab) selectTab(target);
  }

  onMount(() => {
    selectTab(tabFromHash() ?? "active");
    void ensurePickerTemplates();
    void loadVocab();
    window.addEventListener("hashchange", onHashChange);
    nowTimer = setInterval(() => {
      nowTick = Date.now();
    }, 60_000);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      if (nowTimer) clearInterval(nowTimer);
    };
  });

  let visibleRows = $derived(bucket(tab) ?? []);

  // The link graph is lazy-mounted: only when `showGraph` flips true does
  // <GraphModal> render <LinkGraph>, so its dynamic d3-force import doesn't
  // load until the user opens the graph. No focusId here → the full graph.
  let showGraph = $state(false);
  function toggleGraph(): void {
    showGraph = !showGraph;
  }
  function closeGraph(): void {
    showGraph = false;
  }
</script>

<div class="paper-index">
  <div class="index-header">
    <h1>Papers</h1>
    <div class="header-actions">
      {#if signedInActor}
        <!-- @feat task-assign: entry point to the cross-doc TODO page. -->
        <a class="todos-link" href="/-/paper/todos">My TODOs</a>
      {/if}
      <!-- @feat dark-mode: the index page's theme control — one button that
           cycles Light → Dark → System via cycleTheme (persist + stamp), with
           an aria-label/title that announces the current state. -->
      <button
        type="button"
        class="theme-cycle"
        aria-label="Theme: {themeLabel}"
        title="Theme: {themeLabel}"
        onclick={advanceTheme}
      >
        {@render icon("circleHalf")}
      </button>
      <button
        type="button"
        class="graph-toggle"
        aria-haspopup="dialog"
        aria-expanded={showGraph}
        onclick={toggleGraph}
      >
        Graph
      </button>
      <!-- @feat new-paper: split button — main half is the 1-click blank
           paper, the caret opens the create-from-template menu. -->
      <div class="new-paper">
        <button
          type="button"
          class="new-paper-main"
          disabled={creating}
          onclick={createBlank}
        >
          {@render icon("plusLg")}
          <span>{creating ? "Creating…" : "New paper"}</span>
        </button>
        <button
          type="button"
          class="new-paper-caret"
          bind:this={newCaretEl}
          aria-label="More ways to create a paper"
          aria-haspopup="menu"
          aria-expanded={newMenuOpen}
          disabled={creating}
          onclick={toggleNewMenu}
          onpointerenter={() => void ensurePickerTemplates()}
        >
          {@render icon("chevronDown")}
        </button>
        {#if newMenuOpen}
          <!-- svelte-ignore a11y_interactive_supports_focus -->
          <div
            class="new-menu"
            role="menu"
            aria-label="Create a paper"
            bind:this={newMenuEl}
            onkeydown={onNewMenuKeydown}
          >
            <div class="new-menu-heading">Start from a template</div>
            {#if showTemplateFilter}
              <input
                type="text"
                class="new-menu-filter"
                placeholder="Filter templates"
                aria-label="Filter templates"
                bind:value={newMenuFilter}
              />
            {/if}
            {#if pickerTemplates === null}
              <div class="new-menu-empty">Loading…</div>
            {:else if pickerTemplates.length === 0}
              <div class="new-menu-empty">No templates yet</div>
            {:else if filteredTemplates.length === 0}
              <div class="new-menu-empty">No matching templates</div>
            {:else}
              {#each filteredTemplates as t (t.id)}
                <button
                  type="button"
                  role="menuitem"
                  onclick={() => createFromTemplate(t)}
                >
                  {@render icon("fileText")}
                  <span class="new-menu-label">{t.name}</span>
                </button>
              {/each}
            {/if}
            <div class="new-menu-sep" role="separator"></div>
            <button type="button" role="menuitem" onclick={createTemplate}>
              {@render icon("plusLg")}
              <span class="new-menu-label">New template</span>
            </button>
            <button type="button" role="menuitem" onclick={manageTemplates}>
              <span class="new-menu-icon-spacer" aria-hidden="true"></span>
              <span class="new-menu-label">Manage templates</span>
            </button>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <GraphModal open={showGraph} onClose={closeGraph} />

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="tabs" role="tablist">
    {#each TAB_ORDER as t (t)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === t}
        class:active={tab === t}
        title={TAB_META[t].title}
        onclick={() => selectTab(t)}
      >
        {tabLabel(TAB_META[t].label, bucket(t))}
      </button>
    {/each}
  </div>

  <p class="tab-desc">{TAB_META[tab].description}</p>

  {#if vocab.length}
    <div class="tag-filter" role="group" aria-label="Filter by tag">
      <span class="tag-filter-label">Tags:</span>
      {#each vocab as t (t)}
        <button
          type="button"
          class="tag-chip tag-chip-button"
          class:selected={tagFilter.includes(t)}
          aria-pressed={tagFilter.includes(t)}
          onclick={() => toggleFilter(t)}
        >
          {t}
        </button>
      {/each}
      {#if tagFilter.length}
        <button type="button" class="tag-filter-clear" onclick={clearFilter}>
          Clear
        </button>
      {/if}
    </div>
  {/if}

  {#if loading && bucket(tab) === null}
    <p>Loading…</p>
  {:else if visibleRows.length === 0}
    {#if tab === "active"}
      <p>No papers yet.</p>
    {:else if tab === "archived"}
      <p>No archived papers.</p>
    {:else if tab === "trashed"}
      <p>Trash is empty.</p>
    {:else}
      <p>
        No templates yet. Pick “New template” from the arrow next to New
        paper, or use the menu on any active paper.
      </p>
    {/if}
  {:else}
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th><span class="sr-only">Created by</span></th>
          <th>Last updated</th>
          {#if tab === "trashed"}
            <th>Status</th>
          {/if}
          <th class="actions-col"></th>
        </tr>
      </thead>
      <tbody>
        {#each visibleRows as doc (doc.id)}
          {@const key = `${doc.state}:${doc.id}`}
          {@const busy = busyKey === key}
          {@const menuOpen = openMenuKey === key}
          <tr class:busy>
            <td>
              <a href="/-/paper/doc/{doc.id}">{doc.name}</a>
              {#if doc.locked}
                <span class="badge badge-locked" title="Read-only">Locked</span>
              {/if}
              {#if doc.tags?.length}
                <span class="row-tags">
                  {#each doc.tags as t (t)}
                    <button
                      type="button"
                      class="tag-chip tag-chip-button"
                      class:selected={tagFilter.includes(t)}
                      aria-label="Filter by {t}"
                      onclick={() => toggleFilter(t)}
                    >
                      {t}
                    </button>
                  {/each}
                </span>
              {/if}
            </td>
            <td
              class="col-creator"
              data-label={doc.created_by ? "Created by" : undefined}
              title={doc.created_by ?? ""}
            >
              {#if doc.created_by}
                <span class="creator">
                  {#if doc.created_by_avatar}
                    <img
                      class="creator-avatar"
                      src={doc.created_by_avatar}
                      alt=""
                      onerror={(e) =>
                        ((e.currentTarget as HTMLImageElement).style.display =
                          "none")}
                    />
                  {/if}
                  {doc.created_by_name ?? doc.created_by}
                </span>
              {/if}
            </td>
            <td data-label="Last updated" title={doc.updated_at}
              >{relativeTime(doc.updated_at)}{#if doc.last_edited_by}
                <span
                  class="last-editor"
                  title={doc.last_edited_by}
                >
                  by {doc.last_edited_by_name ?? doc.last_edited_by}</span
                >{/if}</td
            >
            {#if tab === "trashed"}
              <td class="delete-at" data-label="Status">
                {deletesInLabel(doc.delete_at)}
              </td>
            {/if}
            <td class="actions">
              {#if doc.is_owner}
                <div class="menu-wrapper">
                  <button
                    type="button"
                    class="menu-trigger"
                    aria-label="Actions"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    disabled={busy}
                    onclick={(e) => toggleMenu(key, e)}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      fill="currentColor"
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                    >
                      <path
                        d="M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0"
                      />
                    </svg>
                  </button>
                  {#if menuOpen}
                    <div class="menu" role="menu">
                      {#if tab === "templates"}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => openTagEditor(doc)}
                        >
                          Edit tags
                        </button>
                        {#if doc.locked}
                          <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                              closeMenu();
                              void unlockRow(doc);
                            }}
                          >
                            Unlock
                          </button>
                        {:else}
                          <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                              closeMenu();
                              void lockRow(doc);
                            }}
                          >
                            Lock
                          </button>
                        {/if}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            closeMenu();
                            void unmakeTemplate(doc);
                          }}
                        >
                          Demote to doc
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          class="danger"
                          onclick={() => {
                            closeMenu();
                            void trashRow(doc);
                          }}
                        >
                          Trash
                        </button>
                      {:else if tab === "active"}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => openTagEditor(doc)}
                        >
                          Edit tags
                        </button>
                        {#if doc.locked}
                          <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                              closeMenu();
                              void unlockRow(doc);
                            }}
                          >
                            Unlock
                          </button>
                        {:else}
                          <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                              closeMenu();
                              void lockRow(doc);
                            }}
                          >
                            Lock
                          </button>
                        {/if}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            closeMenu();
                            void makeTemplate(doc);
                          }}
                        >
                          Make template
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            closeMenu();
                            void archiveRow(doc);
                          }}
                        >
                          Archive
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          class="danger"
                          onclick={() => {
                            closeMenu();
                            void trashRow(doc);
                          }}
                        >
                          Trash
                        </button>
                      {:else if tab === "archived"}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => openTagEditor(doc)}
                        >
                          Edit tags
                        </button>
                        {#if doc.locked}
                          <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                              closeMenu();
                              void unlockRow(doc);
                            }}
                          >
                            Unlock
                          </button>
                        {:else}
                          <button
                            type="button"
                            role="menuitem"
                            onclick={() => {
                              closeMenu();
                              void lockRow(doc);
                            }}
                          >
                            Lock
                          </button>
                        {/if}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            closeMenu();
                            void unarchiveRow(doc);
                          }}
                        >
                          Unarchive
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          class="danger"
                          onclick={() => {
                            closeMenu();
                            void trashRow(doc);
                          }}
                        >
                          Trash
                        </button>
                      {:else}
                        <button
                          type="button"
                          role="menuitem"
                          onclick={() => {
                            closeMenu();
                            void restoreRow(doc);
                          }}
                        >
                          Restore
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if editingDoc}
    <TagEditor
      docId={editingDoc.id}
      docName={editingDoc.name}
      tags={editingDoc.tags}
      {vocab}
      onChange={patchDocTags}
      onClose={() => (editingDoc = null)}
    />
  {/if}
</div>

{#snippet icon(name: ToolbarIconName)}
  <svg
    class="btn-icon"
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
  >
    <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
    {@html TOOLBAR_ICONS[name]}
  </svg>
{/snippet}

<style>
  /* Inherit the body font (Inter Variable + system fallbacks). */
  .paper-index {
    font-family: inherit;
    max-width: 880px;
    margin-left: auto;
    margin-right: auto;
  }
  .index-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1em;
  }
  .header-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .todos-link {
    border: 1px solid var(--pp-border-strong);
    background: var(--pp-bg);
    border-radius: 4px;
    padding: 6px 12px;
    font: inherit;
    color: var(--pp-fg);
    text-decoration: none;
  }
  .todos-link:hover {
    background: var(--pp-surface-2);
  }
  .graph-toggle {
    border: 1px solid var(--pp-border-strong);
    background: var(--pp-bg);
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
    font: inherit;
    color: var(--pp-fg);
  }
  .graph-toggle:hover {
    background: var(--pp-surface-2);
  }
  .theme-cycle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--pp-border-strong);
    background: var(--pp-bg);
    border-radius: 4px;
    padding: 6px 8px;
    cursor: pointer;
    color: var(--pp-fg-muted);
  }
  .theme-cycle:hover {
    background: var(--pp-surface-2);
    color: var(--pp-fg);
  }
  .theme-cycle:focus-visible {
    outline: 2px solid var(--pp-focus-ring);
    outline-offset: 2px;
  }
  .btn-icon {
    display: block;
  }
  /* Visually hidden but available to assistive tech (kept for the
   * headerless "Created by" column). */
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .tab-desc {
    color: var(--pp-fg-muted);
    font-size: 0.9em;
    margin: 10px 0 0;
  }
  /* deliberate literal: solid error-box pink/maroon, distinct from the faint
     --pp-danger-bg wash. */
  .error {
    background: #ffd6d6;
    color: #5a0000;
    padding: 6px 10px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin-top: 1em;
  }
  th,
  td {
    border-bottom: 1px solid var(--pp-border);
    padding: 6px 8px;
    text-align: left;
  }
  .new-paper {
    position: relative;
    display: inline-flex;
  }
  .new-paper-main,
  .new-paper-caret {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--pp-accent);
    background: var(--pp-accent);
    color: var(--pp-accent-fg);
    font: inherit;
    cursor: pointer;
  }
  .new-paper-main {
    border-radius: 4px 0 0 4px;
    padding: 6px 12px;
  }
  .new-paper-caret {
    border-radius: 0 4px 4px 0;
    border-left-color: color-mix(in srgb, var(--pp-accent-fg) 35%, transparent);
    padding: 6px 8px;
  }
  .new-paper-main:hover:not(:disabled),
  .new-paper-caret:hover:not(:disabled),
  .new-paper-caret[aria-expanded="true"] {
    background: color-mix(in srgb, var(--pp-accent) 85%, var(--pp-fg));
  }
  .new-paper-main:disabled,
  .new-paper-caret:disabled {
    opacity: 0.7;
    cursor: progress;
  }
  .new-paper-main:focus-visible,
  .new-paper-caret:focus-visible {
    outline: 2px solid var(--pp-focus-ring);
    outline-offset: 2px;
  }
  .new-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 20;
    min-width: 240px;
    max-width: min(320px, 90vw);
    max-height: 60vh;
    overflow-y: auto;
    background: var(--pp-bg);
    border: 1px solid var(--pp-border-strong);
    border-radius: 6px;
    box-shadow: 0 4px 16px var(--pp-shadow);
    padding: 4px 0;
    display: flex;
    flex-direction: column;
  }
  .new-menu-heading {
    padding: 6px 12px 4px;
    font-size: 0.75em;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--pp-fg-muted);
  }
  .new-menu-filter {
    margin: 2px 8px 4px;
    padding: 4px 8px;
    font: inherit;
  }
  .new-menu-empty {
    padding: 6px 12px;
    color: var(--pp-fg-muted);
    font-size: 0.95em;
  }
  .new-menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    border: none;
    background: transparent;
    padding: 6px 12px;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: 0.95em;
    color: inherit;
  }
  .new-menu button:hover,
  .new-menu button:focus-visible {
    background: var(--pp-surface-2);
    outline: none;
  }
  .new-menu-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .new-menu-icon-spacer {
    display: inline-block;
    width: 16px;
    flex: none;
  }
  .new-menu-sep {
    border-top: 1px solid var(--pp-border);
    margin: 4px 0;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--pp-border);
    margin-top: 1em;
  }
  .tabs button {
    border: none;
    background: transparent;
    padding: 8px 14px;
    cursor: pointer;
    font: inherit;
    color: var(--pp-fg-muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tabs button.active {
    color: var(--pp-fg);
    border-bottom-color: var(--pp-accent);
  }
  .tabs button:hover:not(.active) {
    color: var(--pp-fg);
  }
  .actions-col {
    width: 1%;
    white-space: nowrap;
  }
  td.actions {
    text-align: right;
    white-space: nowrap;
  }
  .menu-wrapper {
    position: relative;
    display: inline-block;
  }
  .menu-trigger {
    border: none;
    background: transparent;
    padding: 4px 6px;
    cursor: pointer;
    border-radius: 3px;
    color: var(--pp-fg-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .menu-trigger:hover:not(:disabled),
  .menu-trigger[aria-expanded="true"] {
    background: var(--pp-surface-2);
    color: var(--pp-fg);
  }
  .menu-trigger:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  .menu {
    position: absolute;
    top: 100%;
    right: 0;
    z-index: 10;
    background: var(--pp-bg);
    border: 1px solid var(--pp-border-strong);
    border-radius: 4px;
    box-shadow: 0 2px 8px var(--pp-shadow);
    min-width: 140px;
    padding: 4px 0;
    display: flex;
    flex-direction: column;
  }
  .menu button {
    border: none;
    background: transparent;
    padding: 6px 14px;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: 0.95em;
    color: inherit;
  }
  .menu button:hover {
    background: var(--pp-surface-2);
  }
  /* deliberate literals: one-off dark danger text + its faint hover wash,
     distinct from --pp-danger / --pp-danger-bg. */
  .menu button.danger {
    color: #8a1a1a;
  }
  .menu button.danger:hover {
    background: #fbecec;
  }
  td.delete-at {
    color: var(--pp-warn);
    font-size: 0.9em;
  }
  tr.busy {
    opacity: 0.6;
  }
  .badge {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 7px;
    font-size: 11px;
    line-height: 1.4;
    border-radius: 9px;
    vertical-align: 1px;
  }
  .badge-locked {
    background: var(--pp-surface-2);
    color: var(--pp-fg-muted);
    border: 1px solid var(--pp-border);
  }
  .last-editor {
    color: var(--pp-fg-muted);
  }
  .tag-filter {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
  }
  .tag-filter-label {
    color: var(--pp-fg-muted);
    font-size: 0.85em;
  }
  .tag-filter-clear {
    border: none;
    background: transparent;
    color: var(--pp-accent);
    cursor: pointer;
    font: inherit;
    font-size: 0.85em;
  }
  .tag-filter-clear:hover {
    text-decoration: underline;
  }
  .row-tags {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-left: 6px;
    vertical-align: 1px;
  }
  .tag-chip {
    display: inline-flex;
    align-items: center;
    background: var(--pp-surface-2);
    color: var(--pp-fg);
    border: 1px solid var(--pp-border);
    border-radius: 9px;
    padding: 1px 8px;
    font-size: 11px;
    line-height: 1.5;
  }
  .tag-chip-button {
    cursor: pointer;
    font-family: inherit;
  }
  .tag-chip-button:hover {
    background: var(--pp-surface-3);
  }
  .tag-chip-button.selected {
    background: var(--pp-accent);
    color: var(--pp-accent-fg);
    border-color: var(--pp-accent);
  }
  .creator {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
  }
  .creator-avatar {
    width: 1.4em;
    height: 1.4em;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
  }

  /* ── Narrow viewports: collapse the table into stacked cards ──
   * Each row becomes a bordered card; the column headers are hidden and
   * each cell carries its label via a data-label ::before. The actions
   * menu floats to the card's top-right. */
  @media (max-width: 640px) {
    .index-header {
      flex-wrap: wrap;
    }
    .tabs {
      flex-wrap: wrap;
    }
    table,
    thead,
    tbody,
    tr,
    td {
      display: block;
    }
    thead {
      /* Hide the header row visually; cells self-label below. */
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
    }
    table {
      margin-top: 0;
    }
    tbody tr {
      position: relative;
      border: 1px solid var(--pp-border);
      border-radius: 6px;
      padding: 10px 12px;
      margin-top: 12px;
    }
    tbody td {
      border: none;
      padding: 3px 0;
    }
    /* Cells with a data-label print "Label: " before their value. The
     * Name cell has no label, so it reads as the card title. */
    td[data-label]::before {
      content: attr(data-label) ": ";
      color: var(--pp-fg-muted);
      font-size: 0.85em;
    }
    td.actions {
      position: absolute;
      top: 6px;
      right: 6px;
      padding: 0;
    }
  }

  /* --- Dark theme (append-only; light rules above untouched). The solid-pastel
     error box and the one-off danger red/wash have no matching --pp-* role, so
     re-tune the literals here. Native <input>/<select>/<button> pick up dark
     rendering from `color-scheme: dark` (app.css), so they need no rules. Both
     the explicit-dark and system/OS-dark conditions are covered. --- */
  :global([data-theme="dark"]) .error {
    background: #3a1d1d;
    color: #ffb4ab;
  }
  :global([data-theme="dark"]) .menu button.danger {
    color: #ff7b72;
  }
  :global([data-theme="dark"]) .menu button.danger:hover {
    background: rgba(248, 81, 73, 0.15);
  }
  @media (prefers-color-scheme: dark) {
    :global(:root[data-theme="system"]) .error {
      background: #3a1d1d;
      color: #ffb4ab;
    }
    :global(:root[data-theme="system"]) .menu button.danger {
      color: #ff7b72;
    }
    :global(:root[data-theme="system"])
      .menu
      button.danger:hover {
      background: rgba(248, 81, 73, 0.15);
    }
  }
</style>
