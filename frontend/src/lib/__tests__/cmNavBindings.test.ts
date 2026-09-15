/**
 * `cmNavBindings`: the PM-nav / PM-history CodeMirror bindings shared by
 * `codeBlockView` and `cmTextSurface` (plans/shortcuts ticket 05). Dispatch
 * behaviour is covered by codeBlockCm / sqlBlockCm; this pins the binding list
 * so the extraction stays byte-for-byte equivalent.
 */
import { describe, it, expect, vi } from "vitest";
import { redo, undo } from "prosemirror-history";

import { cmNavBindings, type CmNavHost } from "../cmNavBindings";

function host(): CmNavHost & { [K in keyof CmNavHost]: ReturnType<typeof vi.fn> } {
  return {
    maybeEscape: vi.fn(() => true),
    selectBlockNode: vi.fn(() => true),
    runPm: vi.fn(() => true),
  };
}

// `run` ignores its CM view argument; a placeholder satisfies the type.
const cmView = {} as Parameters<NonNullable<ReturnType<typeof cmNavBindings>[number]["run"]>>[0];

describe("cmNavBindings", () => {
  it("returns exactly the eight nav/history keys, in order", () => {
    expect(cmNavBindings(host()).map((b) => b.key)).toEqual([
      "ArrowUp",
      "ArrowLeft",
      "ArrowDown",
      "ArrowRight",
      "Escape",
      "Mod-z",
      "Mod-y",
      "Mod-Shift-z",
    ]);
  });

  it("arrows call maybeEscape with unit + direction", () => {
    const h = host();
    const b = cmNavBindings(h);
    b[0].run!(cmView);
    b[1].run!(cmView);
    b[2].run!(cmView);
    b[3].run!(cmView);
    expect(h.maybeEscape.mock.calls).toEqual([
      ["line", -1],
      ["char", -1],
      ["line", 1],
      ["char", 1],
    ]);
  });

  it("Escape selects the block node; history keys forward to PM", () => {
    const h = host();
    const byKey = new Map(cmNavBindings(h).map((b) => [b.key, b]));
    byKey.get("Escape")!.run!(cmView);
    expect(h.selectBlockNode).toHaveBeenCalledOnce();
    byKey.get("Mod-z")!.run!(cmView);
    expect(h.runPm).toHaveBeenLastCalledWith(undo);
    byKey.get("Mod-y")!.run!(cmView);
    expect(h.runPm).toHaveBeenLastCalledWith(redo);
    byKey.get("Mod-Shift-z")!.run!(cmView);
    expect(h.runPm).toHaveBeenLastCalledWith(redo);
  });

  it("keeps Cmd-Y redo on mac (Mod-y with an explicit Cmd-y mac key)", () => {
    // CM resolves `mac` at @codemirror/view import, so assert on the binding.
    const modY = cmNavBindings(host()).find((b) => b.key === "Mod-y")!;
    expect(modY.mac).toBe("Cmd-y");
  });
});
