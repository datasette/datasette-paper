/**
 * Tests for PaperLinkView — the inline-atom NodeView that renders a
 * `paper_link` by resolving its `docId` through the LinkResolver. Each test
 * uses a tiny FAKE resolver that emits a single status synchronously, so the
 * render branches can be asserted without any fetch/timer machinery. The
 * final case is pure schema/command behavior (Backspace deletes the atom as
 * a unit) and needs no NodeView.
 */

import { describe, it, expect } from "vitest";
import { EditorState, NodeSelection } from "prosemirror-state";
import { deleteSelection } from "prosemirror-commands";
import type { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import { PaperLinkView } from "../paperLinkView";
import type { LinkResolver, LinkStatus } from "../linkResolver";

function fakeResolver(status: LinkStatus): LinkResolver {
  return {
    request(_id: number, cb: (s: LinkStatus) => void) {
      cb(status);
      return () => {};
    },
    dispose() {},
  } as unknown as LinkResolver;
}

function buildView(docId: number | null, status: LinkStatus): PaperLinkView {
  const node = schema.nodes.paper_link.create({ docId });
  return new PaperLinkView(
    node,
    {} as unknown as EditorView,
    () => 0,
    fakeResolver(status),
  );
}

describe("PaperLinkView", () => {
  it("ok/active: renders the title with an href and no modifier class", () => {
    const view = buildView(7, {
      status: "ok",
      title: "My Title",
      state: "active",
      kind: "doc",
      href: "/-/paper/doc/7",
    });
    expect(view.dom.textContent).toContain("My Title");
    expect(view.dom.getAttribute("href")).toBe("/-/paper/doc/7");
    expect(view.dom.className).toBe("pm-paper-link");
  });

  it("ok/archived: archive modifier, keeps href + title", () => {
    const view = buildView(7, {
      status: "ok",
      title: "Archived Doc",
      state: "archived",
      kind: "doc",
      href: "/-/paper/doc/7",
    });
    expect(view.dom.className).toContain("pm-paper-link--archived");
    expect(view.dom.getAttribute("href")).toBe("/-/paper/doc/7");
    expect(view.dom.textContent).toContain("Archived Doc");
  });

  it("ok/trashed: trashed modifier, '(in trash)' suffix, keeps href", () => {
    const view = buildView(7, {
      status: "ok",
      title: "Tossed Doc",
      state: "trashed",
      kind: "doc",
      href: "/-/paper/doc/7",
    });
    expect(view.dom.className).toContain("pm-paper-link--trashed");
    expect(view.dom.textContent).toContain("(in trash)");
    expect(view.dom.getAttribute("href")).toBe("/-/paper/doc/7");
  });

  it("denied: denied modifier, no href, 'Permission denied' text", () => {
    const view = buildView(7, { status: "denied" });
    expect(view.dom.className).toContain("pm-paper-link--denied");
    expect(view.dom.hasAttribute("href")).toBe(false);
    expect(view.dom.textContent).toBe("Permission denied");
  });

  it("denied: never renders a title even if one is sneaked in", () => {
    const view = buildView(7, {
      status: "denied",
      title: "SECRET",
    } as unknown as LinkStatus);
    expect(view.dom.textContent).not.toContain("SECRET");
  });

  it("not_found: missing modifier, no href, shows the id (not a title)", () => {
    const view = buildView(7, { status: "not_found" });
    expect(view.dom.className).toContain("pm-paper-link--missing");
    expect(view.dom.hasAttribute("href")).toBe(false);
    expect(view.dom.textContent).toContain("Paper #7");
  });

  it("Backspace deletes the paper_link node as a unit", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.nodes.paper_link.create({ docId: 7 }),
      ]),
    ]);
    let state = EditorState.create({ doc });
    // Sanity-check the node sits at position 1.
    expect(state.doc.nodeAt(1)?.type.name).toBe("paper_link");
    state = state.apply(
      state.tr.setSelection(NodeSelection.create(state.doc, 1)),
    );
    const ok = deleteSelection(state, (tr) => {
      state = state.apply(tr);
    });
    expect(ok).toBe(true);
    let found = false;
    state.doc.descendants((n) => {
      if (n.type.name === "paper_link") found = true;
    });
    expect(found).toBe(false);
  });
});
