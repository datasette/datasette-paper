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
import { embedRegistry, type PaperEmbedProvider } from "./embedRegistry";
import { ensureProviderForRef, manifestKindForRef } from "./embedProviders";
import type { DatasetteStatus } from "./datasetteResolver";

const ROW_LIMIT_OPTIONS = [10, 25, 100];
const DEFAULT_ROW_LIMIT = 10;

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

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.view = view;
    this.getPos = getPos;
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "pm-block-embed";
    this.ref = node.attrs.ref ?? null;
    this.mode = node.attrs.mode ?? "table";
    this.config = (node.attrs.config as Record<string, unknown>) ?? {};
    void this.load();
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
    const payload = await fetchEmbed(this.ref, this.limit, this.selectedColumns());
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
    head.appendChild(this.overflowMenu());

    return head;
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
   */
  private overflowMenu(): HTMLElement {
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
      // Column picker — only meaningful once we know the table's columns.
      if (this.allColumns.length) {
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
      }
    }

    menu.appendChild(
      this.menuButton("Convert to inline element", () => this.convertToInline()),
    );
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
   * Swap the open ⋮ menu's body for an inline checklist of `allColumns`, each
   * checked iff currently selected (all checked when no selection = "show all").
   * "Apply" writes the ordered selection to `config.columns` and closes.
   */
  private showColumnsPanel(menu: HTMLElement): void {
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

  /** Merge `columns` into the node's `config` attr; update() then re-fetches. */
  private setColumns(columns: string[]): void {
    const pos = this.getPos();
    if (pos == null) return;
    const { state, dispatch } = this.view;
    const config = { ...(this.node.attrs.config ?? {}), columns };
    dispatch(state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, config }));
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
    this.dom.classList.remove(
      "pm-block-embed--denied",
      "pm-block-embed--missing",
    );
    const skel = document.createElement("div");
    skel.className = "pm-block-embed-skeleton";
    skel.textContent = "Loading…";
    this.dom.appendChild(skel);
  }

  private renderPlaceholder(modifier: string, text: string): void {
    this.dom.replaceChildren();
    this.dom.classList.add(modifier);
    const el = document.createElement("div");
    el.className = "pm-block-embed-placeholder";
    el.textContent = text; // generic — never the resource's label or data
    this.dom.appendChild(el);
  }

  private render(payload: EmbedPayload): void {
    // Default to "no exportable table" — renderTable re-sets it below.
    this.tablePayload = null;
    this.dom.classList.remove(
      "pm-block-embed--denied",
      "pm-block-embed--missing",
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
      this.header(iconMarkup(kindIcon(payload.kind)), `${payload.db}/${payload.label}`, payload.href),
    );

    const scroll = document.createElement("div");
    scroll.className = "pm-block-embed-scroll";
    const table = document.createElement("table");

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (const col of payload.columns) {
      const th = document.createElement("th");
      th.textContent = col; // text node
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

    const footer = document.createElement("div");
    footer.className = "pm-block-embed-footer";

    // Left: "open in Datasette" (matches the SQL block's footer layout).
    const link = document.createElement("a");
    link.className = "pm-block-embed-footer-link";
    link.href = payload.href;
    link.textContent = "open in Datasette ↗";
    footer.appendChild(link);

    // Right (margin-left:auto on the info span pushes it over): "showing [25]
    // of 1,234 rows" — the count number is the limit dropdown.
    const info = document.createElement("span");
    info.className = "pm-block-embed-footer-info";
    info.append("showing ", this.rowLimitSelect());
    if (payload.count != null) {
      info.append(` of ${payload.count} row${payload.count === 1 ? "" : "s"}`);
    } else {
      info.append(" rows");
    }
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

    const footer = document.createElement("div");
    footer.className = "pm-block-embed-footer";
    // Link left, count right — same layout as the table footer.
    const link = document.createElement("a");
    link.className = "pm-block-embed-footer-link";
    link.href = payload.href;
    link.textContent = "open in Datasette ↗";
    footer.appendChild(link);
    const info = document.createElement("span");
    info.className = "pm-block-embed-footer-info";
    const n = payload.tables.length;
    info.textContent = `${n} table${n === 1 ? "" : "s"}`;
    footer.appendChild(info);
    this.dom.appendChild(footer);
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
    }
    return true;
  }

  destroy(): void {
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
