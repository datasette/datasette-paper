import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Node as PMNode } from "prosemirror-model";
import { schema } from "../schema";
import {
  buildReorderTr,
  isHeaderRow,
  leadingHeaderCount,
} from "../tableRowDrag";

function cell(text: string) {
  return schema.nodes.table_cell.create(
    null,
    schema.nodes.paragraph.create(null, schema.text(text)),
  );
}
function header(text: string) {
  return schema.nodes.table_header.create(
    null,
    schema.nodes.paragraph.create(null, schema.text(text)),
  );
}
function row(...children: PMNode[]) {
  return schema.nodes.table_row.create(null, children);
}

function buildState(rows: PMNode[]): { state: EditorState; tablePos: number } {
  const table = schema.nodes.table.create(null, rows);
  const doc = schema.node("doc", null, [table]);
  const state = EditorState.create({ doc, schema });
  // The table is the doc's first child, so its `pos before` is 0.
  return { state, tablePos: 0 };
}

function rowTexts(table: PMNode): string[] {
  const out: string[] = [];
  for (let i = 0; i < table.childCount; i++) {
    const r = table.child(i);
    let s = "";
    r.descendants((n) => {
      if (n.isText) s += n.text;
      return true;
    });
    out.push(s);
  }
  return out;
}

describe("isHeaderRow / leadingHeaderCount", () => {
  it("classifies all-th rows as headers", () => {
    expect(isHeaderRow(row(header("a"), header("b")))).toBe(true);
    expect(isHeaderRow(row(cell("a"), cell("b")))).toBe(false);
    // Mixed row → not a header row (one td is enough).
    expect(isHeaderRow(row(header("a"), cell("b")))).toBe(false);
  });

  it("counts the leading header prefix only", () => {
    const table = schema.nodes.table.create(null, [
      row(header("h1")),
      row(header("h2")),
      row(cell("body1")),
      row(header("late")), // not a leading header — doesn't count
    ]);
    expect(leadingHeaderCount(table)).toBe(2);
  });
});

describe("buildReorderTr", () => {
  it("moves a body row down past another body row", () => {
    const { state, tablePos } = buildState([
      row(header("h")),
      row(cell("a")),
      row(cell("b")),
      row(cell("c")),
    ]);
    // Move "a" (idx 1) to boundary 3 (between "b" and "c") → order: h, b, a, c
    const tr = buildReorderTr(state, tablePos, 1, 3);
    expect(tr).not.toBeNull();
    const newDoc = tr!.doc;
    expect(rowTexts(newDoc.firstChild!)).toEqual(["h", "b", "a", "c"]);
  });

  it("moves a body row up past another body row", () => {
    const { state, tablePos } = buildState([
      row(header("h")),
      row(cell("a")),
      row(cell("b")),
      row(cell("c")),
    ]);
    // Move "c" (idx 3) to boundary 1 (just after header) → order: h, c, a, b
    const tr = buildReorderTr(state, tablePos, 3, 1);
    expect(tr).not.toBeNull();
    expect(rowTexts(tr!.doc.firstChild!)).toEqual(["h", "c", "a", "b"]);
  });

  it("clamps drop boundary above the leading header to keep header pinned", () => {
    const { state, tablePos } = buildState([
      row(header("h")),
      row(cell("a")),
      row(cell("b")),
    ]);
    // Try to drop "b" at boundary 0 (before the header). buildReorderTr
    // clamps to headerCount=1, so the move is "drop just after header" →
    // order: h, b, a
    const tr = buildReorderTr(state, tablePos, 2, 0);
    expect(tr).not.toBeNull();
    expect(rowTexts(tr!.doc.firstChild!)).toEqual(["h", "b", "a"]);
  });

  it("refuses to move a leading header row", () => {
    const { state, tablePos } = buildState([
      row(header("h")),
      row(cell("a")),
      row(cell("b")),
    ]);
    expect(buildReorderTr(state, tablePos, 0, 2)).toBeNull();
  });

  it("returns null for no-op moves (drop boundary at source)", () => {
    const { state, tablePos } = buildState([
      row(header("h")),
      row(cell("a")),
      row(cell("b")),
    ]);
    // Boundary 1 (just before "a") and boundary 2 (just after "a") both
    // mean "leave a where it is".
    expect(buildReorderTr(state, tablePos, 1, 1)).toBeNull();
    expect(buildReorderTr(state, tablePos, 1, 2)).toBeNull();
  });

  it("preserves the table's name attr through reorder", () => {
    const headerRow = row(header("h"));
    const rows = [headerRow, row(cell("a")), row(cell("b"))];
    const named = schema.nodes.table.create({ name: "budget" }, rows);
    const doc = schema.node("doc", null, [named]);
    const state = EditorState.create({ doc, schema });
    const tr = buildReorderTr(state, 0, 1, 3);
    expect(tr).not.toBeNull();
    const newTable = tr!.doc.firstChild!;
    expect(newTable.attrs.name).toBe("budget");
    expect(rowTexts(newTable)).toEqual(["h", "b", "a"]);
  });
});
