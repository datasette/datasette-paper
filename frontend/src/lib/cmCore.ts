/**
 * The single import chokepoint for `@codemirror/*` core packages — see
 * plans/codemirror/02-design.md §4. Nothing else in the repo may import
 * `@codemirror/view` / `state` / `language` / `commands` / `autocomplete`
 * (enforced by the `no-restricted-imports` override in eslint.config.js;
 * languages.ts is the only other exemption, for its lazy `@codemirror/lang-*`
 * grammar loaders). Keeping the whole CM6 core behind one dynamic import is
 * what makes it a single lazy chunk absent from the entry bundle, and it is
 * the documented seam for a future swap to a Datasette-core-provided CM setup.
 *
 * `loadCmCore()` memoizes the dynamic import (the `mdParser` loader shape,
 * collab.ts) and resolves a `CmCore` bundle of the classes/helpers consumers
 * need plus `baseExtensions()`. `loadedCmCore()` exposes the resolved value
 * synchronously (null until the first load settles) so a NodeView rebuilt in
 * CM mode can construct its editor without awaiting.
 *
 * `baseExtensions()` is the minimal editing surface: bracket matching, close
 * brackets, a two-space indent unit, `syntaxHighlighting(classHighlighter)`
 * (the same `tok-*` classes tier-0 emits, so the mode swap is color-stable),
 * an injected PM-navigation keymap ahead of the indent/newline keymap, and an
 * `EditorView.theme` reading the `--pp-*` vars so the CM surface is
 * pixel-identical to editor.css's `pre` (same font stack/size/line-height/
 * padding/border/background). No gutter, no active-line highlight, no search.
 */
import type { EditorView, KeyBinding, ViewUpdate } from "@codemirror/view";
import type { Compartment, Extension } from "@codemirror/state";
import type { LanguageSupport } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";

export type { EditorView, KeyBinding, ViewUpdate, Compartment, Extension, LanguageSupport };

type ViewMod = typeof import("@codemirror/view");
type StateMod = typeof import("@codemirror/state");

/** Config for `baseExtensions`: PM-facing key bindings (arrow-escape, PM
 * undo/redo, the double-Enter-at-doc-end escape) that must win over CM's own
 * indent/newline keymap, so they're installed at higher precedence. `extra`
 * extensions (e.g. the SQL completion bundle) sit just below that keymap and
 * above the indent/newline handlers, so a completion keymap can accept on
 * Tab/Enter when the popup is open yet fall through to indent otherwise. */
export interface BaseExtensionsConfig {
  keymap: KeyBinding[];
  extra?: Extension[];
}

/** The resolved CM core surface every consumer works through. */
export interface CmCore {
  EditorView: ViewMod["EditorView"];
  EditorState: StateMod["EditorState"];
  EditorSelection: StateMod["EditorSelection"];
  Compartment: StateMod["Compartment"];
  Annotation: StateMod["Annotation"];
  /** Annotation tagging a CM change as originating from PM (a remote collab
   * step or the picker), so the update listener doesn't echo it back. */
  fromPM: ReturnType<StateMod["Annotation"]["define"]>;
  baseExtensions(config: BaseExtensionsConfig): Extension[];
  /** The autocomplete surface (popup + its accept/navigate keymap). The
   * completion *source* rides the mounted language's data (lang-sql attaches
   * keyword/function completion to the SQLite dialect), so this just turns the
   * machinery on — pass it via `baseExtensions`'s `extra`. */
  completion(): Extension[];
}

let coreValue: CmCore | null = null;
let corePromise: Promise<CmCore> | null = null;

// @feat code-cm-focus: the only @codemirror/* core import site — one memoized
// dynamic import behind which CM6 (view/state/language/commands/autocomplete)
// lives as a single lazy chunk, re-exported as the CmCore surface
export function loadCmCore(): Promise<CmCore> {
  if (coreValue) return Promise.resolve(coreValue);
  if (!corePromise) {
    corePromise = Promise.all([
      import("@codemirror/view"),
      import("@codemirror/state"),
      import("@codemirror/language"),
      import("@codemirror/commands"),
      import("@codemirror/autocomplete"),
    ]).then(
      ([view, state, language, commands, autocomplete]) => {
        coreValue = buildCore(view, state, language, commands, autocomplete);
        corePromise = null;
        return coreValue;
      },
      (err) => {
        corePromise = null;
        throw err;
      },
    );
  }
  return corePromise;
}

/** The resolved core, or null if `loadCmCore()` hasn't settled yet. */
export function loadedCmCore(): CmCore | null {
  return coreValue;
}

function buildCore(
  view: ViewMod,
  state: StateMod,
  language: typeof import("@codemirror/language"),
  commands: typeof import("@codemirror/commands"),
  autocomplete: typeof import("@codemirror/autocomplete"),
): CmCore {
  const { EditorView } = view;
  const fromPM = state.Annotation.define<boolean>();

  // Pixel-parity with editor.css's `.editor-host .ProseMirror pre` (the
  // static code_block surface): same mono stack, 0.9em size, 1.5 line-height,
  // 10px/12px padding, 6px-radius --pp-border box on --pp-surface. Selection
  // uses the shared --pp-selection tint; caret uses the body text color. No
  // gutter/active-line/scroller shadow — the theme deliberately zeroes CM's
  // defaults so the swap doesn't shift a pixel.
  const theme = EditorView.theme({
    "&": {
      background: "var(--pp-surface)",
      color: "var(--pp-fg)",
      border: "1px solid var(--pp-border)",
      borderRadius: "6px",
      fontSize: "0.9em",
      margin: "0 0 0.75em",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      lineHeight: "1.5",
      overflowX: "auto",
    },
    ".cm-content": { padding: "10px 12px", caretColor: "var(--pp-fg)" },
    ".cm-line": { padding: "0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--pp-fg)" },
    ".cm-content ::selection": { background: "var(--pp-selection)" },
  });

  function baseExtensions(config: BaseExtensionsConfig): Extension[] {
    return [
      // PM-navigation bindings first (highest precedence) so arrow-at-edge,
      // Escape and PM undo/redo win over CM's own indent/newline handlers.
      view.keymap.of(config.keymap),
      // Consumer extras (e.g. SQL completion) — above indent/newline so the
      // completion keymap can claim Tab/Enter while the popup is open.
      ...(config.extra ?? []),
      language.bracketMatching(),
      autocomplete.closeBrackets(),
      language.indentUnit.of("  "),
      language.syntaxHighlighting(classHighlighter),
      view.keymap.of([
        ...autocomplete.closeBracketsKeymap,
        { key: "Tab", run: commands.indentMore, shift: commands.indentLess },
        { key: "Enter", run: commands.insertNewlineAndIndent },
      ]),
      theme,
    ];
  }

  function completion(): Extension[] {
    return [autocomplete.autocompletion(), view.keymap.of(autocomplete.completionKeymap)];
  }

  return {
    EditorView,
    EditorState: state.EditorState,
    EditorSelection: state.EditorSelection,
    Compartment: state.Compartment,
    Annotation: state.Annotation,
    fromPM,
    baseExtensions,
    completion,
  };
}
