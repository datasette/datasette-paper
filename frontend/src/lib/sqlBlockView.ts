/**
 * NodeView for `sql_block`: an editable SQL query run against a named
 * Datasette database, with the results rendered as a table inline.
 *
 * Unlike `block_embed` (an atom holding only a ref), the query is editable
 * text content — it lives in a `contentDOM` and collaborates via the step log
 * like any paragraph. The chrome around it (db `<select>`, Run button,
 * Show/Hide-SQL toggle, results table) is non-editable and lives in `dom`
 * outside `contentDOM`; `ignoreMutation`/`stopEvent` keep ProseMirror out of
 * it (the contentDOM-NodeView pattern from taskItemView.ts).
 *
 * Results are fetched per-viewer (runSqlQuery → /{db}/-/query.json) and never
 * persisted — auto-run on mount and on Run. `db` + `hidden` are node attrs
 * (so they collaborate); the SQL is content.
 *
 * XSS rule (load-bearing, from blockEmbedView.ts): every db/column/cell/error
 * string goes into the DOM as a TEXT NODE only — never innerHTML. Only the
 * trusted constant icon SVGs use innerHTML.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";
import { cellText, iconMarkup } from "./datasetteEmbed";
import {
  listQueryableDatabases,
  queryHref,
  rowsToCsv,
  rowsToJson,
  runSqlQuery,
  type SqlResult,
} from "./sqlQuery";

const PAGE_SIZE_OPTIONS = [10, 25, 100];
const DEFAULT_PAGE_SIZE = 10;

export class SqlBlockView implements NodeView {
  dom: HTMLDivElement;
  contentDOM: HTMLElement;
  private view: EditorView;
  private getPos: () => number | undefined;
  private node: PMNode;
  private codeWrap: HTMLPreElement;
  private resultsEl: HTMLDivElement;
  // Assigned in buildHeader(), called synchronously from the constructor.
  private dbSelect!: HTMLSelectElement;
  private toggleBtn!: HTMLButtonElement;
  private runBtn!: HTMLButtonElement;
  // The SQL text that produced the current results. When it differs from the
  // live content the results are stale and the Run button lights up.
  private ranSql: string | null = null;
  // Bumped on each (re)run so a stale in-flight response is discarded.
  private token = 0;
  // Last successful result + client-side pagination state (rows are fetched
  // once; paging/page-size changes re-render without re-querying).
  private lastResult: SqlResult | null = null;
  private pageSize = DEFAULT_PAGE_SIZE;
  private page = 0;
  // The open export menu (if any) + its outside-click teardown.
  private menuEl: HTMLElement | null = null;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.view = view;
    this.getPos = getPos;
    this.node = node;

    this.dom = document.createElement("div");
    this.dom.className = "pm-sql-block";

    this.dom.appendChild(this.buildHeader());

    this.codeWrap = document.createElement("pre");
    this.codeWrap.className = "pm-sql-block-code";
    this.contentDOM = document.createElement("code");
    this.codeWrap.appendChild(this.contentDOM);
    this.dom.appendChild(this.codeWrap);

    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "pm-sql-block-results";
    this.dom.appendChild(this.resultsEl);

    this.applyHidden();
    void this.populateDatabases();
    void this.run();
  }

  // ── Header chrome ──────────────────────────────────────────────────────────

  private buildHeader(): HTMLElement {
    const head = document.createElement("div");
    head.className = "pm-sql-block-head";

    const icon = document.createElement("span");
    icon.className = "pm-sql-block-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = iconMarkup("database"); // trusted constant SVG
    head.appendChild(icon);

    this.dbSelect = document.createElement("select");
    this.dbSelect.className = "pm-sql-block-db";
    this.dbSelect.title = "Database";
    this.syncDbOptions([]); // placeholder until populateDatabases() resolves
    this.dbSelect.addEventListener("change", () => {
      this.setAttr("db", this.dbSelect.value || null);
      void this.run();
    });
    head.appendChild(this.dbSelect);

    const spacer = document.createElement("span");
    spacer.className = "pm-sql-block-spacer";
    head.appendChild(spacer);

    this.toggleBtn = document.createElement("button");
    this.toggleBtn.type = "button";
    this.toggleBtn.className = "pm-sql-block-toggle";
    this.toggleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      this.setAttr("hidden", !this.node.attrs.hidden);
    });
    head.appendChild(this.toggleBtn);
    this.refreshToggleLabel();

    this.runBtn = document.createElement("button");
    this.runBtn.type = "button";
    this.runBtn.className = "pm-sql-block-run";
    this.runBtn.appendChild(this.svgIcon("play"));
    this.runBtn.append("Run");
    this.runBtn.addEventListener("click", (e) => {
      e.preventDefault();
      void this.run();
    });
    head.appendChild(this.runBtn);
    this.refreshRunState();

    head.appendChild(this.exportMenu());

    return head;
  }

  /**
   * The "⋮" overflow menu — export the results (copy as CSV/JSON, download a
   * .csv). Kept out of the always-visible chrome so the header stays quiet.
   * Exports run client-side off the rows already fetched; if the result was
   * truncated, the footer warning makes the incompleteness obvious.
   */
  private exportMenu(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "pm-sql-block-menu-wrap";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pm-sql-block-menu-btn";
    btn.title = "Export results";
    btn.setAttribute("aria-label", "Export results");
    btn.appendChild(this.svgIcon("threeDotsVertical"));
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleMenu(menu);
    });
    wrap.appendChild(btn);

    const menu = document.createElement("div");
    menu.className = "pm-sql-block-menu";

    const item = (label: string, run: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pm-sql-block-menu-item";
      b.textContent = label;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.closeMenu();
        run();
      });
      return b;
    };

    menu.appendChild(item("Copy as CSV", () => this.copyResults("csv")));
    menu.appendChild(item("Copy as JSON", () => this.copyResults("json")));
    menu.appendChild(item("Download CSV", () => this.downloadCsv()));
    wrap.appendChild(menu);
    return wrap;
  }

  private toggleMenu(menu: HTMLElement): void {
    if (this.menuEl === menu) {
      this.closeMenu();
      return;
    }
    this.closeMenu();
    menu.classList.add("pm-sql-block-menu--open");
    this.menuEl = menu;
    document.addEventListener("mousedown", this.onOutsideClick, true);
    document.addEventListener("keydown", this.onKeydown, true);
  }

  private closeMenu(): void {
    if (!this.menuEl) return;
    this.menuEl.classList.remove("pm-sql-block-menu--open");
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

  // ── Export ─────────────────────────────────────────────────────────────────

  /** Serialize the last result; null when there are no rows to export. */
  private serialize(format: "csv" | "json"): string | null {
    const r = this.lastResult;
    if (!r || r.status !== "ok" || !(r.rows && r.rows.length)) return null;
    const cols = r.columns ?? [];
    return format === "csv" ? rowsToCsv(cols, r.rows) : rowsToJson(cols, r.rows);
  }

  private copyResults(format: "csv" | "json"): void {
    const text = this.serialize(format);
    if (text == null) return;
    void navigator.clipboard?.writeText(text);
  }

  private downloadCsv(): void {
    const text = this.serialize("csv");
    if (text == null) return;
    const db = (this.node.attrs.db as string | null) ?? "query";
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${db}-query.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private svgIcon(name: string): HTMLSpanElement {
    const span = document.createElement("span");
    span.className = "pm-sql-block-btn-icon";
    span.setAttribute("aria-hidden", "true");
    span.innerHTML = iconMarkup(name);
    return span;
  }

  private async populateDatabases(): Promise<void> {
    const dbs = await listQueryableDatabases();
    this.syncDbOptions(dbs);
    // Default to the first database if none chosen yet, and re-run.
    if (!this.node.attrs.db && dbs.length) {
      this.setAttr("db", dbs[0]);
      void this.run();
    }
  }

  private syncDbOptions(dbs: string[]): void {
    const current = (this.node.attrs.db as string | null) ?? "";
    this.dbSelect.replaceChildren();
    const names = new Set(dbs);
    // Always include the current db even if listing failed/excluded it.
    if (current) names.add(current);
    if (names.size === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "no databases";
      opt.disabled = true;
      opt.selected = true;
      this.dbSelect.appendChild(opt);
      this.dbSelect.disabled = true;
      return;
    }
    this.dbSelect.disabled = false;
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name; // text node
      if (name === current) opt.selected = true;
      this.dbSelect.appendChild(opt);
    }
  }

  private refreshToggleLabel(): void {
    this.toggleBtn.textContent = this.node.attrs.hidden ? "▸ Show SQL" : "Hide SQL";
  }

  // ── Attr mutation (collaborates via the step log) ──────────────────────────

  private setAttr(key: "db" | "hidden", value: string | boolean | null): void {
    const pos = this.getPos();
    if (pos == null) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        [key]: value,
      }),
    );
  }

  private applyHidden(): void {
    this.dom.classList.toggle("is-hidden", !!this.node.attrs.hidden);
  }

  // ── Query run + results ────────────────────────────────────────────────────

  private async run(): Promise<void> {
    const token = ++this.token;
    const db = (this.node.attrs.db as string | null) ?? "";
    const sql = this.node.textContent;
    this.renderLoading();
    const result = await runSqlQuery(db, sql);
    if (token !== this.token) return; // superseded by a newer run / destroy
    this.lastResult = result;
    this.ranSql = sql; // results now reflect this SQL → Run goes quiet
    this.page = 0; // a fresh result starts at the first page
    this.renderResults(result);
    this.refreshRunState();
  }

  /**
   * The Run button is muted when the displayed results match the current SQL,
   * and lights up (bold purple) the moment the query is edited — a cue that the
   * results are stale and need re-running.
   */
  private refreshRunState(): void {
    const stale = this.node.textContent !== this.ranSql;
    this.runBtn.classList.toggle("pm-sql-block-run--stale", stale);
  }

  private renderLoading(): void {
    this.resultsEl.replaceChildren();
    const el = document.createElement("div");
    el.className = "pm-sql-block-status";
    el.textContent = "Running…";
    this.resultsEl.appendChild(el);
  }

  private renderStatus(text: string, modifier?: string): void {
    this.resultsEl.replaceChildren();
    const el = document.createElement("div");
    el.className = "pm-sql-block-status" + (modifier ? ` ${modifier}` : "");
    el.textContent = text; // generic / safe text — never the resource data on denied
    this.resultsEl.appendChild(el);
  }

  private renderResults(result: SqlResult): void {
    switch (result.status) {
      case "empty":
        this.renderStatus("Write a query and press Run");
        return;
      case "denied":
        this.renderStatus(
          "You don't have permission to run queries on this database",
          "pm-sql-block-denied",
        );
        return;
      case "error":
        this.renderStatus(result.error || "Query failed", "pm-sql-block-error");
        return;
      case "ok":
        this.renderTable(result);
        return;
    }
  }

  private renderTable(result: SqlResult): void {
    const columns = result.columns ?? [];
    const rows = result.rows ?? [];
    this.resultsEl.replaceChildren();

    if (rows.length === 0) {
      this.renderStatus("No rows");
      return;
    }

    // Clamp the page in case the page size grew past the last page.
    const pageCount = Math.max(1, Math.ceil(rows.length / this.pageSize));
    if (this.page > pageCount - 1) this.page = pageCount - 1;
    const start = this.page * this.pageSize;
    const pageRows = rows.slice(start, start + this.pageSize);

    const scroll = document.createElement("div");
    scroll.className = "pm-sql-block-scroll";
    const table = document.createElement("table");

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (const col of columns) {
      const th = document.createElement("th");
      th.textContent = col; // text node
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of pageRows) {
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
    this.resultsEl.appendChild(scroll);

    this.resultsEl.appendChild(this.buildFooter(rows.length, start, pageRows.length));
  }

  /**
   * Footer: "open in Datasette" on the left; on the right a "showing N rows"
   * range (with the page-size <select>) and the prev/next pager pinned to the
   * far edge. A truncation warning appears when Datasette capped the result at
   * `max_returned_rows` — so a copy/export of an incomplete set is obvious.
   * Paging + page-size changes re-render from `lastResult` (no re-query).
   */
  private buildFooter(total: number, start: number, shown: number): HTMLElement {
    const footer = document.createElement("div");
    footer.className = "pm-sql-block-footer";

    // Left: open in Datasette.
    const link = document.createElement("a");
    link.className = "pm-sql-block-footer-link";
    link.href = queryHref((this.node.attrs.db as string | null) ?? "", this.node.textContent);
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "open in Datasette ↗";
    footer.appendChild(link);

    // Truncation warning — the JSON API returned only the first N rows.
    if (this.lastResult?.truncated) {
      const warn = document.createElement("span");
      warn.className = "pm-sql-block-warn";
      warn.title =
        "Datasette returned only the first rows (max_returned_rows); " +
        "results and exports are incomplete.";
      warn.textContent = "⚠ truncated";
      footer.appendChild(warn);
    }

    // Right: "showing [10] · 1–10 of N rows" (margin-left:auto pushes it over).
    const info = document.createElement("span");
    info.className = "pm-sql-block-footer-info";
    info.append("showing ", this.pageSizeSelect());
    const from = total === 0 ? 0 : start + 1;
    info.append(` · ${from}–${start + shown} of ${total} row${total === 1 ? "" : "s"}`);
    footer.appendChild(info);

    // Far right: the pager.
    const pageCount = Math.max(1, Math.ceil(total / this.pageSize));
    if (pageCount > 1) footer.appendChild(this.pager(pageCount));

    return footer;
  }

  private pageSizeSelect(): HTMLSelectElement {
    const select = document.createElement("select");
    select.className = "pm-sql-block-rows";
    for (const n of PAGE_SIZE_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = String(n);
      if (n === this.pageSize) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      const next = Number(select.value);
      if (next === this.pageSize) return;
      this.pageSize = next;
      this.page = 0;
      if (this.lastResult) this.renderResults(this.lastResult);
    });
    return select;
  }

  private pager(pageCount: number): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "pm-sql-block-pager";

    const mkBtn = (label: string, delta: number, disabled: boolean): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pm-sql-block-page-btn";
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        this.page += delta;
        if (this.lastResult) this.renderResults(this.lastResult);
      });
      return b;
    };

    wrap.appendChild(mkBtn("‹", -1, this.page <= 0));
    const label = document.createElement("span");
    label.className = "pm-sql-block-page-label";
    label.textContent = `${this.page + 1} / ${pageCount}`;
    wrap.appendChild(label);
    wrap.appendChild(mkBtn("›", 1, this.page >= pageCount - 1));
    return wrap;
  }

  // ── NodeView lifecycle ─────────────────────────────────────────────────────

  update(node: PMNode): boolean {
    if (node.type.name !== "sql_block") return false;
    const dbChanged = node.attrs.db !== this.node.attrs.db;
    const hiddenChanged = node.attrs.hidden !== this.node.attrs.hidden;
    this.node = node;
    if (hiddenChanged) {
      this.applyHidden();
      this.refreshToggleLabel();
    }
    if (dbChanged) {
      this.syncDbOptions(
        Array.from(this.dbSelect.options, (o) => o.value).filter(Boolean),
      );
      void this.run();
    }
    // Deliberately NOT re-running on text edits — the user clicks Run for that.
    // But reflect staleness: editing the SQL lights the Run button up.
    this.refreshRunState();
    return true;
  }

  destroy(): void {
    this.token++; // drop any pending fetch render
    this.closeMenu();
  }

  // Let PM manage the editable SQL (contentDOM); everything else is ours.
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target as Node);
  }

  stopEvent(event: Event): boolean {
    return !this.contentDOM.contains(event.target as Node | null);
  }
}
