/**
 * Tests for the published-page live-block hydrator. Stubs `fetch` (the only
 * external dependency) and asserts the placeholders render the same
 * `pm-data-table` / value markup the server's frozen renderer emits.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

import { hydratePublished } from "../publishHydrate";

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("hydratePublished", () => {
  it("renders a live sql_block into a results table", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ ok: true, columns: ["n"], rows: [[1], [2]], truncated: false }),
      ),
    );
    document.body.innerHTML = `
      <div class="pm-sql-block" data-block-id="b0" data-publish-live="1"
           data-sql-db="analytics" data-sql="select 1">
        <div class="pm-data-slot">Loading…</div>
      </div>`;
    await hydratePublished(document);
    const table = document.querySelector(".pm-sql-block .pm-data-table");
    expect(table).not.toBeNull();
    expect(table!.querySelectorAll("thead th")).toHaveLength(1);
    expect(table!.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("shows a leak-free message when the query is denied", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 403)));
    document.body.innerHTML = `
      <div class="pm-sql-block" data-publish-live="1" data-sql-db="db" data-sql="select 1">
        <div class="pm-data-slot">Loading…</div>
      </div>`;
    await hydratePublished(document);
    expect(document.querySelector(".pm-data-empty")!.textContent).toBe(
      "Permission denied",
    );
  });

  it("resolves an inline value from its source's first row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ ok: true, columns: ["total"], rows: [[42]], truncated: false }),
      ),
    );
    document.body.innerHTML = `
      <div class="pm-source-card" data-publish-live="1" data-source-name="rev"
           data-source-db="analytics" data-sql="select 42 as total"></div>
      <span class="pm-value" data-publish-live="1" data-source="rev"
            data-column="total" data-format="null">total</span>`;
    await hydratePublished(document);
    expect(document.querySelector(".pm-value")!.textContent).toBe("42");
  });

  it("leaves a value untouched when no matching source is on the page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
    document.body.innerHTML = `
      <span class="pm-value" data-publish-live="1" data-source="ghost"
            data-column="x" data-format="null">x</span>`;
    await hydratePublished(document);
    expect(document.querySelector(".pm-value")!.textContent).toBe("x");
  });
});
