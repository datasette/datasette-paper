// Hydrate the *live* data blocks on a published page.
//
// A published page is static server-rendered HTML (see
// datasette_paper/html_render.py). Blocks whose data mode is `live` are emitted
// as placeholders carrying `data-publish-live="1"` + their `data-*` config; this
// module fetches + renders them **per viewer, under the viewer's own Datasette
// permissions**, by reusing the exact same fetch layer the editor uses
// (runSqlQuery / fetchEmbed / formatValue). It deliberately imports none of
// ProseMirror, collab, or the editor — the published page must stay cheap.
//
// The rendered markup mirrors html_render.py's frozen output (`pm-data-table`
// etc.) so a live block and a frozen block look identical once loaded. All
// values enter the DOM as text nodes (never innerHTML) — same XSS guarantee as
// the editor's NodeViews.
import { runSqlQuery, type SqlResult } from "./sqlQuery";
import { fetchEmbed, cellText, type CellValue, type EmbedPayload } from "./datasetteEmbed";
import { formatValue, type ValueFormat } from "./formatValue";

/** Build a results table matching html_render.py's `_frozen_table` markup. */
function resultsTable(columns: string[], rows: CellValue[][]): HTMLElement {
  const table = document.createElement("table");
  table.className = "pm-data-table";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement("td");
      td.textContent = cellText(cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function setSlot(host: HTMLElement, node: Node | string): void {
  const slot = host.querySelector<HTMLElement>(".pm-data-slot");
  const target = slot ?? host;
  target.replaceChildren(typeof node === "string" ? document.createTextNode(node) : node);
  target.classList.remove("pm-data-slot--loading");
}

function statusMessage(host: HTMLElement, text: string): void {
  const div = document.createElement("div");
  div.className = "pm-data-empty";
  div.textContent = text;
  setSlot(host, div);
}

async function hydrateSqlBlock(host: HTMLElement): Promise<void> {
  const db = host.getAttribute("data-sql-db") ?? "";
  const sql = host.getAttribute("data-sql") ?? "";
  const result: SqlResult = await runSqlQuery(db, sql);
  if (result.status === "denied") return statusMessage(host, "Permission denied");
  if (result.status === "error") return statusMessage(host, result.error ?? "Query failed");
  if (result.status === "empty") return statusMessage(host, "No query");
  setSlot(host, resultsTable(result.columns ?? [], result.rows ?? []));
}

function renderEmbed(payload: EmbedPayload): Node {
  if (payload.status === "denied") {
    const d = document.createElement("div");
    d.className = "pm-data-empty";
    d.textContent = "Permission denied";
    return d;
  }
  if (payload.status === "not_found") {
    const d = document.createElement("div");
    d.className = "pm-data-empty";
    d.textContent = "Not found";
    return d;
  }
  if (payload.kind === "table" || payload.kind === "view") {
    return resultsTable(payload.columns, payload.rows);
  }
  if (payload.kind === "row") {
    const dl = document.createElement("dl");
    dl.className = "pm-embed-row";
    for (const f of payload.fields) {
      const dt = document.createElement("dt");
      dt.textContent = f.column;
      const dd = document.createElement("dd");
      dd.textContent = cellText(f.value);
      dl.append(dt, dd);
    }
    return dl;
  }
  if (payload.kind === "database") {
    const ul = document.createElement("ul");
    ul.className = "pm-embed-db";
    for (const t of payload.tables) {
      const li = document.createElement("li");
      li.textContent = `${t.name} (${t.kind})`;
      ul.appendChild(li);
    }
    return ul;
  }
  return document.createTextNode("");
}

async function hydrateBlockEmbed(host: HTMLElement): Promise<void> {
  const ref = host.getAttribute("data-block-embed") ?? "";
  const payload = await fetchEmbed(ref);
  setSlot(host, renderEmbed(payload));
}

/** Resolve one source query (db + sql), returning columns + first row. */
async function runSource(
  host: HTMLElement,
): Promise<{ columns: string[]; row: CellValue[] | null }> {
  const db = host.getAttribute("data-source-db") ?? "";
  const sql = host.getAttribute("data-sql") ?? "";
  const result = await runSqlQuery(db, sql);
  if (result.status !== "ok") return { columns: [], row: null };
  return { columns: result.columns ?? [], row: (result.rows ?? [])[0] ?? null };
}

function parseFormat(raw: string | null): ValueFormat {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ValueFormat;
  } catch {
    return null;
  }
}

/**
 * Hydrate every live block under `root` (defaults to document). Source queries
 * are run once each and fanned out to the inline values that reference them.
 */
export async function hydratePublished(root: ParentNode = document): Promise<void> {
  const tasks: Promise<void>[] = [];

  root
    .querySelectorAll<HTMLElement>('.pm-sql-block[data-publish-live="1"]')
    .forEach((el) => tasks.push(hydrateSqlBlock(el)));

  root
    .querySelectorAll<HTMLElement>('.pm-block-embed[data-publish-live="1"]')
    .forEach((el) => tasks.push(hydrateBlockEmbed(el)));

  // Sources: run each once, then resolve the values that reference it by name.
  const sourceEls = Array.from(
    root.querySelectorAll<HTMLElement>('.pm-source-card[data-publish-live="1"]'),
  );
  const sourceByName = new Map<string, Promise<{ columns: string[]; row: CellValue[] | null }>>();
  for (const el of sourceEls) {
    const name = el.getAttribute("data-source-name") ?? "";
    if (name && !sourceByName.has(name)) sourceByName.set(name, runSource(el));
  }

  root
    .querySelectorAll<HTMLElement>('.pm-value[data-publish-live="1"]')
    .forEach((el) => {
      const source = el.getAttribute("data-source") ?? "";
      const column = el.getAttribute("data-column") ?? "";
      const format = parseFormat(el.getAttribute("data-format"));
      const pending = sourceByName.get(source);
      if (!pending) return; // no matching source on the page; leave fallback text
      tasks.push(
        pending.then(({ columns, row }) => {
          const idx = columns.indexOf(column);
          const cell = idx >= 0 && row ? row[idx] : undefined;
          el.textContent = formatValue(cell ?? null, format);
        }),
      );
    });

  await Promise.all(tasks);
}
