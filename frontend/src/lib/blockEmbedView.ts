/**
 * NodeView for `block_embed`: a read-only, live-at-view-time render of a
 * Datasette table/view (capped rows), a single row's fields, or a database's
 * table listing. Unlike the inline pill there is no shared batching resolver —
 * one `GET …/datasette/embed` fetch per mount, re-fetched when `ref`/`mode`
 * changes or the user clicks the refresh control (the data is a snapshot at
 * view time, not collaborative).
 *
 * Render states: loading skeleton → table / row card / database listing /
 * denied / not_found. An overflow ("⋮") menu offers block → inline conversion.
 *
 * XSS rule (load-bearing): every cell value, column name, and label is
 * user/data-derived and goes into the DOM as a TEXT NODE only — never
 * innerHTML. Only the trusted constant icon SVGs use innerHTML.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView } from "prosemirror-view";
import {
  cellText,
  embedIconMarkup,
  fetchEmbed,
  iconMarkup,
  kindIcon,
  refSegments,
  safeHref,
  type EmbedPayload,
} from "./datasetteEmbed";
import { rowsToCsv, rowsToJson } from "./tableExport";
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
  // Cleanup returned by a third-party provider's mount(), if any.
  private cleanupExternal: (() => void) | null = null;
  // The last table/view payload rendered, if any — drives the export items
  // (Copy page serializes its held rows; Download links target its db/table).
  // Cleared on any non-table render so the menu can't export stale data.
  private tablePayload: Extract<EmbedPayload, { kind: "table" | "view" }> | null = null;
  // The full (pre-projection) column set of the last table/view render — seeds
  // the "Columns…" picker so it can offer every column, selected ones checked.
  private allColumns: string[] = [];
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
    // render with filters configured. Informational, so read-only viewers see
    // it too — only the panel that *edits* the filters is gated on editable.
    if (this.tablePayload) {
      const filterCount = this.filters().length;
      if (filterCount > 0) {
        const badge = document.createElement("span");
        badge.className = "pm-block-embed-filter-badge";
        badge.title = `${filterCount} filter${filterCount === 1 ? "" : "s"} applied`;
        badge.appendChild(this.svgIcon("funnelFill"));
        badge.appendChild(document.createTextNode(String(filterCount)));
        head.appendChild(badge);
      }
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
   * The "⋮" overflow menu. Always offers "Convert to inline element" (block →
   * inline downgrade). For a table/view it also offers result-export items:
   *
   *  - **Download CSV / JSON** — links to Datasette's *native* streaming
   *    endpoints (`.csv?_stream=on`, `.json?_shape=array`), which export the
   *    *entire* table/view server-side, bypassing the embed's `_size` page cap
   *    (and the SQL block's `max_returned_rows` cap). `.csv?_stream=on` is
   *    gated by the `allow_csv_stream` setting (default on).
   *  - **Copy page** — copies only the rows currently held client-side (one
   *    `_size` page). Labelled with the page row count and "(page)" whenever
   *    `count` exceeds the held rows, so a partial copy is never mistaken for
   *    the whole table.
   *
   * The menu is positioned within the embed (tall enough not to clip it) and
   * closes on outside click.
   *
   * Items that dispatch a transaction (Columns…, Convert to inline element)
   * render only when `view.editable` — the live EditorView prop, same gate as
   * tagView/linkOpen. Read-only viewers keep the navigate/copy items (and the
   * refresh button in the header); returns null when no item is available so
   * the header can skip the button entirely.
   */
  private overflowMenu(): HTMLElement | null {
    const canEdit = !!this.view.editable;
    const wrap = document.createElement("div");
    wrap.className = "pm-block-embed-menu-wrap";

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

    const menu = document.createElement("div");
    menu.className = "pm-block-embed-menu";

    const payload = this.tablePayload;
    if (payload) {
      // Native full-dataset download links — server-side, not the held page.
      menu.appendChild(
        this.menuLink("Download CSV (all rows)", this.exportUrl(payload, "csv")),
      );
      menu.appendChild(
        this.menuLink("Download JSON (all rows)", this.exportUrl(payload, "json")),
      );
      // Client-side copy of the held page — honestly labelled when partial.
      const partial = payload.count != null && payload.count > payload.rows.length;
      const suffix = partial
        ? ` (page, ${payload.rows.length} of ${payload.count})`
        : ` (${payload.rows.length} row${payload.rows.length === 1 ? "" : "s"})`;
      menu.appendChild(
        this.menuButton(`Copy as CSV${suffix}`, () => this.copyPage(payload, "csv")),
      );
      menu.appendChild(
        this.menuButton(`Copy as JSON${suffix}`, () => this.copyPage(payload, "json")),
      );
      // Column picker — config-writing, editors only; and only meaningful
      // once we know the table's columns.
      if (canEdit && this.allColumns.length) {
        const cols = document.createElement("button");
        cols.type = "button";
        cols.className = "pm-block-embed-menu-item";
        cols.textContent = "Columns…";
        // Unlike menuButton, this swaps the menu body for the checklist in
        // place rather than closing — Apply (or outside click) closes it.
        cols.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.showColumnsPanel(menu);
        });
        menu.appendChild(cols);

        // Filter & sort form — config-writing, same gate as Columns….
        const filters = document.createElement("button");
        filters.type = "button";
        filters.className = "pm-block-embed-menu-item";
        filters.textContent = "Filter & sort…";
        // Like Columns…, this swaps the menu body for the form in place —
        // Apply/Cancel (or outside click) closes it.
        filters.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.showFiltersPanel(menu);
        });
        menu.appendChild(filters);
      }
    }

    // Converting rewrites the document — an edit, gated like config writes.
    if (canEdit) {
      menu.appendChild(
        this.menuButton("Convert to inline element", () => this.convertToInline()),
      );
    }
    if (!menu.childElementCount) return null;
    wrap.appendChild(menu);
    return wrap;
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
   * "Apply" writes the ordered selection to `config.columns` and closes.
   */
  private showColumnsPanel(menu: HTMLElement): void {
    if (!this.view.editable) return; // belt-and-braces: viewers never write config
    menu.replaceChildren();
    const panel = document.createElement("div");
    panel.className = "pm-block-embed-columns";

    const selected = new Set(this.selectedColumns() ?? this.allColumns);
    const inputs: { col: string; input: HTMLInputElement }[] = [];
    for (const col of this.allColumns) {
      const label = document.createElement("label");
      label.className = "pm-block-embed-columns-item";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selected.has(col);
      const text = document.createElement("span");
      text.textContent = col; // text node — column names are data-derived
      label.appendChild(input);
      label.appendChild(text);
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
    // ">1 visible" cog condition).
    const visible = this.selectedColumns() ?? this.allColumns;
    const remaining = visible.filter((c) => c !== col);
    if (remaining.length) {
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

  /** A menu item that's a download link (native streaming export endpoint). */
  private menuLink(label: string, href: string): HTMLAnchorElement {
    const a = document.createElement("a");
    a.className = "pm-block-embed-menu-item";
    a.href = href;
    a.textContent = label;
    // A bare GET to a same-origin .csv/.json — no new tab needed; the browser
    // downloads (.csv) or shows (.json) it. Close the menu on activation.
    a.addEventListener("click", () => this.closeMenu());
    return a;
  }

  /**
   * The native Datasette streaming-export URL for a table/view payload.
   * `.csv?_stream=on` streams every row (bypasses row caps); `.json?_shape=array`
   * gives a bare JSON array (paginated — the user follows `next` for the rest).
   * Built from the ref segments so it can't be poisoned by a crafted `href`.
   */
  private exportUrl(
    payload: Extract<EmbedPayload, { kind: "table" | "view" }>,
    format: "csv" | "json",
  ): string {
    const path = "/" + refSegments(payload.href).map(encodeURIComponent).join("/");
    return format === "csv" ? `${path}.csv?_stream=on` : `${path}.json?_shape=array`;
  }

  /** Copy the held page (one `_size` fetch) to the clipboard as CSV/JSON. */
  private copyPage(
    payload: Extract<EmbedPayload, { kind: "table" | "view" }>,
    format: "csv" | "json",
  ): void {
    const text =
      format === "csv"
        ? rowsToCsv(payload.columns, payload.rows)
        : rowsToJson(payload.columns, payload.rows);
    void navigator.clipboard?.writeText(text);
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

  private renderTable(
    payload: Extract<EmbedPayload, { kind: "table" | "view" }>,
  ): void {
    // Set before header() so overflowMenu() can offer the export items and the
    // column picker (allColumns = the full set, before config.columns subsets).
    this.tablePayload = payload;
    this.allColumns = payload.allColumns;
    this.dom.replaceChildren();
    this.dom.appendChild(
      this.header(
        iconMarkup(kindIcon(payload.kind)),
        `${payload.db}/${payload.label}`,
        this.tablePageHref(payload.href),
      ),
    );

    // Summary line: "<count> rows where … sorted by …" — Datasette phrases
    // the description (`human_description_en`), we render it as text nodes
    // only. Visible to everyone (it's how read-only viewers learn the embed
    // is a filtered slice); omitted entirely when the description is empty
    // (unfiltered/unsorted) or absent (older Datasette without the extra).
    if (payload.humanDescription) {
      const summary = document.createElement("div");
      summary.className = "pm-block-embed-summary";
      const prefix =
        payload.count != null
          ? `${payload.count} row${payload.count === 1 ? "" : "s"} `
          : "";
      // One text node — the description is data-derived, never innerHTML.
      summary.textContent = `${prefix}${payload.humanDescription}`;
      this.dom.appendChild(summary);
    }

    const scroll = document.createElement("div");
    scroll.className = "pm-block-embed-scroll";
    const table = document.createElement("table");

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    const sort = this.sort();
    for (const col of payload.columns) {
      const th = document.createElement("th");
      th.appendChild(document.createTextNode(col)); // text node
      // Passive sort indicator on the sorted column — rendered for EVERYONE
      // (viewers included); only the config-writing menu below is gated.
      if (sort?.column === col) {
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
      for (const cell of row) {
        const td = document.createElement("td");
        td.textContent = cellText(cell); // text node
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    this.dom.appendChild(scroll);

    // Right (margin-left:auto on the info span pushes it over): "showing [25]
    // of 1,234 rows" — the count number is the limit dropdown.
    const info = document.createElement("span");
    info.append("showing ", this.rowLimitSelect());
    if (payload.count != null) {
      info.append(` of ${payload.count} row${payload.count === 1 ? "" : "s"}`);
    } else {
      info.append(" rows");
    }
    this.appendFooter(payload.href, info);
  }

  /**
   * The header title-link URL for a table/view: Datasette's own table page
   * with the embed's filters, sort, and column subset already applied, so
   * clicking through shows exactly what the embed shows. Path rebuilt from
   * the ref segments so it can't be poisoned (the exportUrl trick); the
   * shareable params — `col__op=value` pairs, `_sort`/`_sort_desc`, one
   * `_col` per selected column — go through URLSearchParams so crafted
   * values can't break out of the query string. Fetch-only params
   * (`_shape`/`_extra`/`_size`) are never carried: the page picks its own.
   */
  private tablePageHref(href: string): string {
    const path = "/" + refSegments(href).map(encodeURIComponent).join("/");
    const params = new URLSearchParams(filterQueryParams(this.filters(), this.sort()));
    for (const col of this.selectedColumns() ?? []) params.append("_col", col);
    const query = params.toString();
    return query ? `${path}?${query}` : path;
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
      dd.textContent = cellText(field.value); // text node
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    this.dom.appendChild(dl);
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
        count.textContent = `${t.count} row${t.count === 1 ? "" : "s"}`;
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
