/**
 * NodeView for `datasette_embed`: a read-only, live-at-view-time render of a
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
import { TOOLBAR_ICONS } from "./icons";
import {
  cellText,
  fetchEmbed,
  kindIcon,
  type EmbedPayload,
  type ExternalEmbedPayload,
} from "./datasetteEmbed";
import { embedRegistry } from "./embedRegistry";

const ROW_LIMIT_OPTIONS = [10, 25, 100];
const DEFAULT_ROW_LIMIT = 10;
// Kinds rendered by the built-in dispatch; anything else is delegated to a
// registered external renderer (embedRegistry.ts).
const BUILTIN_KINDS = new Set(["table", "view", "row", "database"]);

export class DatasetteEmbedView implements NodeView {
  dom: HTMLDivElement;
  private view: EditorView;
  private getPos: () => number | undefined;
  private node: PMNode;
  private ref: string | null;
  private mode: string;
  // How many rows to fetch/show; user-adjustable via the footer dropdown.
  private limit = DEFAULT_ROW_LIMIT;
  // Bumped on each (re)fetch so a stale in-flight response is discarded.
  private token = 0;
  // The open overflow menu (if any) + its outside-click teardown.
  private menuEl: HTMLElement | null = null;
  // Cleanup returned by an external renderer's mount(), if any.
  private cleanupExternal: (() => void) | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.view = view;
    this.getPos = getPos;
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "pm-datasette-embed";
    this.ref = node.attrs.ref ?? null;
    this.mode = node.attrs.mode ?? "table";
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
    const payload = await fetchEmbed(this.ref, this.limit);
    // A newer load() (ref change / refresh) superseded this one.
    if (token !== this.token) return;
    this.render(payload);
  }

  private svgIcon(name: string): HTMLSpanElement {
    const span = document.createElement("span");
    span.className = "pm-datasette-embed-icon";
    span.setAttribute("aria-hidden", "true");
    span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">${TOOLBAR_ICONS[name as keyof typeof TOOLBAR_ICONS] ?? ""}</svg>`;
    return span;
  }

  /**
   * Header chrome: kind icon + db/label + a refresh control. The label is a
   * link to the resource's Datasette page when `href` is known (so the title
   * is clickable, per design); the "open in Datasette" link lives in the footer.
   */
  private header(iconName: string, label: string, href?: string): HTMLElement {
    const head = document.createElement("div");
    head.className = "pm-datasette-embed-head";
    head.appendChild(this.svgIcon(iconName));

    let labelEl: HTMLElement;
    if (href) {
      const a = document.createElement("a");
      a.className = "pm-datasette-embed-label pm-datasette-embed-label--link";
      a.href = href;
      labelEl = a;
    } else {
      labelEl = document.createElement("span");
      labelEl.className = "pm-datasette-embed-label";
    }
    labelEl.textContent = label; // text node — never innerHTML
    head.appendChild(labelEl);

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "pm-datasette-embed-refresh";
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
   * The "⋮" overflow menu. Currently a single action — convert this block
   * embed into the inline `datasette_ref` pill (block → inline). The menu is
   * positioned within the embed (which is tall enough not to clip it) and
   * closes on outside click.
   */
  private overflowMenu(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "pm-datasette-embed-menu-wrap";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pm-datasette-embed-menu-btn";
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
    menu.className = "pm-datasette-embed-menu";

    const convert = document.createElement("button");
    convert.type = "button";
    convert.className = "pm-datasette-embed-menu-item";
    convert.textContent = "Convert to inline element";
    convert.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.closeMenu();
      this.convertToInline();
    });
    menu.appendChild(convert);
    wrap.appendChild(menu);
    return wrap;
  }

  private toggleMenu(menu: HTMLElement): void {
    if (this.menuEl === menu) {
      this.closeMenu();
      return;
    }
    this.closeMenu();
    // Visibility is a class (not the `hidden` attr) so an author `display`
    // rule can't leave it stuck visible — see the matching CSS.
    menu.classList.add("pm-datasette-embed-menu--open");
    this.menuEl = menu;
    // Capture-phase so a click anywhere else closes before it does anything.
    document.addEventListener("mousedown", this.onOutsideClick, true);
    document.addEventListener("keydown", this.onKeydown, true);
  }

  private closeMenu(): void {
    if (!this.menuEl) return;
    this.menuEl.classList.remove("pm-datasette-embed-menu--open");
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
   * `datasette_ref` pill for the same ref — an easy block → inline downgrade.
   */
  private convertToInline(): void {
    const pos = this.getPos();
    if (pos == null) return;
    const { state, dispatch } = this.view;
    const refNode = state.schema.nodes.datasette_ref.create({ ref: this.ref });
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
    select.className = "pm-datasette-embed-rows";
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
      "pm-datasette-embed--denied",
      "pm-datasette-embed--missing",
    );
    const skel = document.createElement("div");
    skel.className = "pm-datasette-embed-skeleton";
    skel.textContent = "Loading…";
    this.dom.appendChild(skel);
  }

  private renderPlaceholder(modifier: string, text: string): void {
    this.dom.replaceChildren();
    this.dom.classList.add(modifier);
    const el = document.createElement("div");
    el.className = "pm-datasette-embed-placeholder";
    el.textContent = text; // generic — never the resource's label or data
    this.dom.appendChild(el);
  }

  private render(payload: EmbedPayload): void {
    this.dom.classList.remove(
      "pm-datasette-embed--denied",
      "pm-datasette-embed--missing",
    );
    if (payload.status === "denied") {
      this.renderPlaceholder(
        "pm-datasette-embed--denied",
        "You don't have access to this data",
      );
      return;
    }
    if (payload.status === "not_found") {
      this.renderPlaceholder("pm-datasette-embed--missing", "Resource not found");
      return;
    }
    if (payload.kind === "row") {
      this.renderRow(payload as Extract<EmbedPayload, { kind: "row" }>);
    } else if (payload.kind === "database") {
      this.renderDatabase(payload as Extract<EmbedPayload, { kind: "database" }>);
    } else if (!BUILTIN_KINDS.has(payload.kind)) {
      this.renderExternal(payload as ExternalEmbedPayload);
    } else {
      this.renderTable(payload as Extract<EmbedPayload, { kind: "table" | "view" }>);
    }
  }

  /**
   * Render a third-party provider's embed by delegating to the renderer it
   * registered via `window.datasettePaperEmbeds` (the JS API). We own the
   * header (icon + label link + refresh + ⋮ menu); the renderer fills a host
   * div and fetches its own data. If no renderer is registered (the plugin's
   * bundle didn't load), fall back to a link.
   */
  private renderExternal(payload: ExternalEmbedPayload): void {
    this.dom.replaceChildren();
    this.dom.appendChild(
      this.header(payload.icon || kindIcon(payload.kind), payload.label, payload.href),
    );
    const host = document.createElement("div");
    host.className = "pm-datasette-embed-external";
    this.dom.appendChild(host);

    const renderer = embedRegistry().get(payload.kind);
    if (renderer) {
      try {
        const cleanup = renderer.mount(host, {
          ref: this.ref ?? "",
          payload: payload as unknown as Record<string, unknown>,
          mode: this.mode,
        });
        this.cleanupExternal = typeof cleanup === "function" ? cleanup : null;
      } catch {
        host.replaceChildren();
        const err = document.createElement("div");
        err.className = "pm-datasette-embed-placeholder";
        err.textContent = "This embed failed to render";
        host.appendChild(err);
      }
      return;
    }
    // No renderer registered for this kind — offer a link out.
    const fallback = document.createElement("div");
    fallback.className = "pm-datasette-embed-placeholder";
    const link = document.createElement("a");
    link.className = "pm-datasette-embed-footer-link";
    link.href = payload.href;
    link.textContent = `Open ${payload.label} ↗`;
    fallback.appendChild(link);
    host.appendChild(fallback);
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

  private renderTable(
    payload: Extract<EmbedPayload, { kind: "table" | "view" }>,
  ): void {
    this.dom.replaceChildren();
    this.dom.appendChild(
      this.header(kindIcon(payload.kind), `${payload.db}/${payload.label}`, payload.href),
    );

    const scroll = document.createElement("div");
    scroll.className = "pm-datasette-embed-scroll";
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
    footer.className = "pm-datasette-embed-footer";

    // "showing [25] of 1,234 rows" — the count number is the limit dropdown.
    const info = document.createElement("span");
    info.className = "pm-datasette-embed-footer-info";
    info.append("showing ", this.rowLimitSelect());
    if (payload.count != null) {
      info.append(` of ${payload.count} row${payload.count === 1 ? "" : "s"}`);
    } else {
      info.append(" rows");
    }
    footer.appendChild(info);

    const link = document.createElement("a");
    link.className = "pm-datasette-embed-footer-link";
    link.href = payload.href;
    link.textContent = "open in Datasette ↗";
    footer.appendChild(link);
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
    this.dom.appendChild(this.header("fileText", title, payload.href));
    const dl = document.createElement("dl");
    dl.className = "pm-datasette-embed-fields";
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
    this.dom.appendChild(this.header(kindIcon("database"), payload.db, payload.href));

    if (payload.tables.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pm-datasette-embed-placeholder";
      empty.textContent = "No tables";
      this.dom.appendChild(empty);
      return;
    }

    const list = document.createElement("ul");
    list.className = "pm-datasette-embed-tables";
    for (const t of payload.tables) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.className = "pm-datasette-embed-table-link";
      a.href = t.href;
      a.appendChild(this.svgIcon(kindIcon(t.kind)));
      const name = document.createElement("span");
      name.textContent = t.name; // text node
      a.appendChild(name);
      li.appendChild(a);
      if (t.count != null) {
        const count = document.createElement("span");
        count.className = "pm-datasette-embed-table-count";
        count.textContent = `${t.count} row${t.count === 1 ? "" : "s"}`;
        li.appendChild(count);
      }
      list.appendChild(li);
    }
    this.dom.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "pm-datasette-embed-footer";
    const info = document.createElement("span");
    info.className = "pm-datasette-embed-footer-info";
    const n = payload.tables.length;
    info.textContent = `${n} table${n === 1 ? "" : "s"}`;
    footer.appendChild(info);
    const link = document.createElement("a");
    link.className = "pm-datasette-embed-footer-link";
    link.href = payload.href;
    link.textContent = "open in Datasette ↗";
    footer.appendChild(link);
    this.dom.appendChild(footer);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "datasette_embed") return false;
    this.node = node;
    const nextRef = node.attrs.ref ?? null;
    const nextMode = node.attrs.mode ?? "table";
    if (nextRef !== this.ref || nextMode !== this.mode) {
      this.ref = nextRef;
      this.mode = nextMode;
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
    return !!target && !!target.closest("a, button, select");
  }
}
