/**
 * Schema-level tests for the placeholder inline atom.
 *
 * The placeholder node must round-trip through the schema (create →
 * toJSON → nodeFromJSON) and remain an inline atom — substituting it
 * is the server's job, but the editor side has to author it cleanly
 * inside any inline content (paragraph, heading, table cell, list
 * item) and survive a transaction.
 */
import { describe, it, expect } from "vitest";
import { TextSelection } from "prosemirror-state";
import { EditorState } from "prosemirror-state";
import { schema } from "../schema";

describe("placeholder node", () => {
  it("exists on the schema as an inline atom", () => {
    const t = schema.nodes.placeholder;
    expect(t).toBeDefined();
    expect(t.isInline).toBe(true);
    expect(t.isAtom).toBe(true);
  });

  it("round-trips through JSON", () => {
    const node = schema.nodes.placeholder.create({ key: "today" });
    const json = node.toJSON();
    expect(json).toEqual({
      type: "placeholder",
      attrs: { key: "today", label: null },
    });
    const back = schema.nodeFromJSON(json);
    expect(back.attrs.key).toBe("today");
    expect(back.type).toBe(schema.nodes.placeholder);
  });

  it("can be inserted into a paragraph via replaceSelectionWith", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.setSelection(TextSelection.atStart(state.doc)));

    const ph = schema.nodes.placeholder.create({ key: "actor" });
    const tr = state.tr.replaceSelectionWith(ph);
    const next = state.apply(tr);

    const para = next.doc.firstChild!;
    expect(para.childCount).toBe(1);
    const inserted = para.firstChild!;
    expect(inserted.type.name).toBe("placeholder");
    expect(inserted.attrs.key).toBe("actor");
  });
});

describe("paper_link node", () => {
  it("exists on the schema as an inline atom leaf", () => {
    const t = schema.nodes.paper_link;
    expect(t).toBeDefined();
    expect(t.isInline).toBe(true);
    expect(t.isAtom).toBe(true);
    expect(t.isLeaf).toBe(true);
  });

  it("round-trips through JSON", () => {
    const node = schema.nodes.paper_link.create({ docId: 7 });
    const json = node.toJSON();
    expect(json).toEqual({
      type: "paper_link",
      attrs: { docId: 7 },
    });
    const back = schema.nodeFromJSON(json);
    expect(back.attrs.docId).toBe(7);
    expect(back.type).toBe(schema.nodes.paper_link);
  });

  it("toDOM emits data-paper-link", () => {
    const node = schema.nodes.paper_link.create({ docId: 7 });
    const dom = node.type.spec.toDOM!(node) as [string, Record<string, string>, string];
    expect(dom[1]["data-paper-link"]).toBe("7");
  });

  it("can be inserted into a paragraph via replaceSelectionWith", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.setSelection(TextSelection.atStart(state.doc)));

    const link = schema.nodes.paper_link.create({ docId: 7 });
    const tr = state.tr.replaceSelectionWith(link);
    const next = state.apply(tr);

    const para = next.doc.firstChild!;
    expect(para.childCount).toBe(1);
    const inserted = para.firstChild!;
    expect(inserted.type.name).toBe("paper_link");
    expect(inserted.attrs.docId).toBe(7);
  });
});

describe("inline_embed node", () => {
  it("exists on the schema as an inline atom leaf", () => {
    const t = schema.nodes.inline_embed;
    expect(t).toBeDefined();
    expect(t.isInline).toBe(true);
    expect(t.isAtom).toBe(true);
    expect(t.isLeaf).toBe(true);
  });

  it("round-trips through JSON", () => {
    const node = schema.nodes.inline_embed.create({ ref: "/fixtures/facetable" });
    const json = node.toJSON();
    expect(json).toEqual({
      type: "inline_embed",
      attrs: { ref: "/fixtures/facetable" },
    });
    const back = schema.nodeFromJSON(json);
    expect(back.attrs.ref).toBe("/fixtures/facetable");
    expect(back.type).toBe(schema.nodes.inline_embed);
  });

  it("toDOM emits data-inline-embed", () => {
    const node = schema.nodes.inline_embed.create({ ref: "/fixtures/facetable" });
    const dom = node.type.spec.toDOM!(node) as [string, Record<string, string>, string];
    expect(dom[1]["data-inline-embed"]).toBe("/fixtures/facetable");
  });

  it("can be inserted into a paragraph via replaceSelectionWith", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    let state = EditorState.create({ doc });
    state = state.apply(state.tr.setSelection(TextSelection.atStart(state.doc)));

    const ref = schema.nodes.inline_embed.create({ ref: "/fixtures/facetable/1" });
    const tr = state.tr.replaceSelectionWith(ref);
    const next = state.apply(tr);

    const para = next.doc.firstChild!;
    expect(para.childCount).toBe(1);
    const inserted = para.firstChild!;
    expect(inserted.type.name).toBe("inline_embed");
    expect(inserted.attrs.ref).toBe("/fixtures/facetable/1");
  });
});

describe("block_embed node", () => {
  it("exists on the schema as a block atom leaf", () => {
    const t = schema.nodes.block_embed;
    expect(t).toBeDefined();
    expect(t.isBlock).toBe(true);
    expect(t.isAtom).toBe(true);
    expect(t.isLeaf).toBe(true);
  });

  it("round-trips through JSON with default mode", () => {
    const node = schema.nodes.block_embed.create({ ref: "/fixtures/facetable" });
    const json = node.toJSON();
    expect(json).toEqual({
      type: "block_embed",
      attrs: { ref: "/fixtures/facetable", mode: "table" },
    });
    const back = schema.nodeFromJSON(json);
    expect(back.attrs.ref).toBe("/fixtures/facetable");
    expect(back.attrs.mode).toBe("table");
    expect(back.type).toBe(schema.nodes.block_embed);
  });

  it("toDOM emits data-block-embed and data-embed-mode", () => {
    const node = schema.nodes.block_embed.create({
      ref: "/fixtures/facetable",
      mode: "row",
    });
    const dom = node.type.spec.toDOM!(node) as [string, Record<string, string>, string];
    expect(dom[1]["data-block-embed"]).toBe("/fixtures/facetable");
    expect(dom[1]["data-embed-mode"]).toBe("row");
  });

  it("can be inserted at the top level of the doc", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    const state = EditorState.create({ doc });
    const embed = schema.nodes.block_embed.create({ ref: "/fixtures/facetable" });
    const tr = state.tr.insert(state.doc.content.size, embed);
    const next = state.apply(tr);

    const inserted = next.doc.lastChild!;
    expect(inserted.type.name).toBe("block_embed");
    expect(inserted.attrs.ref).toBe("/fixtures/facetable");
  });
});

describe("sql_block node", () => {
  it("exists as a block code node with editable text content", () => {
    const t = schema.nodes.sql_block;
    expect(t).toBeDefined();
    expect(t.isBlock).toBe(true);
    expect(t.isTextblock).toBe(true);
    expect(t.spec.code).toBe(true);
    // Unlike block_embed it is NOT an atom — the SQL is editable content.
    expect(t.isAtom).toBe(false);
  });

  it("round-trips through JSON with db + hidden attrs and text content", () => {
    const node = schema.nodes.sql_block.create({ db: "data", hidden: false }, [
      schema.text("select 1 as n"),
    ]);
    const json = node.toJSON();
    expect(json).toEqual({
      type: "sql_block",
      attrs: { db: "data", hidden: false },
      content: [{ type: "text", text: "select 1 as n" }],
    });
    const back = schema.nodeFromJSON(json);
    expect(back.attrs.db).toBe("data");
    expect(back.textContent).toBe("select 1 as n");
    expect(back.type).toBe(schema.nodes.sql_block);
  });

  it("toDOM emits data-sql-block / data-sql-db / data-sql-hidden", () => {
    const node = schema.nodes.sql_block.create({ db: "data", hidden: true });
    const dom = node.type.spec.toDOM!(node) as [string, Record<string, string>, unknown];
    expect(dom[0]).toBe("pre");
    expect(dom[1]["data-sql-block"]).toBe("true");
    expect(dom[1]["data-sql-db"]).toBe("data");
    expect(dom[1]["data-sql-hidden"]).toBe("true");
  });

  it("can be inserted at the top level of the doc", () => {
    const doc = schema.node("doc", null, [schema.node("paragraph")]);
    const state = EditorState.create({ doc });
    const sql = schema.nodes.sql_block.create({ db: "data" }, [schema.text("select 1")]);
    const tr = state.tr.insert(state.doc.content.size, sql);
    const next = state.apply(tr);

    const inserted = next.doc.lastChild!;
    expect(inserted.type.name).toBe("sql_block");
    expect(inserted.attrs.db).toBe("data");
    expect(inserted.textContent).toBe("select 1");
  });
});
