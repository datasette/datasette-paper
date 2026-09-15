/**
 * Boundary B1, mac half (plans/shortcuts design §5.4): prosemirror-keymap and
 * prosemirror-example-setup sniff `navigator.platform` once, at import. jsdom
 * reports "" (non-mac), and they're externalized deps, so `vi.resetModules()`
 * can't re-run the sniff — the stub is hoisted above every import instead, in
 * this file alone (vitest isolates files, so nothing else sees MacIntel).
 *
 * Pins: on mac, Cmd-z undoes, Cmd-y is NOT bound in prose (buildKeymap only
 * adds `Mod-y` off-mac), and Shift-Cmd-z redoes.
 */
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { buildKeymap } from "prosemirror-example-setup";
import { history } from "prosemirror-history";
import { schema } from "../schema";
import { IS_MAC } from "../platform";

function keydown(view: EditorView, init: KeyboardEventInit): boolean {
  const evt = new KeyboardEvent("keydown", init);
  return !!view.someProp("handleKeyDown", (fn) => fn(view, evt));
}

describe("B1: Mod resolves per platform at import time (mac half)", () => {
  it("app IS_MAC agrees with the stubbed platform", () => {
    expect(IS_MAC).toBe(true);
  });

  it("Cmd-z undoes, Cmd-y is not handled, Shift-Cmd-z redoes", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("Hello")]),
    ]);
    let st = EditorState.create({
      doc,
      plugins: [history(), keymap(buildKeymap(schema))],
    });
    st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 6)));
    const place = document.createElement("div");
    document.body.appendChild(place);
    const v = new EditorView(place, { state: st });
    v.dispatch(v.state.tr.insertText("!"));

    expect(keydown(v, { key: "z", keyCode: 90, metaKey: true })).toBe(true);
    expect(v.state.doc.textContent).toBe("Hello");
    expect(keydown(v, { key: "y", keyCode: 89, metaKey: true })).toBe(false);
    expect(v.state.doc.textContent).toBe("Hello");
    expect(keydown(v, { key: "Z", keyCode: 90, metaKey: true, shiftKey: true })).toBe(true);
    expect(v.state.doc.textContent).toBe("Hello!");
    v.destroy();
  });
});
