import { describe, it, expect } from "vitest";
import { Slice, Fragment } from "prosemirror-model";
import { ReplaceStep, Step } from "prosemirror-transform";
import { EditorState } from "prosemirror-state";
import { schema } from "../schema";
import { countOtherTablesWithName } from "../tables";

describe("table schema", () => {
  it("registers the table family with a name attr on the table node", () => {
    expect(schema.nodes.table).toBeDefined();
    expect(schema.nodes.table_row).toBeDefined();
    expect(schema.nodes.table_cell).toBeDefined();
    expect(schema.nodes.table_header).toBeDefined();
    const tableType = schema.nodes.table;
    expect(Object.keys(tableType.spec.attrs ?? {})).toContain("name");
  });

  it("builds a table doc and round-trips a ReplaceStep with name attr", () => {
    const cell = (text: string) =>
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create(null, schema.text(text)));
    const header = (text: string) =>
      schema.nodes.table_header.create(null, schema.nodes.paragraph.create(null, schema.text(text)));
    const row = (...children: ReturnType<typeof cell>[]) => schema.nodes.table_row.create(null, children);

    const table = schema.nodes.table.create({ name: "budget" }, [
      row(header("item"), header("cost")),
      row(cell("coffee"), cell("4")),
    ]);

    const empty = schema.node("doc", null, [schema.nodes.paragraph.create()]);
    const step = new ReplaceStep(0, 2, new Slice(Fragment.from(table), 0, 0));

    const applied = step.apply(empty);
    expect(applied.failed).toBeNull();
    expect(applied.doc).toBeDefined();
    const inserted = applied.doc!.firstChild!;
    expect(inserted.type.name).toBe("table");
    expect(inserted.attrs.name).toBe("budget");

    // Round-trip through JSON — this is the path collab steps actually take.
    const stepJson = step.toJSON();
    const restored = Step.fromJSON(schema, stepJson);
    const applied2 = restored.apply(empty);
    expect(applied2.failed).toBeNull();
    expect(applied2.doc!.firstChild!.attrs.name).toBe("budget");
  });
});

describe("countOtherTablesWithName", () => {
  function buildDoc(...tables: { name: string | null }[]) {
    const cell = (text: string) =>
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create(null, schema.text(text)));
    const row = schema.nodes.table_row.create(null, [cell("x")]);
    const tableNodes = tables.map((t) => schema.nodes.table.create({ name: t.name }, [row]));
    return schema.node("doc", null, tableNodes);
  }

  function ownPosOfTable(state: EditorState, index: number): number {
    let pos = -1;
    let i = 0;
    state.doc.descendants((node, p) => {
      if (node.type === schema.nodes.table) {
        if (i === index) pos = p;
        i++;
        return false;
      }
      return true;
    });
    return pos;
  }

  it("returns 0 when no other table shares the name", () => {
    const doc = buildDoc({ name: "budget" }, { name: "other" });
    const state = EditorState.create({ doc });
    const own = ownPosOfTable(state, 0);
    expect(countOtherTablesWithName(state, "budget", own)).toBe(0);
  });

  it("counts other tables with matching name, excluding the own pos", () => {
    const doc = buildDoc({ name: "data" }, { name: "data" }, { name: "other" });
    const state = EditorState.create({ doc });
    const ownPos = ownPosOfTable(state, 0);
    expect(countOtherTablesWithName(state, "data", ownPos)).toBe(1);
  });

  it("ignores empty/whitespace draft and trims comparison", () => {
    const doc = buildDoc({ name: "data" }, { name: "data" });
    const state = EditorState.create({ doc });
    const ownPos = ownPosOfTable(state, 0);
    expect(countOtherTablesWithName(state, "", ownPos)).toBe(0);
    expect(countOtherTablesWithName(state, "   ", ownPos)).toBe(0);
    expect(countOtherTablesWithName(state, "  data  ", ownPos)).toBe(1);
  });
});

