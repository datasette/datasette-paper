/**
 * Unit tests for the SQL block's client-side helpers: query URL construction,
 * status mapping (ok / denied / error / empty), db enumeration, and the
 * insert command.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";

import { schema } from "../schema";
import {
  runSqlQuery,
  listQueryableDatabases,
  insertSqlBlock,
  queryHref,
  rowsToCsv,
  rowsToJson,
} from "../sqlQuery";

afterEach(() => vi.unstubAllGlobals());

describe("runSqlQuery", () => {
  it("hits /{db}/-/query.json with the encoded sql + arrays shape", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, columns: ["n"], rows: [[1]] }),
        };
      }),
    );
    const res = await runSqlQuery("data", "select 1 as n");
    expect(calls[0]).toBe(
      "/data/-/query.json?sql=select%201%20as%20n&_shape=arrays&_extra=columns",
    );
    expect(res).toEqual({ status: "ok", columns: ["n"], rows: [[1]], truncated: false });
  });

  it("returns empty without fetching when db or sql is blank", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await runSqlQuery("", "select 1")).toEqual({ status: "empty" });
    expect(await runSqlQuery("data", "   ")).toEqual({ status: "empty" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps 403 to denied (no leak)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })),
    );
    expect(await runSqlQuery("data", "select 1")).toEqual({ status: "denied" });
  });

  it("surfaces a SQL error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, error: "no such table: nope" }),
      })),
    );
    expect(await runSqlQuery("data", "select * from nope")).toEqual({
      status: "error",
      error: "no such table: nope",
    });
  });

  it("maps a network throw to a generic error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await runSqlQuery("data", "select 1")).toEqual({
      status: "error",
      error: "Could not reach the database",
    });
  });
});

describe("queryHref", () => {
  it("links to the Datasette query HTML page", () => {
    expect(queryHref("data", "select 1")).toBe("/data/-/query?sql=select%201");
  });
});

describe("rowsToCsv", () => {
  it("emits a header row and quotes cells with commas/quotes/newlines", () => {
    const csv = rowsToCsv(
      ["id", "name"],
      [
        [1, "Acme, Inc."],
        [2, 'A "quote"'],
        [3, null],
      ],
    );
    expect(csv).toBe('id,name\n1,"Acme, Inc."\n2,"A ""quote"""\n3,');
  });
});

describe("rowsToJson", () => {
  it("emits an array of column-keyed objects preserving types", () => {
    const json = rowsToJson(["id", "ok"], [[1, true]]);
    expect(JSON.parse(json)).toEqual([{ id: 1, ok: true }]);
  });
});

describe("listQueryableDatabases", () => {
  it("returns non-internal database names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          databases: [{ name: "data" }, { name: "fixtures" }, { name: "_internal" }],
        }),
      })),
    );
    expect(await listQueryableDatabases()).toEqual(["data", "fixtures"]);
  });

  it("accepts the legacy pre-1.0a36 object-keyed shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          databases: { data: {}, fixtures: {}, _internal: {} },
        }),
      })),
    );
    expect(await listQueryableDatabases()).toEqual(["data", "fixtures"]);
  });

  it("returns [] on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    expect(await listQueryableDatabases()).toEqual([]);
  });
});

describe("insertSqlBlock", () => {
  it("inserts an empty sql_block with the given db", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.setSelection(TextSelection.atStart(state.doc)));

    let next = state;
    insertSqlBlock("data")(state, (tr) => (next = state.apply(tr)));

    const inserted = next.doc.firstChild!;
    expect(inserted.type.name).toBe("sql_block");
    expect(inserted.attrs.db).toBe("data");
    expect(inserted.attrs.hidden).toBe(false);
    expect(inserted.textContent).toBe("");
  });
});
