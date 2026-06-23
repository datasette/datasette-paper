/**
 * NodeView tests for inline_embed: the inline pill renders ok / loading /
 * denied / not_found, never leaking a label on denied/not_found.
 */
import { describe, it, expect } from "vitest";
import type { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import { DatasetteRefView } from "../datasetteRefView";
import type { DatasetteResolver, DatasetteStatus } from "../datasetteResolver";

function fakeResolver(status: DatasetteStatus): DatasetteResolver {
  return {
    request(_ref: string, cb: (s: DatasetteStatus) => void) {
      cb(status);
      return () => {};
    },
    dispose() {},
  } as unknown as DatasetteResolver;
}

function build(ref: string | null, status: DatasetteStatus): DatasetteRefView {
  const node = schema.nodes.inline_embed.create({ ref });
  return new DatasetteRefView(
    node,
    {} as unknown as EditorView,
    () => 0,
    fakeResolver(status),
  );
}

describe("DatasetteRefView", () => {
  it("renders ok with label, icon, and href", () => {
    const view = build("/fixtures/facetable", {
      status: "ok",
      kind: "table",
      label: "facetable",
      href: "/fixtures/facetable",
    });
    expect(view.dom.getAttribute("href")).toBe("/fixtures/facetable");
    expect(view.dom.textContent).toContain("facetable");
    expect(view.dom.querySelector("svg")).not.toBeNull();
  });

  it("prefixes a table ref with its database (db/table)", () => {
    const view = build("/transcript/entries", {
      status: "ok",
      kind: "table",
      label: "entries",
      db: "transcript",
      href: "/transcript/entries",
    });
    expect(view.dom.textContent).toContain("transcript/entries");
  });

  it("prefixes a view ref with its database too", () => {
    const view = build("/transcript/recent", {
      status: "ok",
      kind: "view",
      label: "recent",
      db: "transcript",
      href: "/transcript/recent",
    });
    expect(view.dom.textContent).toContain("transcript/recent");
  });

  it("renders a row ref as database/table/pk", () => {
    const view = build("/transcript/entries/2", {
      status: "ok",
      kind: "row",
      label: "speaker_1",
      db: "transcript",
      table: "entries",
      pk: "2",
      href: "/transcript/entries/2",
    });
    expect(view.dom.textContent).toContain("transcript/entries/2");
    // The human row label is not what's shown.
    expect(view.dom.textContent).not.toContain("speaker_1");
  });

  it("does not prefix a bare database ref with itself", () => {
    const view = build("/transcript", {
      status: "ok",
      kind: "database",
      label: "transcript",
      db: "transcript",
      href: "/transcript",
    });
    expect(view.dom.textContent).not.toContain("transcript/transcript");
    expect(view.dom.textContent).toContain("transcript");
  });

  it("renders denied without the resource label", () => {
    const view = build("/fixtures/secret", { status: "denied" });
    expect(view.dom.classList.contains("pm-datasette-ref--denied")).toBe(true);
    expect(view.dom.hasAttribute("href")).toBe(false);
    expect(view.dom.textContent).toContain("Permission denied");
  });

  it("renders not_found as the raw ref, struck through, no href", () => {
    const view = build("/fixtures/nope", { status: "not_found" });
    expect(view.dom.classList.contains("pm-datasette-ref--missing")).toBe(true);
    expect(view.dom.hasAttribute("href")).toBe(false);
    expect(view.dom.textContent).toBe("/fixtures/nope");
  });

  it("renders loading as the raw ref, muted, no href", () => {
    const view = build("/fixtures/facetable", { status: "loading" });
    expect(view.dom.classList.contains("pm-datasette-ref--loading")).toBe(true);
    expect(view.dom.hasAttribute("href")).toBe(false);
    expect(view.dom.textContent).toBe("/fixtures/facetable");
  });

  it("re-subscribes when the ref attr changes", () => {
    const view = build("/fixtures/a", {
      status: "ok",
      kind: "table",
      label: "a",
      href: "/fixtures/a",
    });
    // Swap in a resolver that resolves the new ref to a different label.
    (view as unknown as { resolver: DatasetteResolver }).resolver = fakeResolver({
      status: "ok",
      kind: "view",
      label: "b-view",
      href: "/fixtures/b",
    });
    const next = schema.nodes.inline_embed.create({ ref: "/fixtures/b" });
    expect(view.update(next)).toBe(true);
    expect(view.dom.textContent).toContain("b-view");
    expect(view.dom.getAttribute("href")).toBe("/fixtures/b");
  });
});
