// @feat callout: serializer tests — `> [!KIND] Title` marker + quoted body on copy
/**
 * Tests for the shared client markdown serializer (markdownSerializer.ts).
 * The expected strings mirror the backend serializer's output shapes
 * (datasette_paper/markdown.py, pinned by tests/test_markdown.py) — if one
 * side changes format, change both.
 *
 * prosemirror-markdown is imported eagerly here (tests don't care about the
 * lazy-load); production callers pass the dynamically-imported module.
 */
import { describe, it, expect } from "vitest";
import * as pmMarkdown from "prosemirror-markdown";
import type { Node as PMNode } from "prosemirror-model";

import { schema } from "../schema";
import { buildMarkdownSerializer, serializeDoc } from "../markdownSerializer";

const serializer = buildMarkdownSerializer(pmMarkdown);

const n = schema.nodes;
const text = (s: string) => schema.text(s);
const p = (s: string) => n.paragraph.create(null, text(s));
const title = (s?: string) => n.callout_title.create(null, s ? [text(s)] : []);

function md(...children: PMNode[]): string {
  return serializeDoc(serializer, n.doc.create(null, children));
}

describe("callout markdown serialization", () => {
  it("serializes kind (UPPERCASE) + title onto the marker line, body `> `-quoted", () => {
    const callout = n.callout.create({ kind: "warning" }, [
      title("Heads up"),
      p("Careful now"),
    ]);
    expect(md(callout)).toBe("> [!WARNING] Heads up\n> Careful now");
  });

  it("omits the title from the marker when empty", () => {
    const callout = n.callout.create({ kind: "tip" }, [title(), p("body")]);
    expect(md(callout)).toBe("> [!TIP]\n> body");
  });

  it("clamps an unknown kind to NOTE (mirror of the backend clamp)", () => {
    const callout = n.callout.create({ kind: "bogus" }, [title(), p("x")]);
    expect(md(callout)).toBe("> [!NOTE]\n> x");
  });

  // @feat callout: a collapsed callout copies with the Obsidian `-` suffix
  it("emits the `-` fold suffix for a collapsed callout", () => {
    const callout = n.callout.create({ kind: "note", collapsed: true }, [
      title("Heads up"),
      p("body"),
    ]);
    expect(md(callout)).toBe("> [!NOTE]- Heads up\n> body");
  });

  it("separates multiple body blocks with a quoted blank line", () => {
    const callout = n.callout.create({ kind: "note" }, [title("T"), p("one"), p("two")]);
    expect(md(callout)).toBe("> [!NOTE] T\n> one\n>\n> two");
  });

  it("quotes nested body structure (task list) with the `> ` prefix", () => {
    const callout = n.callout.create({ kind: "important" }, [
      title(),
      n.task_list.create(null, [
        n.task_item.create({ checked: false }, p("open")),
        n.task_item.create({ checked: true }, p("done")),
      ]),
    ]);
    expect(md(callout)).toBe("> [!IMPORTANT]\n> - [ ] open\n> - [x] done");
  });

  it("round-trips with surrounding blocks in one serialization", () => {
    const out = md(
      n.heading.create({ level: 2 }, text("Docs")),
      n.callout.create({ kind: "caution" }, [title("Stop"), p("really")]),
      p("after"),
    );
    expect(out).toBe("## Docs\n\n> [!CAUTION] Stop\n> really\n\nafter");
  });
});

describe("custom node rules (backend output shapes)", () => {
  it("inline atoms: placeholder, paper_link, mention, tag, value", () => {
    const para = n.paragraph.create(null, [
      n.placeholder.create({ key: "city" }),
      text(" "),
      n.paper_link.create({ docId: 7 }),
      text(" "),
      n.mention.create({ actorId: "ana" }),
      text(" "),
      n.tag.create({ tag: "urgent" }),
      text(" "),
      n.value.create({ source: "sales", column: "total" }),
    ]);
    expect(md(para)).toBe(
      "{{city}} [[7]] [@ana](paper:/actor/ana) [#urgent](paper:/tag/urgent) ${{sales.total}}",
    );
  });

  it("value: non-identifier column brackets; format encodes as `| kind:arg`", () => {
    const para = n.paragraph.create(null, [
      n.value.create({
        source: "sales",
        column: "unit price",
        format: { kind: "currency", currency: "USD" },
      }),
    ]);
    expect(md(para)).toBe("${{sales.[unit price] | currency:USD}}");
  });

  it("code_block keeps its language; reserved fence tokens clamp to plain", () => {
    const code = n.code_block.create({ language: "python" }, text("x = 1"));
    expect(md(code)).toBe("```python\nx = 1\n```");
    const reserved = n.code_block.create({ language: "source" }, text("y"));
    expect(md(reserved)).toBe("```\ny\n```");
  });

  it("sql_block always emits the `db=` token (+ hidden)", () => {
    const sql = n.sql_block.create({ db: "fixtures", hidden: true }, text("select 1"));
    expect(md(sql)).toBe("```sql db=fixtures hidden\nselect 1\n```");
    const bare = n.sql_block.create(null, text("select 2"));
    expect(md(bare)).toBe("```sql db=\nselect 2\n```");
  });

  it("source / block_embed / toc emit their fence forms", () => {
    const source = n.source.create({ name: "revenue", db: "fixtures" }, text("select 3"));
    expect(md(source)).toBe("```source name=revenue db=fixtures\nselect 3\n```");

    const embed = n.block_embed.create({ ref: "/fixtures/facetable", mode: "table" });
    expect(md(embed)).toBe(
      '```paper-embed\n{"config":{},"mode":"table","ref":"/fixtures/facetable"}\n```',
    );

    const toc = n.toc.create();
    expect(md(toc)).toBe("```paper-toc\n```");
  });

  it("throws on a table (no rule) — callers catch and fall back", () => {
    const table = n.table.create(null, [
      n.table_row.create(null, [n.table_cell.createAndFill()!]),
    ]);
    expect(() => md(table)).toThrow();
  });
});
