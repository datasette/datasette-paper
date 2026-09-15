/**
 * The PM-navigation / PM-history CodeMirror bindings shared by every CM surface
 * mounted inside a ProseMirror NodeView (`codeBlockView.ts`, `cmTextSurface.ts`):
 * arrows exit the block at the CM doc edge, Escape selects the block node, and
 * undo/redo forward to PM history (CM's own history extension is not installed).
 *
 * Its own module rather than `cmTextSurface.ts`: that file already imports
 * `computeChange` from `codeBlockView.ts`, so hosting the helper there would
 * make the two import each other.
 *
 * The history chords are literal on purpose: `Mod-y` is an alternate redo and
 * not a display-registry entry (plans/shortcuts design §5.2).
 */
import type { Command } from "prosemirror-state";
import { redo, undo } from "prosemirror-history";
import type { KeyBinding } from "./cmCore";

export interface CmNavHost {
  /** Exit to the adjacent PM position when the CM caret is at the doc edge. */
  maybeEscape(unit: "line" | "char", dir: -1 | 1): boolean;
  /** Select the whole block node in PM. */
  selectBlockNode(): boolean;
  /** Run a PM command against the host view. */
  runPm(command: Command): boolean;
}

export function cmNavBindings(host: CmNavHost): KeyBinding[] {
  return [
    { key: "ArrowUp", run: () => host.maybeEscape("line", -1) },
    { key: "ArrowLeft", run: () => host.maybeEscape("char", -1) },
    { key: "ArrowDown", run: () => host.maybeEscape("line", 1) },
    { key: "ArrowRight", run: () => host.maybeEscape("char", 1) },
    { key: "Escape", run: () => host.selectBlockNode() },
    { key: "Mod-z", run: () => host.runPm(undo) },
    // On mac `Mod-y` already means Cmd-y; the explicit `mac` keeps Cmd-Y redo
    // unmistakable (plans/shortcuts design §6: unchanged behaviour).
    { key: "Mod-y", run: () => host.runPm(redo), mac: "Cmd-y" },
    { key: "Mod-Shift-z", run: () => host.runPm(redo) },
  ];
}
