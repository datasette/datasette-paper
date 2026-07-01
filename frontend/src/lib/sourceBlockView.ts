/**
 * NodeView for `source`: a named, parameterless SQL query that inline `value`
 * atoms reference by name. The query is editable text content (a `contentDOM`,
 * collaborating via the step log like `sql_block`); the chrome — a `name`
 * input, a db `<select>`, a collapse toggle, and a one-line column probe — is
 * non-editable and lives in `dom` outside `contentDOM`.
 *
 * Unlike `sql_block` it renders **no results table**: a source's results feed
 * the inline chips (deduped through the SourceStore), so the card only needs to
 * surface which columns exist to reference. The probe reuses the store's run —
 * no fetch of its own.
 *
 * `name` + `db` are node attrs (they collaborate); the SQL is content. Collapse
 * is a local presentation toggle (not persisted) and defaults **on**: since the
 * primary edit surface is now the right-sidebar Sources panel, the in-doc node
 * renders as a compact pill (name + db) by default and expands to the full SQL
 * editor on demand. XSS rule: every db-derived string (probe columns, error
 * text) enters the DOM as a text node only.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";
import { iconMarkup } from "./datasetteEmbed";
import { listQueryableDatabases } from "./sqlQuery";
import type { SourceStore, SourceState } from "./sourceStore";

/** Light normalization so a name is referenceable as `${{name.col}}`:
 *  lowercase, non-word chars → `_`. The Sources panel does the canonical
 *  enforcement + duplicate detection; this just keeps typed names sane. */
export function normalizeSourceName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// @feat source: NodeView — editable SQL card with name/db/collapse
export class SourceBlockView implements NodeView {
  dom: HTMLDivElement;
  contentDOM: HTMLElement;
  private node: PMNode;
  private codeWrap: HTMLPreElement;
  private probeEl: HTMLDivElement;
  private nameInput!: HTMLInputElement;
  private dbSelect!: HTMLSelectElement;
  private toggleBtn!: HTMLButtonElement;
  // Default collapsed: the sidebar Sources panel is the primary editor, so the
  // in-doc node reads as a pill until the reader expands it.
  private collapsed = true;
  private unsubscribe: (() => void) | null = null;

  constructor(
    node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private store: SourceStore,
  ) {
    this.node = node;

    this.dom = document.createElement("div");
    this.dom.className = "pm-source-card";

    this.dom.appendChild(this.buildHeader());

    this.codeWrap = document.createElement("pre");
    this.codeWrap.className = "pm-source-card-code";
    this.contentDOM = document.createElement("code");
    this.codeWrap.appendChild(this.contentDOM);
    this.dom.appendChild(this.codeWrap);

    this.probeEl = document.createElement("div");
    this.probeEl.className = "pm-source-card-probe";
    this.dom.appendChild(this.probeEl);

    void this.populateDatabases();
    this.subscribeProbe();
  }

  // ── Header chrome ──────────────────────────────────────────────────────────

  private buildHeader(): HTMLElement {
    const head = document.createElement("div");
    head.className = "pm-source-card-head";

    const icon = document.createElement("span");
    icon.className = "pm-source-card-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = iconMarkup("database"); // trusted constant SVG
    head.appendChild(icon);

    const at = document.createElement("span");
    at.className = "pm-source-card-sigil";
    at.textContent = "${{";
    head.appendChild(at);

    this.nameInput = document.createElement("input");
    this.nameInput.type = "text";
    this.nameInput.className = "pm-source-card-name";
    this.nameInput.placeholder = "name";
    this.nameInput.value = (this.node.attrs.name as string | null) ?? "";
    this.syncNameWidth();
    // Grow the field with its content as you type, but only *commit* the value
    // on blur/Enter — never per-keystroke (focus-stealing; see frontend/CLAUDE.md
    // note on the table name input).
    this.nameInput.addEventListener("input", () => this.syncNameWidth());
    this.nameInput.addEventListener("blur", () => this.commitName());
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.nameInput.blur();
      }
    });
    head.appendChild(this.nameInput);

    const close = document.createElement("span");
    close.className = "pm-source-card-sigil";
    close.textContent = "}}";
    head.appendChild(close);

    this.dbSelect = document.createElement("select");
    this.dbSelect.className = "pm-source-card-db";
    this.dbSelect.title = "Database";
    this.syncDbOptions([]);
    this.dbSelect.addEventListener("change", () => {
      this.setAttr("db", this.dbSelect.value || null);
    });
    head.appendChild(this.dbSelect);

    const spacer = document.createElement("span");
    spacer.className = "pm-source-card-spacer";
    head.appendChild(spacer);

    this.toggleBtn = document.createElement("button");
    this.toggleBtn.type = "button";
    this.toggleBtn.className = "pm-source-card-toggle";
    this.toggleBtn.addEventListener("click", (e) => {
      e.preventDefault();
      this.collapsed = !this.collapsed;
      this.applyCollapsed();
    });
    head.appendChild(this.toggleBtn);
    this.applyCollapsed();

    return head;
  }

  private commitName(): void {
    const next = normalizeSourceName(this.nameInput.value);
    if (next !== this.nameInput.value) this.nameInput.value = next;
    this.syncNameWidth();
    if (next !== ((this.node.attrs.name as string | null) ?? "")) {
      this.setAttr("name", next || null);
    }
  }

  /** Size the input to its content (or the placeholder when empty) so a long
   *  source name isn't clipped. The `size` attr counts characters; the mono
   *  font makes that a faithful width. `+1` leaves room for the caret. */
  private syncNameWidth(): void {
    const text = this.nameInput.value || this.nameInput.placeholder;
    this.nameInput.size = Math.max(text.length + 1, 4);
  }

  private applyCollapsed(): void {
    this.dom.classList.toggle("is-collapsed", this.collapsed);
    this.toggleBtn.textContent = this.collapsed ? "▸ Show SQL" : "Hide SQL";
  }

  private async populateDatabases(): Promise<void> {
    const dbs = await listQueryableDatabases();
    this.syncDbOptions(dbs);
    if (!this.node.attrs.db && dbs.length) this.setAttr("db", dbs[0]);
  }

  private syncDbOptions(dbs: string[]): void {
    const current = (this.node.attrs.db as string | null) ?? "";
    this.dbSelect.replaceChildren();
    const names = new Set(dbs);
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

  // ── Probe (reuses the store's run; no fetch of its own) ─────────────────────

  private subscribeProbe(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    const name = (this.node.attrs.name as string | null) ?? null;
    if (!name) {
      this.renderProbe({ status: "missing" });
      return;
    }
    this.unsubscribe = this.store.subscribe(name, (s) => this.renderProbe(s));
  }

  private renderProbe(state: SourceState): void {
    let cls = "pm-source-card-probe";
    let text: string;
    switch (state.status) {
      case "loading":
        text = "running…";
        break;
      case "missing":
        text = this.node.attrs.name ? "no data" : "name this source to reference it";
        break;
      case "denied":
        cls += " is-error";
        text = "no access to this database";
        break;
      case "error":
        cls += " is-error";
        text = state.error;
        break;
      case "ok":
        text = state.columns.length
          ? `${state.columns.length} column${state.columns.length === 1 ? "" : "s"}: ${state.columns.join(", ")}`
          : "no columns";
        break;
    }
    this.probeEl.className = cls;
    this.probeEl.textContent = text;
  }

  // ── Attr mutation (collaborates via the step log) ──────────────────────────

  private setAttr(key: "name" | "db", value: string | null): void {
    const pos = this.getPos();
    if (pos == null) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        [key]: value,
      }),
    );
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "source") return false;
    const nameChanged = node.attrs.name !== this.node.attrs.name;
    const dbChanged = node.attrs.db !== this.node.attrs.db;
    this.node = node;
    if (nameChanged) {
      if (document.activeElement !== this.nameInput) {
        this.nameInput.value = (node.attrs.name as string | null) ?? "";
        this.syncNameWidth();
      }
      this.subscribeProbe();
    }
    if (dbChanged) {
      this.syncDbOptions(
        Array.from(this.dbSelect.options, (o) => o.value).filter(Boolean),
      );
    }
    return true;
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // Let PM manage the editable SQL (contentDOM); everything else is ours.
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM.contains(mutation.target as Node);
  }

  stopEvent(event: Event): boolean {
    return !this.contentDOM.contains(event.target as Node | null);
  }
}
