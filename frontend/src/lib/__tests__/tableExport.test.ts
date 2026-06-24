/**
 * Unit tests for the shared result serializers (`tableExport.ts`), used by both
 * the SQL block and the table `block_embed`. Mirrors the CSV/JSON cases that
 * previously lived in `sqlQuery.test.ts`, plus the {$base64} binary envelope.
 */
import { describe, it, expect } from "vitest";
import { rowsToCsv, rowsToJson } from "../tableExport";

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

  it("renders a {$base64} binary cell as [binary]", () => {
    const csv = rowsToCsv(["b"], [[{ $base64: true, encoded: "AAA=" }]]);
    expect(csv).toBe("b\n[binary]");
  });

  it("emits just the header when there are no rows", () => {
    expect(rowsToCsv(["a", "b"], [])).toBe("a,b");
  });
});

describe("rowsToJson", () => {
  it("emits an array of column-keyed objects preserving types", () => {
    const json = rowsToJson(["id", "ok"], [[1, true]]);
    expect(JSON.parse(json)).toEqual([{ id: 1, ok: true }]);
  });

  it("renders a {$base64} binary cell as the string [binary]", () => {
    const json = rowsToJson(["b"], [[{ $base64: true, encoded: "AAA=" }]]);
    expect(JSON.parse(json)).toEqual([{ b: "[binary]" }]);
  });
});
