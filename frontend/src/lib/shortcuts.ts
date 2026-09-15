/**
 * Display registry for keyboard shortcuts: one entry per user-facing command
 * that shows a hint, holding only the primary chord we display. It is NOT a
 * binding inventory — alternate chords (`Mod-y` redo, `Mod-Enter` hard break,
 * Tab indent), platform-restricted chords and navigation/editing keys stay
 * with the keymap that dispatches them.
 *
 * `owner: "paper"` entries are bound by our own keymaps reading
 * `SHORTCUTS.x.key`, so editing the key changes behaviour and hint together.
 * `owner: "upstream"` entries only DESCRIBE a prosemirror-example-setup
 * `buildKeymap` default: editing the key changes only the hint, and the
 * binding test (`__tests__/shortcutBindings.test.ts`) fails until the binding
 * is changed too (via `buildKeymap(schema, mapKeys)`).
 *
 * Imports only `./platform` (no prosemirror, no schema) so Svelte and
 * plain-DOM callers can import it cheaply.
 */
import { IS_MAC } from "./platform";

// @feat shortcuts: the registry — primary chord per hinted command + hint/aria formatters

export interface ShortcutDef {
  /** Displayed chord, prosemirror-keymap / CodeMirror syntax. */
  key: string;
  /** Human name (future shortcuts sheet; not used for aria-label). */
  label: string;
  /** Which dispatcher binds it: "prose" = ProseMirror keymaps in collab.ts,
   *  "sql" = the CodeMirror SQL surfaces. Behaviour tests partition on this. */
  surface: "prose" | "sql";
  /** Who owns the binding:
   *  "paper"  — our keymap binds `SHORTCUTS.x.key` directly; editing the
   *             registry changes behaviour.
   *  "upstream" — describes a default from prosemirror-example-setup's
   *             buildKeymap; editing the registry changes ONLY the hint, and
   *             the behaviour test fails until the binding is changed too
   *             (via buildKeymap's mapKeys). */
  owner: "paper" | "upstream";
}

export const SHORTCUTS = {
  undo: { key: "Mod-z", label: "Undo", surface: "prose", owner: "upstream" },
  redo: {
    key: "Shift-Mod-z",
    label: "Redo",
    surface: "prose",
    owner: "upstream",
  },
  bold: { key: "Mod-b", label: "Bold", surface: "prose", owner: "upstream" },
  italic: {
    key: "Mod-i",
    label: "Italic",
    surface: "prose",
    owner: "upstream",
  },
  code: {
    key: "Mod-`",
    label: "Inline code",
    surface: "prose",
    owner: "upstream",
  },
  strike: {
    key: "Mod-Shift-x",
    label: "Strikethrough",
    surface: "prose",
    owner: "paper",
  },
  highlight: {
    key: "Mod-Shift-h",
    label: "Highlight",
    surface: "prose",
    owner: "paper",
  },
  link: { key: "Mod-k", label: "Link", surface: "prose", owner: "paper" },
  paragraph: {
    key: "Shift-Ctrl-0",
    label: "Text",
    surface: "prose",
    owner: "upstream",
  },
  heading1: {
    key: "Shift-Ctrl-1",
    label: "Heading 1",
    surface: "prose",
    owner: "upstream",
  },
  heading2: {
    key: "Shift-Ctrl-2",
    label: "Heading 2",
    surface: "prose",
    owner: "upstream",
  },
  heading3: {
    key: "Shift-Ctrl-3",
    label: "Heading 3",
    surface: "prose",
    owner: "upstream",
  },
  blockquote: {
    key: "Ctrl->",
    label: "Quote",
    surface: "prose",
    owner: "upstream",
  },
  codeBlock: {
    key: "Shift-Ctrl-\\",
    label: "Code block",
    surface: "prose",
    owner: "upstream",
  },
  bulletList: {
    key: "Shift-Ctrl-8",
    label: "Bullet list",
    surface: "prose",
    owner: "upstream",
  },
  orderedList: {
    key: "Shift-Ctrl-9",
    label: "Numbered list",
    surface: "prose",
    owner: "upstream",
  },
  taskList: {
    key: "Mod-Shift-7",
    label: "Task list",
    surface: "prose",
    owner: "paper",
  },
  indent: {
    key: "Mod-]",
    label: "Indent",
    surface: "prose",
    owner: "paper",
  },
  outdent: {
    key: "Mod-[",
    label: "Outdent",
    surface: "prose",
    owner: "paper",
  },
  dateToday: {
    key: "Mod-;",
    label: "Insert today's date",
    surface: "prose",
    owner: "paper",
  },
  dateTomorrow: {
    key: "Mod-Shift-;",
    label: "Insert tomorrow's date",
    surface: "prose",
    owner: "paper",
  },
  divider: {
    key: "Mod-_",
    label: "Divider",
    surface: "prose",
    owner: "upstream",
  },
  runQuery: {
    key: "Mod-Enter",
    label: "Run query",
    surface: "sql",
    owner: "paper",
  },
} as const satisfies Record<string, ShortcutDef>;

export type ShortcutId = keyof typeof SHORTCUTS;

export interface ParsedShortcut {
  /** Base key name, e.g. "x", ">", "Enter", " " (for `Space`). */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** `Mod` — Meta on mac, Ctrl elsewhere; resolved by the formatter. */
  mod: boolean;
}

/** Parse a prosemirror-keymap chord. Mirrors `normalizeKeyName` in
 *  `prosemirror-keymap/dist/index.js` (split on `-` not at the end, so `Mod-_`
 *  and `Mod--` work; same modifier regexes; throws on an unknown modifier),
 *  but keeps `mod` unresolved. */
export function parseShortcut(key: string): ParsedShortcut {
  const parts = key.split(/-(?!$)/);
  let base = parts[parts.length - 1];
  if (base === "Space") base = " ";
  const out: ParsedShortcut = {
    key: base,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    mod: false,
  };
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i];
    if (/^(cmd|meta|m)$/i.test(m)) out.meta = true;
    else if (/^a(lt)?$/i.test(m)) out.alt = true;
    else if (/^(c|ctrl|control)$/i.test(m)) out.ctrl = true;
    else if (/^s(hift)?$/i.test(m)) out.shift = true;
    else if (/^mod$/i.test(m)) out.mod = true;
    else throw new Error("Unrecognized modifier name: " + m);
  }
  return out;
}

/** Resolve `mod` for the given platform. */
function resolved(key: string, mac: boolean) {
  const p = parseShortcut(key);
  return {
    key: p.key,
    ctrl: p.ctrl || (p.mod && !mac),
    alt: p.alt,
    shift: p.shift,
    meta: p.meta || (p.mod && mac),
  };
}

const ARROWS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function displayKey(key: string, mac: boolean): string {
  if (Object.hasOwn(ARROWS, key)) return ARROWS[key];
  if (key === " ") return "Space";
  if (mac && key === "Enter") return "↵";
  if (mac && key === "Tab") return "⇥";
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Platform-correct hint text: `⇧⌘X` on mac (Apple order ⌃⌥⇧⌘, no
 *  separator), `Ctrl+Shift+X` elsewhere (Ctrl Alt Shift Meta, `+`-joined). */
export function formatShortcut(key: string, mac: boolean = IS_MAC): string {
  const r = resolved(key, mac);
  const k = displayKey(r.key, mac);
  if (mac) {
    return (
      (r.ctrl ? "⌃" : "") +
      (r.alt ? "⌥" : "") +
      (r.shift ? "⇧" : "") +
      (r.meta ? "⌘" : "") +
      k
    );
  }
  const mods: string[] = [];
  if (r.ctrl) mods.push("Ctrl");
  if (r.alt) mods.push("Alt");
  if (r.shift) mods.push("Shift");
  if (r.meta) mods.push("Meta");
  return [...mods, k].join("+");
}

/** `aria-keyshortcuts` value (WAI-ARIA modifier names): `Meta+Shift+X` on
 *  mac, `Control+Shift+X` elsewhere. Order: Control, Meta, Alt, Shift (the
 *  `Mod` key leads on both platforms). */
export function ariaKeyshortcuts(key: string, mac: boolean = IS_MAC): string {
  const r = resolved(key, mac);
  const mods: string[] = [];
  if (r.ctrl) mods.push("Control");
  if (r.meta) mods.push("Meta");
  if (r.alt) mods.push("Alt");
  if (r.shift) mods.push("Shift");
  const k =
    r.key === " " ? "Space" : r.key.length === 1 ? r.key.toUpperCase() : r.key;
  return [...mods, k].join("+");
}

/** `"Bold (⌘B)"` — a title/tooltip with the registry chord appended. */
export function titleWithShortcut(
  name: string,
  id: ShortcutId,
  mac: boolean = IS_MAC,
): string {
  return `${name} (${formatShortcut(SHORTCUTS[id].key, mac)})`;
}
