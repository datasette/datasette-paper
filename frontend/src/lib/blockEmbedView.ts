/**
 * NodeView for `block_embed`: a read-only, live-at-view-time render of a
 * Datasette table/view (capped rows), a single row's fields, or a database's
 * table listing. Unlike the inline pill there is no shared batching resolver —
 * one native `.json` fetch per mount (`fetchEmbed`, no custom backend),
 * re-fetched when `ref`/`mode`/`config` changes or the user clicks refresh
 * (the data is a snapshot at view time, not collaborative).
 *
 * Render states: loading skeleton → table / row card / database listing /
 * denied / not_found. A table also carries an overflow ("⋮") menu — Filter &
 * sort…, Columns…, Convert to inline, and Download/Copy submenus (CSV/JSON of
 * the whole result set, fetched on demand; see `overflowMenu` /
 * `fetchExportText`) — plus a filter badge and a truncated-count warning.
 *
 * XSS rule (load-bearing): every cell value, column name, and label is
 * user/data-derived and goes into the DOM as a TEXT NODE only — never
 * innerHTML. Only the trusted constant icon SVGs use innerHTML.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import {
  embedIconMarkup,
  fetchEmbed,
  iconMarkup,
  kindIcon,
  refSegments,
  safeHref,
  tildeEncode,
  type CellValue,
  type EmbedPayload,
} from "./datasetteEmbed";
import {
  attachScrollFades,
  markOverflowingCells,
  renderResultValue,
} from "./resultCell";
import { rowsToJson } from "./tableExport";
import {
  FILTER_OPS,
  filterOpByKey,
  filterQueryParams,
  sanitizeFilters,
  sanitizeSort,
  type EmbedFilter,
  type EmbedSort,
} from "./embedFilters";
import { embedRegistry, type PaperEmbedProvider } from "./embedRegistry";
import { ensureProviderForRef, manifestKindForRef } from "./embedProviders";
import type { DatasetteStatus } from "./datasetteResolver";

const ROW_LIMIT_OPTIONS = [10, 25, 100];
const DEFAULT_ROW_LIMIT = 10;

/**
 * Group an integer with thousands separators ("10000" → "10,000"). Done with a
 * regex rather than `toLocaleString` so the output is locale-independent (and
 * so jsdom tests don't depend on the runner's default locale).
 */
function formatInt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// @feat block-embed: NodeView — fetch+render table/row/db, XSS-safe cells
export class BlockEmbedView implements NodeView {
  dom: HTMLDivElement;
  private view: EditorView;
  private getPos: () => number | undefined;
  private node: PMNode;
  private ref: string | null;
  private mode: string;
  private config: Record<string, unknown>;
  // How many rows to fetch/show; user-adjustable via the footer dropdown.
  private limit = DEFAULT_ROW_LIMIT;
  // Bumped on each (re)fetch so a stale in-flight response is discarded.
  private token = 0;
  // The open overflow menu (if any) + its outside-click teardown.
  private menuEl: HTMLElement | null = null;
  // The current ⋮ overflow-menu body element (whether open or not), so the
  // header's filter badge can open it and jump straight to the filter panel.
  private overflowMenuEl: HTMLElement | null = null;
  // Timer for the export "Copied ✓/Downloaded ✓" confirmation → close, so it can
  // be cancelled (Back, a new export, destroy) rather than firing on stale DOM.
  private exportTimer: ReturnType<typeof setTimeout> | null = null;
  // Cleanup returned by a third-party provider's mount(), if any.
  private cleanupExternal: (() => void) | null = null;
  // The last table/view payload rendered, if any — drives the export items
  // (Copy page serializes its held rows; Download links target its db/table).
  // Cleared on any non-table render so the menu can't export stale data.
  private tablePayload: Extract<EmbedPayload, { kind: "table" | "view" }> | null = null;
  // The full (pre-projection) column set of the last table/view render — seeds
  // the "Columns…" picker so it can offer every column, selected ones checked.
  private allColumns: string[] = [];
  // The PK column names of the last table/view render — the picker shows these
  // as always-on (checked + disabled + key icon), since Datasette re-adds them.
  private primaryKeys: string[] = [];
  // The last-rendered header element + the args that built it, so update()
  // can rebuild just the header chrome (menu gating) when editability flips
  // mid-session without re-fetching data or re-mounting a provider body.
  private headerEl: HTMLElement | null = null;
  private headerArgs: { icon: string; label: string; href?: string } | null = null;
  // `view.editable` as of the last header render — compared against the live
  // prop to detect a mid-session flip (view/edit toggle, stepError).
  private renderedEditable = false;
  // Watches the editor root's `contenteditable` attribute (see constructor).
  private editableObserver: MutationObserver;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.view = view;
    this.getPos = getPos;
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "pm-block-embed";
    this.ref = node.attrs.ref ?? null;
    this.mode = node.attrs.mode ?? "table";
    this.config = (node.attrs.config as Record<string, unknown>) ?? {};
    // The view/edit toggle flips PM's `editable` prop via setProps without
    // dispatching a transaction, so update() below never runs (PM re-runs a
    // NodeView only when its node or decorations change). The flip DOES
    // rewrite the editor root's `contenteditable` attribute — observe that
    // and re-gate the config-writing chrome (⋮ items, per-column ▾ menus).
    this.editableObserver = new MutationObserver(() => this.regateEditable());
    this.editableObserver.observe(view.dom, {
      attributes: true,
      attributeFilter: ["contenteditable"],
    });
    void this.load();
  }

  /**
   * Re-gate the rendered chrome after an editability flip, without a
   * re-fetch. A table render carries per-column ▾ menus in its header row,
   * so rebuild the whole card from the held payload; anything else only
   * needs the header chrome swapped. No-op while the render matches.
   */
  private regateEditable(): void {
    if (!this.headerEl || this.renderedEditable === !!this.view.editable) return;
    if (this.tablePayload) {
      this.closeMenu();
      this.renderTable(this.tablePayload);
    } else {
      this.refreshHeader();
    }
  }

  private async load(): Promise<void> {
    const token = ++this.token;
    // Any (re)render rebuilds the header, so drop a stale open menu and tear
    // down any externally-mounted view first.
    this.closeMenu();
    this.disposeExternal();
    this.renderLoading();
    if (this.ref == null) {
      this.render({ status: "not_found" });
      return;
    }
    // A third-party provider that claims this ref renders it itself — paper
    // owns the header chrome, the provider fills the body (loadExternal). If
    // its bundle isn't loaded yet, lazy-inject it (manifest maps ref prefix →
    // provider) and retry; a stale load (ref change / refresh) bails after.
    let provider = embedRegistry().providerForRef(this.ref);
    if (!provider && manifestKindForRef(this.ref)) {
      await ensureProviderForRef(this.ref);
      if (token !== this.token) return;
      provider = embedRegistry().providerForRef(this.ref);
    }
    if (provider) {
      await this.loadExternal(token, provider);
      return;
    }
    const payload = await fetchEmbed(
      this.ref,
      this.limit,
      this.selectedColumns(),
      this.filters(),
      this.sort(),
    );
    // A newer load() (ref change / refresh) superseded this one.
    if (token !== this.token) return;
    this.render(payload);
  }

  /**
   * Render a third-party provider's block embed. The provider's `resolve`
   * supplies the header identity (and the leak-free denied/not_found states,
   * exactly like a core ref); its `mount` fills the body host div. A provider
   * with no `resolve` gets a generic ref-labelled header.
   */
  private async loadExternal(token: number, provider: PaperEmbedProvider): Promise<void> {
    let status: DatasetteStatus = {
      status: "ok",
      kind: provider.kind,
      label: this.ref ?? "",
      href: this.ref ?? "#",
    };
    if (provider.resolve) {
      try {
        const resolved = await provider.resolve(this.ref ?? "");
        // null = transient failure; leave the skeleton up (no cache here).
        if (resolved) status = resolved;
      } catch {
        status = { status: "not_found" };
      }
    }
    if (token !== this.token) return;
    if (status.status === "loading" || status.status === "denied") {
      // Treat a lingering "loading" as no-data; denied is leak-free.
      if (status.status === "denied") {
        this.renderPlaceholder(
          "pm-block-embed--denied",
          "You don't have access to this data",
        );
      }
      return;
    }
    if (status.status === "not_found") {
      this.renderPlaceholder("pm-block-embed--missing", "Resource not found");
      return;
    }
    this.renderExternalCard(provider, status);
  }

  /**
   * Header (from the resolved identity) + a host div the provider's renderer
   * mounts into. We own the icon/label/refresh/⋮ chrome; the renderer owns the
   * body and fetches its own data. A renderer that throws degrades to a
   * generic message rather than wedging the NodeView.
   */
  private renderExternalCard(
    provider: PaperEmbedProvider,
    status: Extract<DatasetteStatus, { status: "ok" }>,
  ): void {
    this.dom.replaceChildren();
    this.dom.appendChild(
      this.header(embedIconMarkup(status), status.label, status.href),
    );
    const host = document.createElement("div");
    host.className = "pm-block-embed-external";
    this.dom.appendChild(host);
    try {
      const cleanup = provider.mount(host, {
        ref: this.ref ?? "",
        mode: this.mode,
        config: this.config,
      });
      this.cleanupExternal = typeof cleanup === "function" ? cleanup : null;
    } catch {
      host.replaceChildren();
      const err = document.createElement("div");
      err.className = "pm-block-embed-placeholder";
      err.textContent = "This embed failed to render";
      host.appendChild(err);
    }
  }

  private disposeExternal(): void {
    if (typeof this.cleanupExternal === "function") {
      try {
        this.cleanupExternal();
      } catch {
        /* a renderer's cleanup must never wedge the NodeView */
      }
    }
    this.cleanupExternal = null;
  }

  /** An icon span from raw `<svg>` markup (a bundled icon, or a provider's). */
  private iconSpan(markup: string): HTMLSpanElement {
    const span = document.createElement("span");
    span.className = "pm-block-embed-icon";
    span.setAttribute("aria-hidden", "true");
    span.innerHTML = markup;
    return span;
  }

  private svgIcon(name: string): HTMLSpanElement {
    return this.iconSpan(iconMarkup(name));
  }

  /**
   * Header chrome: icon + db/label + a refresh control. `iconSvg` is full
   * `<svg>` markup (paper's bundled kind icon, or a provider's own). The label
   * is a link to the resource's Datasette page when `href` is known (so the
   * title is clickable, per design); the "open in Datasette" link is in the footer.
   *
   * Records its inputs + the built element so `refreshHeader()` can rebuild
   * this chrome in place when editability flips (the ⋮ menu is gated on it).
   */
  private header(iconSvg: string, label: string, href?: string): HTMLElement {
    const head = document.createElement("div");
    head.className = "pm-block-embed-head";
    head.appendChild(this.iconSpan(iconSvg));

    let labelEl: HTMLElement;
    if (href) {
      const a = document.createElement("a");
      a.className = "pm-block-embed-label pm-block-embed-label--link";
      a.href = safeHref(href);
      labelEl = a;
    } else {
      labelEl = document.createElement("span");
      labelEl.className = "pm-block-embed-label";
    }
    labelEl.textContent = label; // text node — never innerHTML
    head.appendChild(labelEl);

    // Active-filter chip: funnel + count, shown whenever this is a table/view
    // render with filters configured. Comes before the sort pill (filter first).
    // Informational, so read-only viewers see it too. For editors it's also a
    // button that opens the Filter & sort panel (a shortcut to the ⋮ menu
    // item) — viewers get a plain, inert span.
    if (this.tablePayload) {
      const filterCount = this.filters().length;
      if (filterCount > 0) {
        const plural = filterCount === 1 ? "" : "s";
        const editable = !!this.view.editable;
        const badge = document.createElement(editable ? "button" : "span");
        badge.className = "pm-block-embed-filter-badge";
        badge.appendChild(this.svgIcon("funnelFill"));
        badge.appendChild(document.createTextNode(String(filterCount)));
        if (editable) {
          const btn = badge as HTMLButtonElement;
          btn.type = "button";
          badge.classList.add("pm-block-embed-filter-badge--btn");
          badge.title = `${filterCount} filter${plural} applied — edit`;
          badge.setAttribute("aria-label", `Edit filters (${filterCount} applied)`);
          badge.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openFiltersPanel();
          });
        } else {
          badge.title = `${filterCount} filter${plural} applied`;
        }
        head.appendChild(badge);
      }
    }

    // Sort pill: asc/desc glyph + the sorted column name, shown whenever this
    // is a table/view render with a sort configured. Sits after the filter
    // badge (the sort clause is no longer spelled out in the summary line
    // below). Informational for everyone; a shortcut button into the Filter &
    // sort panel for editors, an inert span for viewers.
    if (this.tablePayload) {
      const sort = this.sort();
      if (sort) head.appendChild(this.sortPill(sort));
    }

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "pm-block-embed-refresh";
    refresh.title = "Refresh";
    refresh.setAttribute("aria-label", "Refresh");
    refresh.appendChild(this.svgIcon("redo")); // arrow-clockwise
    refresh.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.load();
    });
    head.appendChild(refresh);
    // The ⋮ menu is null when it has no items for this viewer (e.g. a
    // read-only viewer of a non-table embed) — no empty menu button.
    const menu = this.overflowMenu();
    if (menu) head.appendChild(menu);

    this.headerEl = head;
    this.headerArgs = { icon: iconSvg, label, href };
    this.renderedEditable = !!this.view.editable;
    return head;
  }

  /**
   * Rebuild the header chrome in place after an editability flip — same
   * icon/label/href, freshly gated ⋮ menu. Closes any open menu/panel first
   * (a stale open panel must not survive a flip to read-only).
   */
  private refreshHeader(): void {
    const old = this.headerEl;
    const args = this.headerArgs;
    if (!old || !args) return;
    this.closeMenu();
    old.replaceWith(this.header(args.icon, args.label, args.href));
  }

  /**
   * The header sort pill: a direction glyph (down = descending, up = ascending)
   * plus the sorted column's name. Mirrors the filter badge's edit/view split —
   * a `<button>` into the Filter & sort panel for editors, an inert `<span>` for
   * read-only viewers. The glyph carries a `dir` dataset like the in-table
   * indicator so both share the same asc/desc meaning.
   */
  private sortPill(sort: EmbedSort): HTMLElement {
    const editable = !!this.view.editable;
    const pill = document.createElement(editable ? "button" : "span");
    pill.className = "pm-block-embed-sort-pill";
    const icon = this.svgIcon(sort.desc ? "sortDown" : "sortUp");
    icon.dataset.dir = sort.desc ? "desc" : "asc";
    pill.appendChild(icon);
    pill.appendChild(document.createTextNode(sort.column)); // text node
    const dir = sort.desc ? "descending" : "ascending";
    if (editable) {
      const btn = pill as HTMLButtonElement;
      btn.type = "button";
      pill.classList.add("pm-block-embed-sort-pill--btn");
      pill.title = `Sorted by ${sort.column} ${dir} — edit`;
      pill.setAttribute("aria-label", `Edit sort (${sort.column} ${dir})`);
      pill.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openFiltersPanel();
      });
    } else {
      pill.title = `Sorted by ${sort.column} ${dir}`;
      pill.setAttribute("aria-label", `Sorted by ${sort.column} ${dir}`);
    }
    return pill;
  }

  /**
   * The summary line's filter conditions, built from paper's structured
   * `config.filters` (not Datasette's flat `human_description_en`) so the column
   * name, operator, and value each get their own styled span — a read-only
   * viewer can tell at a glance which token is the column and which is the value.
   * No-argument ops (`is null`, `is not null`, …) render the op label alone.
   * Conditions are joined by " and "; all values are text nodes, never markup.
   */
  private filterConditionEls(filters: EmbedFilter[]): Node[] {
    const out: Node[] = [];
    filters.forEach((f, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "pm-block-embed-summary-and";
        sep.textContent = "and";
        out.push(sep);
      }
      const cond = document.createElement("span");
      cond.className = "pm-block-embed-summary-cond";
      const col = document.createElement("span");
      col.className = "pm-block-embed-summary-col";
      col.textContent = f.column; // text node
      cond.appendChild(col);
      const spec = filterOpByKey(f.op);
      const op = document.createElement("span");
      op.className = "pm-block-embed-summary-op";
      op.textContent = spec?.label ?? f.op;
      cond.appendChild(op);
      // No-argument ops carry no value; everything else shows the filter value.
      if (!spec?.noValue) {
        const val = document.createElement("span");
        val.className = "pm-block-embed-summary-val";
        val.textContent = f.value ?? ""; // text node
        cond.appendChild(val);
      }
      out.push(cond);
    });
    return out;
  }

  /**
   * The "⋮" overflow menu. For a table/view, top to bottom:
   *
   *  - **Filter & sort… / Columns…** — config-writing editor panels that swap
   *    the menu body in place (editors only).
   *  - **Convert to inline element** — block → inline downgrade (editors only).
   *  - **Download ▸ / Copy ▸** — submenus (CSV / JSON) that operate on the rows
   *    currently held on the client (`payload.rows` — one `_size` page), NOT the
   *    whole server-side table. Both carry a warning when that's only a slice of
   *    the table, so a 10-row copy of a million-row table is never mistaken for
   *    the whole thing. Available to everyone — they neither edit nor write
   *    config, they just serialize already-fetched data.
   *
   * The menu is positioned within the embed (tall enough not to clip it) and
   * closes on outside click. Config/edit items render only when `view.editable`.
   * Returns null when no item is available so the header can skip the button.
   */
  private overflowMenu(): HTMLElement | null {
    const wrap = document.createElement("div");
    wrap.className = "pm-block-embed-menu-wrap";

    const menu = document.createElement("div");
    menu.className = "pm-block-embed-menu";
    // Cleared here so a render that produces no menu body (returns null below)
    // doesn't leave the badge pointing at a stale, detached menu element.
    this.overflowMenuEl = null;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pm-block-embed-menu-btn";
    btn.title = "More";
    btn.setAttribute("aria-label", "More");
    btn.appendChild(this.svgIcon("threeDotsVertical"));
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleMenu(menu);
    });
    wrap.appendChild(btn);

    this.populateMainMenu(menu);
    if (!menu.childElementCount) return null;
    wrap.appendChild(menu);
    this.overflowMenuEl = menu;
    return wrap;
  }

  /**
   * Fill (or refill, from a submenu's "Back") the ⋮ menu body with its
   * top-level items. Split from overflowMenu() so the Download/Copy submenus can
   * restore the main menu in place without rebuilding the whole header.
   */
  private populateMainMenu(menu: HTMLElement): void {
    menu.replaceChildren();
    const canEdit = !!this.view.editable;
    const payload = this.tablePayload;

    // Config-writing editor actions first (Filter & sort, then Columns).
    if (payload && canEdit && this.allColumns.length) {
      const filters = document.createElement("button");
      filters.type = "button";
      filters.className = "pm-block-embed-menu-item";
      filters.textContent = "Filter & sort…";
      // Swaps the menu body for the form in place — Apply/Cancel (or outside
      // click) closes it, rather than closing on click like menuButton.
      filters.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showFiltersPanel(menu);
      });
      menu.appendChild(filters);

      const cols = document.createElement("button");
      cols.type = "button";
      cols.className = "pm-block-embed-menu-item";
      cols.textContent = "Columns…";
      cols.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showColumnsPanel(menu);
      });
      menu.appendChild(cols);
    }

    // Converting rewrites the document — an edit, gated like config writes.
    if (canEdit) {
      menu.appendChild(
        this.menuButton("Convert to inline element", () => this.convertToInline()),
      );
    }

    // Download / Copy operate on the client-held rows only (one _size page),
    // never a server-side full-table export — a huge table can't be pulled down
    // by accident. Each opens a CSV/JSON submenu in place.
    if (payload) {
      menu.appendChild(
        this.submenuParent("Download", () => this.showExportSubmenu(menu, "download")),
      );
      menu.appendChild(
        this.submenuParent("Copy", () => this.showExportSubmenu(menu, "copy")),
      );
    }
  }

  /** A top-level ⋮ item that opens a submenu: the label + a trailing chevron. */
  private submenuParent(label: string, open: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pm-block-embed-menu-item pm-block-embed-menu-item--parent";
    b.appendChild(document.createTextNode(label));
    const trail = document.createElement("span");
    trail.className = "pm-block-embed-menu-trail";
    const chevron = this.svgIcon("chevronRight");
    chevron.classList.add("pm-block-embed-menu-chevron");
    trail.appendChild(chevron);
    b.appendChild(trail);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      open();
    });
    return b;
  }

  /**
   * Swap the ⋮ menu body for a Download/Copy submenu: a "Back" row that restores
   * the main menu, then CSV and JSON leaves. A leaf fetches the *entire* current
   * result set (all filtered/sorted rows, not the held page — see
   * `fetchExportText`), reporting progress in place: "Copying…"/"Downloading…"
   * while the fetch runs, then "Copied ✓"/"Downloaded ✓" for ~1s. On a very large
   * (count-truncated) table it carries a warning that the export may be slow.
   */
  private showExportSubmenu(menu: HTMLElement, mode: "download" | "copy"): void {
    const payload = this.tablePayload;
    if (!payload) return;
    menu.replaceChildren();

    const back = document.createElement("button");
    back.type = "button";
    back.className = "pm-block-embed-menu-item pm-block-embed-menu-item--back";
    const backIcon = this.svgIcon("chevronLeft");
    backIcon.classList.add("pm-block-embed-menu-chevron");
    back.appendChild(backIcon);
    back.appendChild(document.createTextNode(mode === "download" ? "Download" : "Copy"));
    back.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.clearExportTimer();
      this.populateMainMenu(menu);
    });
    menu.appendChild(back);

    for (const format of ["csv", "json"] as const) {
      menu.appendChild(this.exportLeaf(menu, payload, mode, format));
    }
  }

  /**
   * One CSV/JSON leaf of a Download/Copy submenu. The label lives in its own
   * span so `runExport` can flip it through the busy/done states; a warning
   * glyph rides alongside when the table is count-truncated (a full export will
   * be large/slow).
   */
  private exportLeaf(
    menu: HTMLElement,
    payload: Extract<EmbedPayload, { kind: "table" | "view" }>,
    mode: "download" | "copy",
    format: "csv" | "json",
  ): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pm-block-embed-menu-item pm-block-embed-export-leaf";
    const label = document.createElement("span");
    label.className = "pm-block-embed-export-label";
    label.textContent = format.toUpperCase();
    b.appendChild(label);
    if (payload.countTruncated) {
      const trail = document.createElement("span");
      trail.className = "pm-block-embed-menu-trail";
      const verb = mode === "copy" ? "copy" : "download";
      trail.appendChild(
        this.warningIcon(
          `This table has ${this.countPhrase(payload)} — exporting every row may be slow to ${verb}.`,
        ),
      );
      b.appendChild(trail);
    }
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.runExport(menu, b, label, payload, mode, format);
    });
    return b;
  }

  /**
   * Fetch the whole result set and copy/download it, animating the leaf's label.
   * Keeps the menu open so the "Copying…" → "Copied ✓" states are visible; the
   * done state lingers ~1s, then the menu closes and resets to its main body.
   * Re-entrancy-guarded via `data-busy` so a double-click can't double-fetch.
   */
  private async runExport(
    menu: HTMLElement,
    btn: HTMLButtonElement,
    label: HTMLElement,
    payload: Extract<EmbedPayload, { kind: "table" | "view" }>,
    mode: "download" | "copy",
    format: "csv" | "json",
  ): Promise<void> {
    if (btn.dataset.busy) return;
    this.clearExportTimer();
    btn.dataset.busy = "1";
    btn.classList.add("pm-block-embed-export-leaf--busy");
    label.textContent = mode === "copy" ? "Copying…" : "Downloading…";
    try {
      const text = await this.fetchExportText(payload, format);
      if (mode === "copy") await navigator.clipboard?.writeText(text);
      else this.saveBlob(payload, format, text);
      // The action is done; if the submenu was torn down mid-fetch (Back, an
      // outside click + reopen, a re-render), don't animate a detached node or
      // schedule a surprise close.
      if (!btn.isConnected) return;
      btn.classList.remove("pm-block-embed-export-leaf--busy");
      btn.classList.add("pm-block-embed-export-leaf--done");
      const check = this.svgIcon("check");
      check.classList.add("pm-block-embed-menu-chevron");
      label.replaceChildren(check, document.createTextNode(mode === "copy" ? "Copied" : "Downloaded"));
      // Linger on the confirmation, then close + reset so the next open is clean.
      this.exportTimer = setTimeout(() => {
        this.exportTimer = null;
        this.closeMenu();
        this.populateMainMenu(menu);
      }, 1100);
    } catch {
      btn.classList.remove("pm-block-embed-export-leaf--busy");
      btn.dataset.busy = "";
      label.textContent = `${format.toUpperCase()} — failed, retry`;
    }
  }

  private clearExportTimer(): void {
    if (this.exportTimer != null) {
      clearTimeout(this.exportTimer);
      this.exportTimer = null;
    }
  }

  /**
   * Fetch the ENTIRE current result set as CSV/JSON text — every filtered/sorted
   * row, not just the held page. CSV uses Datasette's `_stream=on` (unbounded,
   * single request). JSON has no unbounded stream, so page through `_shape=arrays`
   * (`_size=max`) following `next` until it runs out or a safety cap, then
   * serialize with `rowsToJson`. Both carry the embed's filters/sort/columns via
   * `shareableParams`. Same-origin fetch → the actor's cookie enforces perms.
   */
  private async fetchExportText(
    payload: Extract<EmbedPayload, { kind: "table" | "view" }>,
    format: "csv" | "json",
  ): Promise<string> {
    const path = "/" + refSegments(payload.href).map(encodeURIComponent).join("/");
    if (format === "csv") {
      const params = this.shareableParams();
      params.set("_stream", "on");
      const res = await fetch(`${path}.csv?${params.toString()}`);
      if (!res.ok) throw new Error(`export failed (${res.status})`);
      return res.text();
    }
    const MAX_ROWS = 100_000; // safety valve for pathologically large tables
    const base = this.shareableParams();
    base.set("_shape", "arrays");
    base.set("_size", "max");
    // `_shape=arrays` omits the column list unless asked — without it rowsToJson
    // would key every row against an empty header. (`count` is deliberately not
    // requested; we don't need it and it's the expensive extra.)
    base.set("_extra", "columns");
    let columns: string[] = [];
    const rows: CellValue[][] = [];
    let next: string | null = null;
    do {
      const params = new URLSearchParams(base);
      if (next) params.set("_next", next);
      const res = await fetch(`${path}.json?${params.toString()}`);
      if (!res.ok) throw new Error(`export failed (${res.status})`);
      const j = (await res.json()) as {
        columns?: string[];
        rows?: CellValue[][];
        next?: string | null;
      };
      columns = j.columns ?? columns;
      for (const r of j.rows ?? []) rows.push(r);
      next = rows.length < MAX_ROWS ? (j.next ?? null) : null;
    } while (next);
    return rowsToJson(columns, rows);
  }

  /** Save already-serialized export text as a client-side download. */
  private saveBlob(
    payload: Extract<EmbedPayload, { kind: "table" | "view" }>,
    format: "csv" | "json",
    text: string,
  ): void {
    const mime = format === "csv" ? "text/csv;charset=utf-8" : "application/json";
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${payload.db}-${payload.label}.${format}`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * Open the ⋮ overflow menu and swap straight to the Filter & sort panel —
   * the header filter badge's shortcut. No-op for viewers or when the menu has
   * no body (e.g. no editable config items), mirroring the menu item's gate.
   */
  private openFiltersPanel(): void {
    const menu = this.overflowMenuEl;
    if (!this.view.editable || !menu) return;
    if (this.menuEl !== menu) this.toggleMenu(menu); // open it if not already
    this.showFiltersPanel(menu);
  }

  /**
   * The author's column selection from `config.columns`, or `undefined` when
   * absent/empty/malformed (== "show all"). Guards to a non-empty array of
   * non-empty strings so a bad config value degrades to no filtering rather
   * than poisoning the fetch URL.
   */
  private selectedColumns(): string[] | undefined {
    const cols = (this.config as { columns?: unknown }).columns;
    if (!Array.isArray(cols)) return undefined;
    const valid = cols.filter((c): c is string => typeof c === "string" && c.length > 0);
    return valid.length ? valid : undefined;
  }

  /**
   * The author's row filters from `config.filters`, bad entries dropped
   * (same defensive spirit as `selectedColumns()` — config can arrive from
   * hand-written markdown and must degrade, never poison the fetch).
   */
  private filters(): EmbedFilter[] {
    return sanitizeFilters((this.config as { filters?: unknown }).filters);
  }

  /** The author's sort from `config.sort`, or null when absent/malformed. */
  private sort(): EmbedSort | null {
    return sanitizeSort((this.config as { sort?: unknown }).sort);
  }

  /**
   * Swap the open ⋮ menu's body for an inline checklist of `allColumns`, each
   * checked iff currently selected (all checked when no selection = "show all").
   * Primary-key columns render checked + disabled with a key icon: Datasette
   * always re-adds PKs to any `_col` projection, so they can't be hidden — the
   * disabled box (with a hover explanation) reflects that rather than offering
   * a toggle that wouldn't stick. "Apply" writes the ordered selection to
   * `config.columns` and closes.
   */
  private showColumnsPanel(menu: HTMLElement): void {
    if (!this.view.editable) return; // belt-and-braces: viewers never write config
    menu.replaceChildren();
    const panel = document.createElement("div");
    panel.className = "pm-block-embed-columns";

    const pks = new Set(this.primaryKeys);
    const selected = new Set(this.selectedColumns() ?? this.allColumns);
    const inputs: { col: string; input: HTMLInputElement }[] = [];
    for (const col of this.allColumns) {
      const isPk = pks.has(col);
      const label = document.createElement("label");
      label.className = "pm-block-embed-columns-item";
      const input = document.createElement("input");
      input.type = "checkbox";
      // A PK is always shown, so it's always checked and can't be unchecked.
      input.checked = isPk || selected.has(col);
      if (isPk) {
        input.disabled = true;
        label.classList.add("pm-block-embed-columns-item--pk");
        label.title = "Primary key — always included by Datasette";
      }
      const text = document.createElement("span");
      text.textContent = col; // text node — column names are data-derived
      label.appendChild(input);
      label.appendChild(text);
      if (isPk) {
        const key = this.svgIcon("keyFill");
        key.classList.add("pm-block-embed-columns-pk-icon");
        label.appendChild(key);
      }
      panel.appendChild(label);
      inputs.push({ col, input });
    }

    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "pm-block-embed-menu-item pm-block-embed-columns-apply";
    apply.textContent = "Apply";
    apply.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const picked = inputs.filter((i) => i.input.checked).map((i) => i.col);
      // All checked == "show all": store `[]` (minimal config, clean fence)
      // rather than the full list.
      const next = picked.length === this.allColumns.length ? [] : picked;
      this.closeMenu();
      this.setColumns(next);
    });
    panel.appendChild(apply);
    menu.appendChild(panel);
  }

  /**
   * Swap the open ⋮ menu's body for the filter & sort form: one row per
   * active filter (column / op / value) plus an always-present trailing blank
   * row, a sort row, the shared-view notice, and Cancel / "Apply for
   * everyone". All editing is local to the form — nothing dispatches until
   * Apply, which commits the whole form as ONE setNodeMarkup step (never
   * per keystroke), or nothing at all when the result equals the current
   * config. Cancel (or outside click) discards.
   */
  // @feat embed-filters: editor UI — filter panel, per-column ▾ menu, badge + summary line
  private showFiltersPanel(menu: HTMLElement): void {
    if (!this.view.editable) return; // belt-and-braces: viewers never write config
    menu.replaceChildren();
    const panel = document.createElement("div");
    panel.className = "pm-block-embed-filters";

    const rowsHost = document.createElement("div");
    rowsHost.className = "pm-block-embed-filter-rows";
    panel.appendChild(rowsHost);

    type FilterRow = {
      el: HTMLElement;
      column: HTMLSelectElement;
      op: HTMLSelectElement;
      value: HTMLInputElement;
    };
    const rows: FilterRow[] = [];

    const columnSelect = (
      className: string,
      blankLabel: string,
      selected: string,
    ): HTMLSelectElement => {
      const select = document.createElement("select");
      select.className = className;
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = blankLabel;
      select.appendChild(blank);
      for (const col of this.allColumns) {
        const opt = document.createElement("option");
        opt.value = col;
        opt.textContent = col; // text node — column names are data-derived
        if (col === selected) opt.selected = true;
        select.appendChild(opt);
      }
      return select;
    };

    const addRow = (seed?: EmbedFilter): void => {
      const el = document.createElement("div");
      el.className = "pm-block-embed-filter-row";

      const column = columnSelect(
        "pm-block-embed-filter-column",
        "– column –",
        seed?.column ?? "",
      );
      const op = document.createElement("select");
      op.className = "pm-block-embed-filter-op";
      for (const o of FILTER_OPS) {
        const opt = document.createElement("option");
        opt.value = o.key;
        opt.textContent = o.label;
        if (o.key === seed?.op) opt.selected = true;
        op.appendChild(opt);
      }
      const value = document.createElement("input");
      value.type = "text";
      value.className = "pm-block-embed-filter-value";
      value.value = seed?.value ?? "";
      // A no-value op (is null, is blank, …) takes no argument — hide and
      // disable the value box; re-evaluated whenever the op changes.
      const syncValue = (): void => {
        const noValue = !!filterOpByKey(op.value)?.noValue;
        value.disabled = noValue;
        value.hidden = noValue;
      };
      syncValue();
      op.addEventListener("change", syncValue);
      // Choosing a column on the trailing blank row grows a fresh blank row
      // (Datasette's always-one-empty-row form pattern).
      column.addEventListener("change", () => {
        if (column.value && rows[rows.length - 1]?.column === column) addRow();
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "pm-block-embed-filter-remove";
      remove.title = "Remove filter";
      remove.setAttribute("aria-label", "Remove filter");
      remove.appendChild(this.svgIcon("x"));
      remove.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const i = rows.findIndex((r) => r.el === el);
        if (i >= 0) rows.splice(i, 1);
        el.remove();
        // Keep the invariant: always one trailing blank row.
        if (!rows.length || rows[rows.length - 1].column.value !== "") addRow();
      });

      el.appendChild(column);
      el.appendChild(op);
      el.appendChild(value);
      el.appendChild(remove);
      rowsHost.appendChild(el);
      rows.push({ el, column, op, value });
    };

    for (const f of this.filters()) addRow(f);
    addRow(); // the trailing blank row

    // Sort row: "– no sort –" + every column, with an asc/desc control.
    const sort = this.sort();
    const sortRow = document.createElement("div");
    sortRow.className = "pm-block-embed-filter-sort";
    const sortLabel = document.createElement("span");
    sortLabel.className = "pm-block-embed-filter-sort-label";
    sortLabel.textContent = "Sort";
    const sortColumn = columnSelect(
      "pm-block-embed-filter-sort-column",
      "– no sort –",
      sort?.column ?? "",
    );
    const sortDir = document.createElement("select");
    sortDir.className = "pm-block-embed-filter-sort-dir";
    for (const [dirValue, dirLabel] of [
      ["asc", "ascending"],
      ["desc", "descending"],
    ]) {
      const opt = document.createElement("option");
      opt.value = dirValue;
      opt.textContent = dirLabel;
      if ((dirValue === "desc") === !!sort?.desc) opt.selected = true;
      sortDir.appendChild(opt);
    }
    sortRow.appendChild(sortLabel);
    sortRow.appendChild(sortColumn);
    sortRow.appendChild(sortDir);
    panel.appendChild(sortRow);

    // Shared-view notice — informational, pairs with the Apply button label:
    // this config is document state, not a private per-session filter.
    const notice = document.createElement("div");
    notice.className = "pm-block-embed-shared-notice";
    notice.appendChild(this.svgIcon("people"));
    notice.appendChild(
      document.createTextNode(
        "Shared view — filters are saved in the document and change what everyone sees.",
      ),
    );
    panel.appendChild(notice);

    const actions = document.createElement("div");
    actions.className = "pm-block-embed-filter-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pm-block-embed-filter-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.closeMenu(); // discard — nothing dispatched while editing
    });
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "pm-block-embed-filter-apply";
    apply.textContent = "Apply for everyone";
    apply.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Collect the form; incomplete rows — no column, an unknown op, or an
      // empty value on a value-taking op — are dropped (Datasette's own
      // "- remove filter -" semantics).
      const filters: EmbedFilter[] = [];
      for (const r of rows) {
        const column = r.column.value;
        if (!column) continue;
        const known = filterOpByKey(r.op.value);
        if (!known) continue;
        if (known.noValue) {
          filters.push({ column, op: known.key });
        } else if (r.value.value !== "") {
          filters.push({ column, op: known.key, value: r.value.value });
        }
      }
      // Minimal config, clean fence: no filters/sort → drop the key entirely
      // (the tocView setConfig normalization precedent).
      const next: Record<string, unknown> = { ...(this.node.attrs.config ?? {}) };
      if (filters.length) next.filters = filters;
      else delete next.filters;
      if (sortColumn.value) {
        next.sort =
          sortDir.value === "desc"
            ? { column: sortColumn.value, desc: true }
            : { column: sortColumn.value };
      } else {
        delete next.sort;
      }
      this.closeMenu();
      const current = (this.node.attrs.config as Record<string, unknown>) ?? {};
      // An unchanged config dispatches no step at all.
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      this.writeConfig(next);
    });
    actions.appendChild(cancel);
    actions.appendChild(apply);
    panel.appendChild(actions);
    menu.appendChild(panel);
  }

  /** Merge `columns` into the node's `config` attr; update() then re-fetches. */
  private setColumns(columns: string[]): void {
    this.writeConfig({ ...(this.node.attrs.config ?? {}), columns });
  }

  /** Write a full config bag to the node's attrs as one setNodeMarkup step. */
  private writeConfig(config: Record<string, unknown>): void {
    if (!this.view.editable) return; // the server 403s the step anyway
    const pos = this.getPos();
    if (pos == null) return;
    const { state, dispatch } = this.view;
    dispatch(state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, config }));
  }

  /**
   * The per-column ▾ header menu (Datasette's cog, translated to config
   * writes — editors only, the caller gates on `view.editable`): sort
   * ascending/descending with the active direction suppressed and "Clear
   * sort" in its place, hide this column (absent when it's the last visible
   * one), and show all columns (present only while `config.columns` is set).
   *
   * Each item is ONE writeConfig step. Ascending writes `sort: {column}`
   * with NO `desc: false` — the same normalization the filter panel uses, so
   * asc → the key's absence and equal configs never ping-pong steps. Open /
   * close / outside-click reuse the ⋮ menu's toggleMenu mechanics, which also
   * guarantees only one menu (⋮ or any column's) is open at a time.
   */
  private columnMenu(col: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "pm-block-embed-menu-wrap pm-block-embed-col-menu-wrap";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pm-block-embed-col-menu-btn";
    btn.title = `Column actions: ${col}`;
    btn.setAttribute("aria-label", `Column actions: ${col}`);
    btn.appendChild(this.svgIcon("chevronDown"));
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleMenu(menu);
    });
    wrap.appendChild(btn);

    const menu = document.createElement("div");
    menu.className = "pm-block-embed-menu pm-block-embed-col-menu";

    // menuButton closes the menu before running the action; prepending the
    // icon keeps the button's textContent equal to the plain label.
    const item = (icon: string, label: string, action: () => void): void => {
      const b = this.menuButton(label, action);
      b.prepend(this.svgIcon(icon));
      menu.appendChild(b);
    };
    // Spread-and-set/delete one key — empty keys dropped (minimal config,
    // clean fence), everything else in the bag untouched.
    const writeSort = (sort?: EmbedSort): void => {
      const next: Record<string, unknown> = { ...(this.node.attrs.config ?? {}) };
      if (sort) next.sort = sort;
      else delete next.sort;
      this.writeConfig(next);
    };

    const sort = this.sort();
    const isAsc = sort != null && sort.column === col && sort.desc !== true;
    const isDesc = sort != null && sort.column === col && sort.desc === true;
    if (!isAsc) {
      item("sortUp", "Sort ascending", () => writeSort({ column: col }));
    }
    if (!isDesc) {
      item("sortDown", "Sort descending", () => writeSort({ column: col, desc: true }));
    }
    if (isAsc || isDesc) {
      item("x", "Clear sort", () => writeSort());
    }

    // "Visible" = the author's selection, or every column when unset — the
    // same source the picker seeds from. Hiding the last visible column
    // would render nothing, so that item disappears instead (Datasette's
    // ">1 visible" cog condition). A primary key can't be hidden at all —
    // Datasette re-adds it to every projection — so it shows disabled with the
    // reason rather than silently vanishing (which would read as "not here").
    const visible = this.selectedColumns() ?? this.allColumns;
    const remaining = visible.filter((c) => c !== col);
    if (this.primaryKeys.includes(col)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pm-block-embed-menu-item pm-block-embed-menu-item--disabled";
      b.disabled = true;
      b.textContent = "Hide this column";
      b.prepend(this.svgIcon("eyeSlash"));
      b.title = "Primary key — always included by Datasette, can't be hidden";
      menu.appendChild(b);
    } else if (remaining.length) {
      item("eyeSlash", "Hide this column", () => {
        this.writeConfig({ ...(this.node.attrs.config ?? {}), columns: remaining });
      });
    }
    if ((this.config as { columns?: unknown }).columns !== undefined) {
      item("eye", "Show all columns", () => {
        const next: Record<string, unknown> = { ...(this.node.attrs.config ?? {}) };
        delete next.columns;
        this.writeConfig(next);
      });
    }

    wrap.appendChild(menu);
    return wrap;
  }

  /** A menu button that closes the menu, then runs `action`. */
  private menuButton(label: string, action: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pm-block-embed-menu-item";
    b.textContent = label;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.closeMenu();
      action();
    });
    return b;
  }

  private toggleMenu(menu: HTMLElement): void {
    if (this.menuEl === menu) {
      this.closeMenu();
      return;
    }
    this.closeMenu();
    // Visibility is a class (not the `hidden` attr) so an author `display`
    // rule can't leave it stuck visible — see the matching CSS.
    menu.classList.add("pm-block-embed-menu--open");
    this.menuEl = menu;
    // Capture-phase so a click anywhere else closes before it does anything.
    document.addEventListener("mousedown", this.onOutsideClick, true);
    document.addEventListener("keydown", this.onKeydown, true);
  }

  private closeMenu(): void {
    if (!this.menuEl) return;
    this.menuEl.classList.remove("pm-block-embed-menu--open");
    this.menuEl = null;
    document.removeEventListener("mousedown", this.onOutsideClick, true);
    document.removeEventListener("keydown", this.onKeydown, true);
  }

  private onOutsideClick = (e: MouseEvent): void => {
    const wrap = this.menuEl?.parentElement;
    if (wrap && !wrap.contains(e.target as Node)) this.closeMenu();
  };

  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.closeMenu();
  };

  /**
   * Replace this block embed with a paragraph holding the inline
   * `inline_embed` pill for the same ref — an easy block → inline downgrade.
   */
  private convertToInline(): void {
    if (!this.view.editable) return; // rewrites the doc — editors only
    const pos = this.getPos();
    if (pos == null) return;
    const { state, dispatch } = this.view;
    const refNode = state.schema.nodes.inline_embed.create({ ref: this.ref });
    const para = state.schema.nodes.paragraph.create(null, refNode);
    dispatch(state.tr.replaceWith(pos, pos + this.node.nodeSize, para));
    this.view.focus();
  }

  /**
   * The row-limit dropdown (10/25/100) — re-fetches on change. Sits inline as
   * the count in the footer ("showing [25] of 1,234 rows").
   */
  private rowLimitSelect(): HTMLSelectElement {
    const select = document.createElement("select");
    select.className = "pm-block-embed-rows";
    for (const n of ROW_LIMIT_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = String(n);
      if (n === this.limit) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      const next = Number(select.value);
      if (next === this.limit) return;
      this.limit = next;
      void this.load();
    });
    return select;
  }

  private renderLoading(): void {
    this.dom.replaceChildren();
    this.headerEl = null;
    this.headerArgs = null;
    this.dom.classList.remove(
      "pm-block-embed--denied",
      "pm-block-embed--missing",
      "pm-block-embed--error",
    );
    const skel = document.createElement("div");
    skel.className = "pm-block-embed-skeleton";
    skel.textContent = "Loading…";
    this.dom.appendChild(skel);
  }

  private renderPlaceholder(modifier: string, text: string): void {
    this.dom.replaceChildren();
    this.headerEl = null;
    this.headerArgs = null;
    this.dom.classList.add(modifier);
    const el = document.createElement("div");
    el.className = "pm-block-embed-placeholder";
    el.textContent = text; // text node — safe even for a server error string
    this.dom.appendChild(el);
  }

  private render(payload: EmbedPayload): void {
    // Default to "no exportable table" — renderTable re-sets it below.
    this.tablePayload = null;
    this.dom.classList.remove(
      "pm-block-embed--denied",
      "pm-block-embed--missing",
      "pm-block-embed--error",
    );
    if (payload.status === "denied") {
      this.renderPlaceholder(
        "pm-block-embed--denied",
        "You don't have access to this data",
      );
      return;
    }
    if (payload.status === "not_found") {
      this.renderPlaceholder("pm-block-embed--missing", "Resource not found");
      return;
    }
    if (payload.status === "error") {
      // Datasette's own error string (e.g. a 400 from a stale filter/sort
      // column) — data-derived, so it lands as a text node like everything else.
      this.renderPlaceholder("pm-block-embed--error", payload.message);
      return;
    }
    if (payload.kind === "row") {
      this.renderRow(payload);
    } else if (payload.kind === "database") {
      this.renderDatabase(payload);
    } else {
      this.renderTable(payload);
    }
  }

  /**
   * The row-count phrase for the summary line and footer. When Datasette's
   * count hit its configurable limit (`countTruncated`), the reported `count`
   * is that limit + 1 and the real total is only known to be *at least* that —
   * so phrase it as "N+ rows" where N is the limit (`count - 1`), derived from
   * the response rather than a hardcoded threshold. Otherwise the exact count.
   */
  private countPhrase(
    payload: Extract<EmbedPayload, { kind: "table" | "view" }>,
  ): string {
    if (payload.count == null) return "";
    if (payload.countTruncated) return `${formatInt(payload.count - 1)}+ rows`;
    return `${formatInt(payload.count)} row${payload.count === 1 ? "" : "s"}`;
  }

  /** An amber warning glyph carrying `msg` as its hover title + aria-label. */
  private warningIcon(msg: string): HTMLElement {
    const el = this.svgIcon("exclamationTriangle");
    el.classList.add("pm-block-embed-count-warn");
    el.setAttribute("aria-hidden", "false");
    el.setAttribute("role", "img");
    el.title = msg;
    el.setAttribute("aria-label", msg);
    return el;
  }

  /**
   * A warning glyph (with a hover/aria explanation) shown next to a truncated
   * count: the embed is a page from a table Datasette declined to fully count,
   * so its true size exceeds the "N+" figure displayed.
   */
  private countTruncationWarning(
    payload: Extract<EmbedPayload, { kind: "table" | "view" }>,
  ): HTMLElement {
    const limit = (payload.count ?? 1) - 1;
    return this.warningIcon(
      `Datasette stopped counting at ${formatInt(limit)} rows — the table has more.`,
    );
  }

  private renderTable(
    payload: Extract<EmbedPayload, { kind: "table" | "view" }>,
  ): void {
    // Set before header() so overflowMenu() can offer the export items and the
    // column picker (allColumns = the full set, before config.columns subsets).
    this.tablePayload = payload;
    this.allColumns = payload.allColumns;
    this.primaryKeys = payload.primaryKeys;
    this.dom.replaceChildren();
    this.dom.appendChild(
      this.header(
        iconMarkup(kindIcon(payload.kind)),
        `${payload.db}/${payload.label}`,
        this.tablePageHref(payload.href),
      ),
    );

    // Summary line: the active filter conditions ("<col> <op> <value> and …"),
    // built from structured config so column/op/value are separately styled.
    // Visible to everyone (it's how read-only viewers learn the embed is a
    // filtered slice); no count prefix (the footer already shows the total) and
    // no sort clause (that moved to the header sort pill). Omitted entirely when
    // there are no filters.
    const filters = this.filters();
    if (filters.length > 0) {
      const summary = document.createElement("div");
      summary.className = "pm-block-embed-summary";
      summary.append(...this.filterConditionEls(filters));
      this.dom.appendChild(summary);
    }

    // The non-scrolling wrap exists for the edge fades: absolutely
    // positioned children of the scroll box itself would scroll away.
    const wrap = document.createElement("div");
    wrap.className = "pm-result-scrollwrap";
    const scroll = document.createElement("div");
    scroll.className = "pm-block-embed-scroll";
    const table = document.createElement("table");

    // @feat embed-pk-links: pk-aware header icons, per-row row-page links
    // Primary keys the render actually shows (Datasette re-adds pks to any
    // `_col` projection, so normally all of them). Row links need every pk
    // column present to address a row; a single pk turns its own cell into the
    // link, a compound pk gets a leading "#" column instead.
    const pkSet = new Set(payload.primaryKeys);
    const pkIndices = payload.primaryKeys.map((c) => payload.columns.indexOf(c));
    const allPksShown = payload.primaryKeys.length > 0 && pkIndices.every((i) => i >= 0);
    const singlePkIndex = allPksShown && payload.primaryKeys.length === 1 ? pkIndices[0] : -1;
    const showRowlinkCol = allPksShown && payload.primaryKeys.length > 1;

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    const sort = this.sort();
    // The rendered index of the sorted column, so its body cells get the same
    // tint as its header (-1 when the sort column isn't among the shown ones).
    const sortedColIndex = sort ? payload.columns.indexOf(sort.column) : -1;
    // Leading unnamed header for the compound-key "#" row-link column.
    if (showRowlinkCol) {
      const th = document.createElement("th");
      th.className = "pm-block-embed-rowlink-col";
      th.setAttribute("aria-label", "Row link");
      htr.appendChild(th);
    }
    for (const col of payload.columns) {
      const th = document.createElement("th");
      th.appendChild(document.createTextNode(col)); // text node
      // Primary-key columns carry a key glyph, shown to EVERYONE — the same
      // signal the Columns picker uses for its always-on pk rows.
      if (pkSet.has(col)) {
        const key = this.svgIcon("keyFill");
        key.classList.add("pm-block-embed-pk-icon");
        th.appendChild(key);
        th.title = "Primary key column";
      }
      // Passive sort indicator on the sorted column — rendered for EVERYONE
      // (viewers included); only the config-writing menu below is gated.
      if (sort?.column === col) {
        th.classList.add("pm-block-embed-col-sorted");
        const ind = this.svgIcon(sort.desc ? "sortDown" : "sortUp");
        ind.classList.add("pm-block-embed-sort-ind");
        ind.dataset.dir = sort.desc ? "desc" : "asc";
        th.appendChild(ind);
      }
      // The ▾ column-actions menu writes config — editors only (T02 gate).
      if (this.view.editable) th.appendChild(this.columnMenu(col));
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of payload.rows) {
      const tr = document.createElement("tr");
      const rowHref =
        allPksShown ? this.rowPageHref(payload.href, row, pkIndices) : null;
      // Compound-key row-link cell: a "#" anchor to the row page.
      if (showRowlinkCol) {
        const td = document.createElement("td");
        td.className = "pm-block-embed-rowlink-col";
        if (rowHref) td.appendChild(this.rowLink(rowHref, "#"));
        tr.appendChild(td);
      }
      row.forEach((cell, i) => {
        const td = document.createElement("td");
        if (i === sortedColIndex) td.classList.add("pm-block-embed-col-sorted");
        // Single-pk cell becomes the row link (value as its text); every other
        // cell renders plain.
        if (i === singlePkIndex && rowHref) {
          const a = this.rowLink(rowHref);
          a.classList.add("pm-block-embed-pk-link");
          // @feat result-cells: block-embed cells render clamped + expandable
          renderResultValue(a, cell); // text nodes only, inside the link
          td.appendChild(a);
        } else {
          // @feat result-cells: block-embed cells render clamped + expandable
          renderResultValue(td, cell); // text nodes only
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);
    this.dom.appendChild(wrap);
    attachScrollFades(wrap, scroll);
    markOverflowingCells(table);

    // Right (margin-left:auto on the info span pushes it over): "showing [25]
    // of 1,234 rows" — the count number is the limit dropdown.
    const info = document.createElement("span");
    info.append("showing ", this.rowLimitSelect());
    if (payload.count != null) {
      info.append(` of ${this.countPhrase(payload)}`);
      // When the count is capped at Datasette's limit, flag it: the true total
      // is larger than the "N+" shown, so the table is bigger than it looks.
      if (payload.countTruncated) info.append(" ", this.countTruncationWarning(payload));
    } else {
      info.append(" rows");
    }
    // The footer "open in Datasette" link, like the header title and the
    // export links, carries the embed's filters/sort/columns so the Datasette
    // page opens showing exactly what the embed shows.
    this.appendFooter(this.tablePageHref(payload.href), info);
  }

  /**
   * The embed's shareable query params: the `col__op=value` filter pairs,
   * `_sort`/`_sort_desc`, and one `_col` per selected column. Built through
   * URLSearchParams so crafted filter values can't break out of the query
   * string. Shared by the header title link, the footer link, and the CSV/JSON
   * export links so all four open the *same* filtered slice.
   */
  private shareableParams(): URLSearchParams {
    const params = new URLSearchParams(filterQueryParams(this.filters(), this.sort()));
    for (const col of this.selectedColumns() ?? []) params.append("_col", col);
    return params;
  }

  /**
   * The `/db/table` path for a ref, rebuilt from its segments so a crafted
   * `href` can't inject extra path/query (the exportUrl trick). The base for
   * both the table-page link and the per-row links.
   */
  private tablePath(href: string): string {
    return "/" + refSegments(href).map(encodeURIComponent).join("/");
  }

  /**
   * The header title-link URL for a table/view: Datasette's own table page
   * with the embed's filters, sort, and column subset already applied, so
   * clicking through shows exactly what the embed shows. Fetch-only params
   * (`_shape`/`_extra`/`_size`) are never carried: the page picks its own.
   */
  private tablePageHref(href: string): string {
    const path = this.tablePath(href);
    const query = this.shareableParams().toString();
    return query ? `${path}?${query}` : path;
  }

  // @feat embed-pk-links: build a Datasette row-page URL from a row's pk cells
  /**
   * The Datasette row-page URL for one rendered row: `/db/table/<pk-path>`,
   * where the pk path is each primary-key cell tilde-encoded and joined by `,`
   * (Datasette's compound-key delimiter). `pkIndices` are the pk columns'
   * positions in the rendered row. Returns null when any pk cell isn't a plain
   * scalar (null / blob) — such a row can't be addressed, so it gets no link.
   */
  private rowPageHref(href: string, row: CellValue[], pkIndices: number[]): string | null {
    const parts: string[] = [];
    for (const i of pkIndices) {
      const v = row[i];
      if (typeof v !== "string" && typeof v !== "number") return null;
      parts.push(tildeEncode(String(v)));
    }
    return `${this.tablePath(href)}/${parts.join(",")}`;
  }

  /**
   * An anchor to a row page. Base class + hover title shared by the single-pk
   * cell link (value as its content) and the compound-key "#" link (pass the
   * `#` glyph as `text`). Same-tab navigation, matching the header/footer
   * links; `stopEvent` lets the browser handle the click (PM doesn't select).
   */
  private rowLink(href: string, text?: string): HTMLAnchorElement {
    const a = document.createElement("a");
    a.className = "pm-block-embed-rowlink";
    a.href = safeHref(href);
    a.title = "Open this row in Datasette";
    if (text != null) a.textContent = text; // text node
    return a;
  }

  /**
   * Append the shared block-embed footer: an "open in Datasette" link on the
   * left (matching the SQL block's footer layout) and the caller's info span on
   * the right.
   */
  private appendFooter(href: string, info: HTMLElement): void {
    const footer = document.createElement("div");
    footer.className = "pm-block-embed-footer";
    const link = document.createElement("a");
    link.className = "pm-block-embed-footer-link";
    link.href = href;
    link.textContent = "open in Datasette ↗";
    footer.appendChild(link);
    info.className = "pm-block-embed-footer-info";
    footer.appendChild(info);
    this.dom.appendChild(footer);
  }

  private renderRow(payload: Extract<EmbedPayload, { kind: "row" }>): void {
    this.dom.replaceChildren();
    // Title is the row's path identity: database/table/pk (e.g.
    // transcript/entries/2), falling back to database/label if incomplete.
    const title =
      payload.table && payload.pk
        ? `${payload.db}/${payload.table}/${payload.pk}`
        : `${payload.db}/${payload.label}`;
    this.dom.appendChild(this.header(iconMarkup("fileText"), title, payload.href));
    const dl = document.createElement("dl");
    dl.className = "pm-block-embed-fields";
    for (const field of payload.fields) {
      const dt = document.createElement("dt");
      dt.textContent = field.column; // text node
      const dd = document.createElement("dd");
      // @feat result-cells: row-card field values render clamped + expandable
      renderResultValue(dd, field.value); // text nodes only
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    this.dom.appendChild(dl);
    markOverflowingCells(dl);
  }

  private renderDatabase(
    payload: Extract<EmbedPayload, { kind: "database" }>,
  ): void {
    this.dom.replaceChildren();
    this.dom.appendChild(this.header(iconMarkup(kindIcon("database")), payload.db, payload.href));

    if (payload.tables.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pm-block-embed-placeholder";
      empty.textContent = "No tables";
      this.dom.appendChild(empty);
      return;
    }

    const list = document.createElement("ul");
    list.className = "pm-block-embed-tables";
    for (const t of payload.tables) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.className = "pm-block-embed-table-link";
      a.href = t.href;
      a.appendChild(this.svgIcon(kindIcon(t.kind)));
      const name = document.createElement("span");
      name.textContent = t.name; // text node
      a.appendChild(name);
      li.appendChild(a);
      if (t.count != null) {
        const count = document.createElement("span");
        count.className = "pm-block-embed-table-count";
        count.textContent = `${formatInt(t.count)} row${t.count === 1 ? "" : "s"}`;
        li.appendChild(count);
      }
      list.appendChild(li);
    }
    this.dom.appendChild(list);

    const info = document.createElement("span");
    const n = payload.tables.length;
    info.textContent = `${n} table${n === 1 ? "" : "s"}`;
    this.appendFooter(payload.href, info);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "block_embed") return false;
    this.node = node;
    const nextRef = node.attrs.ref ?? null;
    const nextMode = node.attrs.mode ?? "table";
    const nextConfig = (node.attrs.config as Record<string, unknown>) ?? {};
    const configChanged =
      JSON.stringify(nextConfig) !== JSON.stringify(this.config);
    if (nextRef !== this.ref || nextMode !== this.mode || configChanged) {
      this.ref = nextRef;
      this.mode = nextMode;
      this.config = nextConfig;
      void this.load();
    } else {
      // Editability may have flipped mid-session (view/edit toggle, forced
      // read-only on stepError) — re-gate the chrome without a re-fetch.
      this.regateEditable();
    }
    return true;
  }

  destroy(): void {
    this.editableObserver.disconnect();
    this.clearExportTimer();
    this.closeMenu();
    this.disposeExternal();
  }

  // We own the whole managed subtree — keep PM out of it, but let interactive
  // controls (refresh button, links, row-limit dropdown) handle their own
  // events. A click on a plain cell still falls through so PM selects the node.
  ignoreMutation(): boolean {
    return true;
  }
  stopEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return !!target && !!target.closest("a, button, select, input, label");
  }
}
