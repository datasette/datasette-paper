/**
 * Tests for TagView — the inline-atom NodeView that renders an inline `#tag`
 * as an anchor to the tag-search results page. The slug is self-describing, so
 * the view is synchronous (no resolver). Click navigation is suppressed in
 * edit mode (place the selection instead) but allowed in view mode / on a
 * modifier-click.
 */

import { describe, it, expect } from "vitest";
import type { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import { TagView, tagHref } from "../tagView";

function buildView(slug: string, editable: boolean): TagView {
  const node = schema.nodes.tag.create({ tag: slug });
  return new TagView(node, { editable } as unknown as EditorView);
}

describe("tagHref", () => {
  it("builds the results-page href and percent-encodes the slug", () => {
    expect(tagHref("alpha")).toBe("/-/paper/tag/alpha");
    expect(tagHref("inbox/to-read")).toBe("/-/paper/tag/inbox%2Fto-read");
  });
});

describe("TagView", () => {
  it("renders the chip with #slug text and an href to the results page", () => {
    const view = buildView("roadmap", false);
    expect(view.dom.tagName).toBe("A");
    expect(view.dom.classList.contains("pm-tag")).toBe(true);
    expect(view.dom.textContent).toBe("#roadmap");
    expect(view.dom.getAttribute("href")).toBe("/-/paper/tag/roadmap");
    expect(view.dom.getAttribute("data-tag")).toBe("roadmap");
  });

  it("view mode: a plain click is NOT prevented (browser navigates)", () => {
    const view = buildView("roadmap", false);
    const event = new MouseEvent("click", { cancelable: true, bubbles: true });
    view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("edit mode: a plain click IS prevented (select, don't navigate)", () => {
    const view = buildView("roadmap", true);
    const event = new MouseEvent("click", { cancelable: true, bubbles: true });
    view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("edit mode: a modifier click still navigates (not prevented)", () => {
    const view = buildView("roadmap", true);
    const event = new MouseEvent("click", {
      cancelable: true,
      bubbles: true,
      metaKey: true,
    });
    view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("update() re-renders when the slug changes", () => {
    const view = buildView("alpha", false);
    const next = schema.nodes.tag.create({ tag: "beta" });
    expect(view.update(next)).toBe(true);
    expect(view.dom.textContent).toBe("#beta");
    expect(view.dom.getAttribute("href")).toBe("/-/paper/tag/beta");
  });

  it("update() rejects a node of a different type", () => {
    const view = buildView("alpha", false);
    const para = schema.nodes.paragraph.create();
    expect(view.update(para)).toBe(false);
  });
});
