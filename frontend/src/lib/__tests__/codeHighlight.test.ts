/**
 * Tests for the tier-0 static syntax-highlighting plugin (codeHighlight.ts).
 *
 * The plugin renders inline `tok-*` decorations over code-carrying blocks by
 * running lazily-loaded lezer grammars. Grammar loading is genuinely async
 * (dynamic import + a `grammar-ready` meta recompute), so most assertions wait
 * for the spans to appear rather than expecting them on first paint.
 *
 * @feat code-highlight: proves the decoration plugin colors code, recomputes
 * when a grammar arrives, re-parses only changed blocks, and honors the size valve
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { parser as pythonParser } from "@lezer/python";

import { schema } from "../schema";
import { codeHighlightPlugin } from "../codeHighlight";

// `parse` lives on a shared lezer base prototype; find and spy on the owner so
// call counts reflect every code block re-parsed by the plugin.
type Parseable = { parse: (...args: unknown[]) => unknown };
function parserProtoWithParse(): Parseable {
  let proto: object | null = pythonParser;
  while (proto && !Object.getOwnPropertyDescriptor(proto, "parse")) {
    proto = Object.getPrototypeOf(proto);
  }
  if (!proto) throw new Error("could not locate parser.parse");
  return proto as unknown as Parseable;
}

const mounted: EditorView[] = [];

function mount(doc: import("prosemirror-model").Node): EditorView {
  const state = EditorState.create({ doc, plugins: [codeHighlightPlugin()] });
  const place = document.createElement("div");
  place.className = "editor-host";
  document.body.appendChild(place);
  const view = new EditorView(place, { state });
  mounted.push(view);
  return view;
}

function codeBlock(language: string | null, text: string) {
  return schema.node("code_block", { language }, schema.text(text));
}

function docWith(...blocks: import("prosemirror-model").Node[]) {
  return schema.node("doc", null, blocks);
}

/** Wait until at least one element matching `sel` is present under the view. */
async function waitForSel(view: EditorView, sel: string): Promise<Element> {
  return vi.waitFor(() => {
    const el = view.dom.querySelector(sel);
    if (!el) throw new Error(`no ${sel} yet`);
    return el;
  });
}

afterEach(() => {
  for (const v of mounted.splice(0)) {
    v.destroy();
    v.dom.parentElement?.remove();
  }
  vi.restoreAllMocks();
});

describe("codeHighlight tier-0 plugin", () => {
  it("colors a python block once its grammar loads", async () => {
    const view = mount(docWith(codeBlock("python", "def foo():\n    return 1")));
    const kw = await waitForSel(view, "span.tok-keyword");
    // First keyword in `def foo(): return 1` is `def`.
    expect(kw.textContent).toBe("def");
    // `1` is a number token.
    expect(view.dom.querySelector("span.tok-number")?.textContent).toBe("1");
  });

  it("colors a sql_block as SQL with no language attr involved", async () => {
    const doc = docWith(
      schema.node("sql_block", { db: null }, schema.text("SELECT id FROM t")),
    );
    const view = mount(doc);
    const kw = await waitForSel(view, "span.tok-keyword");
    expect(kw.textContent).toBe("SELECT");
  });

  it("renders an unknown language plain, with no tok-* spans", async () => {
    const view = mount(docWith(codeBlock("brainfuck", "def foo(): pass")));
    // Give any (erroneous) async load a chance to resolve.
    await new Promise((r) => setTimeout(r, 30));
    expect(view.dom.querySelector("[class^='tok-'], [class*=' tok-']")).toBeNull();
    // The plain text still renders.
    expect(view.dom.querySelector("pre")?.textContent).toBe("def foo(): pass");
  });

  it("recomputes when the grammar arrives late (plain first, then colored)", async () => {
    const view = mount(docWith(codeBlock("python", "def late():\n    return 0")));
    // Synchronously after mount the grammar is not loaded yet.
    expect(view.dom.querySelector("span.tok-keyword")).toBeNull();
    // After the async load + grammar-ready recompute, the spans appear.
    const kw = await waitForSel(view, "span.tok-keyword");
    expect(kw.textContent).toBe("def");
  });

  it("re-parses only the edited block, not its cached sibling", async () => {
    const view = mount(
      docWith(
        codeBlock("python", "def a():\n    return 1"),
        codeBlock("python", "def b():\n    return 2"),
      ),
    );
    await waitForSel(view, "span.tok-keyword");

    // Spy only for the edit — the initial build already parsed both blocks.
    const spy = vi.spyOn(parserProtoWithParse(), "parse");

    // Locate the second code block and type inside it.
    let bPos = -1;
    view.state.doc.forEach((node, offset, index) => {
      if (index === 1) bPos = offset;
    });
    expect(bPos).toBeGreaterThan(0);
    view.dispatch(view.state.tr.insertText("x", bPos + 2));

    // Exactly one re-parse (block B); block A stays cached.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not re-parse when editing outside any code block", async () => {
    const view = mount(
      docWith(
        schema.node("paragraph", null, schema.text("hello")),
        codeBlock("python", "def a():\n    return 1"),
      ),
    );
    await waitForSel(view, "span.tok-keyword");
    const spy = vi.spyOn(parserProtoWithParse(), "parse");
    // Type into the leading paragraph (position 1 is inside it).
    view.dispatch(view.state.tr.insertText("!", 1));
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips highlighting a block larger than the size valve", async () => {
    const spy = vi.spyOn(parserProtoWithParse(), "parse");
    const huge = "if x:\n    pass\n".repeat(5_000); // ~70k chars, over the 50k valve
    const view = mount(docWith(codeBlock("python", huge)));
    await new Promise((r) => setTimeout(r, 30));
    expect(view.dom.querySelector("span.tok-keyword")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
