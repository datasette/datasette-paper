/**
 * Tests for MentionView — the inline-atom NodeView that renders an @-mention
 * as an anchor to the actor's profile page, with the display name resolved
 * via the ActorResolver. Click navigation is suppressed in edit mode (place
 * the selection instead) but allowed in view mode / on a modifier-click.
 */

import { describe, it, expect } from "vitest";
import { NodeSelection, Selection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import { MentionView, profileHref } from "../mentionView";
import type { ActorResolver, ActorStatus } from "../actorResolver";

function stubResolver(status: ActorStatus): ActorResolver {
  return {
    request(_actorId: string, cb: (s: ActorStatus) => void) {
      cb(status);
      return () => {};
    },
  } as unknown as ActorResolver;
}

// doc(paragraph(mention)) — the mention sits at pos 1.
const MENTION_POS = 1;

function buildView(
  actorId: string | null,
  editable: boolean,
  status: ActorStatus = { status: "ok", name: "Alex", avatarUrl: null },
  { selected = false }: { selected?: boolean } = {},
): MentionView {
  const node = schema.nodes.mention.create({ actorId });
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, [node]),
  ]);
  const selection = selected
    ? NodeSelection.create(doc, MENTION_POS)
    : Selection.atStart(doc);
  return new MentionView(
    node,
    { editable, state: { selection } } as unknown as EditorView,
    () => MENTION_POS,
    stubResolver(status),
  );
}

/** Dispatch the mousedown → click pair a real click produces. */
function clickOn(view: MentionView): MouseEvent {
  view.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  const event = new MouseEvent("click", { cancelable: true, bubbles: true });
  view.dom.dispatchEvent(event);
  return event;
}

describe("profileHref", () => {
  it("builds the profile-page href and percent-encodes the id", () => {
    expect(profileHref("alex")).toBe("/-/profile/alex");
    expect(profileHref("a/b@c")).toBe("/-/profile/a%2Fb%40c");
  });
});

// @feat mention: chip is an anchor to the actor's profile page
describe("MentionView", () => {
  it("renders the chip with @name text and an href to the profile page", () => {
    const view = buildView("alex", false);
    expect(view.dom.tagName).toBe("A");
    expect(view.dom.classList.contains("pm-mention")).toBe(true);
    expect(view.dom.textContent).toBe("@Alex");
    expect(view.dom.getAttribute("href")).toBe("/-/profile/alex");
    expect(view.dom.getAttribute("data-mention")).toBe("alex");
  });

  it("keeps the href while the name is still loading", () => {
    const view = buildView("alex", false, { status: "loading" });
    expect(view.dom.textContent).toBe("@alex");
    expect(view.dom.getAttribute("href")).toBe("/-/profile/alex");
  });

  it("renders no href for a null actorId", () => {
    const view = buildView(null, false);
    expect(view.dom.textContent).toBe("@?");
    expect(view.dom.hasAttribute("href")).toBe(false);
  });

  it("view mode: a plain click is NOT prevented (browser navigates)", () => {
    const view = buildView("alex", false);
    expect(clickOn(view).defaultPrevented).toBe(false);
  });

  it("edit mode: a plain click IS prevented (select, don't navigate)", () => {
    const view = buildView("alex", true);
    expect(clickOn(view).defaultPrevented).toBe(true);
  });

  it("edit mode: a modifier click still navigates (not prevented)", () => {
    const view = buildView("alex", true);
    view.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const event = new MouseEvent("click", {
      cancelable: true,
      bubbles: true,
      metaKey: true,
    });
    view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("edit mode: a click on an already-selected pill navigates (not prevented)", () => {
    const view = buildView("alex", true, undefined, { selected: true });
    expect(clickOn(view).defaultPrevented).toBe(false);
  });

  it("update() re-points the href when the actorId changes", () => {
    const view = buildView("alex", false);
    const next = schema.nodes.mention.create({ actorId: "sam" });
    expect(view.update(next)).toBe(true);
    expect(view.dom.getAttribute("href")).toBe("/-/profile/sam");
    expect(view.dom.getAttribute("data-mention")).toBe("sam");
  });

  it("update() rejects a node of a different type", () => {
    const view = buildView("alex", false);
    const para = schema.nodes.paragraph.create();
    expect(view.update(para)).toBe(false);
  });
});
