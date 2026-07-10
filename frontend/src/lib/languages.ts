/**
 * Curated registry of languages available for `code_block` syntax
 * highlighting and CodeMirror mounts (see plans/codemirror/02-design.md).
 *
 * Each entry owns two independently lazy loaders:
 *
 *   `highlight()` — the bare lezer grammar (tier 0: static decoration,
 *   no `@codemirror/*` in the chunk graph for lezer-native languages).
 *   `cm()` — the full `@codemirror/lang-*` `LanguageSupport` (tier 1: a
 *   live CM mount). Vite shares the underlying parser chunk between the
 *   two, since the `@codemirror/lang-*` wrapper depends on the same
 *   `@lezer/*` parser module.
 *
 * Both loaders are memoized (one in-flight promise per language, then the
 * resolved value forever after) — the same shape as `collab.ts`'s
 * `mdParser` loader — so repeated calls (e.g. from the highlight plugin
 * re-checking an unresolved grammar) never kick off a second import or
 * reconfigure the parser twice.
 *
 * `registerLanguage` is intentionally not exported: the preset list below
 * is the only caller today. It's the seam a future third-party language
 * hook would call (pattern: `embedRegistry.ts`), but no such hook ships
 * yet.
 */
import type { Parser } from "@lezer/common";
import type { LanguageSupport } from "@codemirror/language";

export interface PaperLanguage {
  /** Canonical id — also the stored `code_block.language` when picked. */
  id: string;
  /** Display label for the language picker. */
  label: string;
  /** Alternate fence tokens, matched case-insensitively alongside `id`. */
  aliases: string[];
  /**
   * Tier-0 loader: the bare lezer parser. Feeds the static-highlight
   * decoration plugin (codeHighlight.ts).
   */
  // @feat code-highlight: per-language memoized lezer grammar loaders the
  // static-highlight plugin resolves to parse each block's text
  highlight: () => Promise<{ parser: Parser }>;
  /** Tier-1 loader: the full CodeMirror `LanguageSupport`. */
  cm: () => Promise<{ support: LanguageSupport }>;
}

// Fence-language tokens that must never resolve to a preset: they collide
// with the source / paper-embed / paper-toc / paper-table fence
// discriminators in datasette_paper/markdown_parser.py (a ```source fence
// parses as a `source` node, not a `code_block`). Kept in lock-step with
// `RESERVED_FENCE_TOKENS` in datasette_paper/markdown.py and
// `normalizeLanguageToken`'s guard in collab.ts.
export const RESERVED_FENCE_TOKENS: ReadonlySet<string> = new Set([
  "source",
  "paper-embed",
  "paper-toc",
  "paper-table",
]);

const byId = new Map<string, PaperLanguage>();
const byToken = new Map<string, PaperLanguage>();

function registerLanguage(entry: PaperLanguage): void {
  byId.set(entry.id, entry);
  byToken.set(entry.id.toLowerCase(), entry);
  for (const alias of entry.aliases) {
    byToken.set(alias.toLowerCase(), entry);
  }
}

/**
 * Resolve a fence-language token (typed, pasted, or picked) to its preset
 * entry. Case-insensitive over `id` + `aliases`; unknown tokens return
 * `undefined` so the caller renders plain rather than rewriting storage —
 * the stored `language` attr is always the verbatim fence token.
 */
export function resolveLanguage(token: string | null): PaperLanguage | undefined {
  if (!token) return undefined;
  return byToken.get(token.toLowerCase());
}

/** All preset languages, in picker display order. */
export function allLanguages(): readonly PaperLanguage[] {
  return Array.from(byId.values());
}

/**
 * Wrap a loader so concurrent callers share one in-flight promise, and a
 * resolved loader never re-imports or re-derives its value. Mirrors
 * `collab.ts`'s `mdParser` loader shape. On failure the in-flight promise
 * is cleared so a later call can retry (e.g. after a transient network
 * error).
 */
function memoizeLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: T | undefined;
  let inFlight: Promise<T> | null = null;
  return () => {
    if (cached !== undefined) return Promise.resolve(cached);
    if (!inFlight) {
      inFlight = load().then(
        (value) => {
          cached = value;
          inFlight = null;
          return value;
        },
        (err) => {
          inFlight = null;
          throw err;
        },
      );
    }
    return inFlight;
  };
}

registerLanguage({
  id: "python",
  label: "Python",
  aliases: ["py"],
  highlight: memoizeLoader(() =>
    import("@lezer/python").then((m) => ({ parser: m.parser })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-python").then((m) => ({ support: m.python() })),
  ),
});

registerLanguage({
  id: "javascript",
  label: "JavaScript",
  aliases: ["js"],
  highlight: memoizeLoader(() =>
    import("@lezer/javascript").then((m) => ({ parser: m.parser })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-javascript").then((m) => ({
      support: m.javascript(),
    })),
  ),
});

// Both tiers come from `@codemirror/lang-sql` — there's no separate bare
// `@lezer/*` package for SQL, and the SQLite dialect data is needed for
// highlighting anyway (keyword/type node tags differ per dialect). Both
// loaders import the same module, so vite emits one shared chunk.
registerLanguage({
  id: "sql",
  label: "SQL",
  aliases: ["sqlite"],
  highlight: memoizeLoader(() =>
    import("@codemirror/lang-sql").then((m) => ({
      parser: m.SQLite.language.parser,
    })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-sql").then((m) => ({
      support: m.sql({ dialect: m.SQLite }),
    })),
  ),
});

registerLanguage({
  id: "json",
  label: "JSON",
  aliases: [],
  highlight: memoizeLoader(() =>
    import("@lezer/json").then((m) => ({ parser: m.parser })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-json").then((m) => ({ support: m.json() })),
  ),
});

registerLanguage({
  id: "yaml",
  label: "YAML",
  aliases: ["yml"],
  highlight: memoizeLoader(() =>
    import("@lezer/yaml").then((m) => ({ parser: m.parser })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-yaml").then((m) => ({ support: m.yaml() })),
  ),
});

// Bash has no bare `@lezer/*` grammar package; both tiers wrap
// `@codemirror/legacy-modes`' shell StreamParser in a `StreamLanguage` from
// `@codemirror/language`. Like SQL above, that means tier-0 highlighting
// reaches into `@codemirror/*` (cm-core) — accepted for the same reason.
// The shell mode itself is pinned to its own `lang-bash` chunk in
// vite.config.ts's `manualChunks` so the bundle tripwire can see it.
registerLanguage({
  id: "bash",
  label: "Bash",
  aliases: ["sh", "shell", "zsh"],
  highlight: memoizeLoader(() =>
    Promise.all([
      import("@codemirror/language"),
      import("@codemirror/legacy-modes/mode/shell"),
    ]).then(([lang, mode]) => ({
      parser: lang.StreamLanguage.define(mode.shell).parser,
    })),
  ),
  cm: memoizeLoader(() =>
    Promise.all([
      import("@codemirror/language"),
      import("@codemirror/legacy-modes/mode/shell"),
    ]).then(([lang, mode]) => ({
      support: new lang.LanguageSupport(lang.StreamLanguage.define(mode.shell)),
    })),
  ),
});
