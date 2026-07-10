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
  /** Tier-0 loader: the bare lezer parser. */
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

// The javascript/typescript/jsx/tsx family all share `@lezer/javascript`'s
// parser at tier 0 (dialect-configured to match `@codemirror/lang-javascript`'s
// own `javascriptLanguage`/`typescriptLanguage`/`jsxLanguage`/`tsxLanguage`
// definitions) so highlighting never pulls in `@codemirror/*`; tier 1 uses
// the CM wrapper's own `javascript({jsx, typescript})` config.
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

registerLanguage({
  id: "typescript",
  label: "TypeScript",
  aliases: ["ts"],
  highlight: memoizeLoader(() =>
    import("@lezer/javascript").then((m) => ({
      parser: m.parser.configure({ dialect: "ts" }),
    })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-javascript").then((m) => ({
      support: m.javascript({ typescript: true }),
    })),
  ),
});

registerLanguage({
  id: "jsx",
  label: "JSX",
  aliases: [],
  highlight: memoizeLoader(() =>
    import("@lezer/javascript").then((m) => ({
      parser: m.parser.configure({ dialect: "jsx" }),
    })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-javascript").then((m) => ({
      support: m.javascript({ jsx: true }),
    })),
  ),
});

registerLanguage({
  id: "tsx",
  label: "TSX",
  aliases: [],
  highlight: memoizeLoader(() =>
    import("@lezer/javascript").then((m) => ({
      parser: m.parser.configure({ dialect: "jsx ts" }),
    })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-javascript").then((m) => ({
      support: m.javascript({ jsx: true, typescript: true }),
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
  id: "html",
  label: "HTML",
  aliases: [],
  highlight: memoizeLoader(() =>
    import("@lezer/html").then((m) => ({ parser: m.parser })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-html").then((m) => ({ support: m.html() })),
  ),
});

registerLanguage({
  id: "css",
  label: "CSS",
  aliases: [],
  highlight: memoizeLoader(() =>
    import("@lezer/css").then((m) => ({ parser: m.parser })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-css").then((m) => ({ support: m.css() })),
  ),
});

registerLanguage({
  id: "markdown",
  label: "Markdown",
  aliases: ["md"],
  highlight: memoizeLoader(() =>
    import("@lezer/markdown").then((m) => ({ parser: m.parser })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-markdown").then((m) => ({
      support: m.markdown(),
    })),
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

registerLanguage({
  id: "rust",
  label: "Rust",
  aliases: ["rs"],
  highlight: memoizeLoader(() =>
    import("@lezer/rust").then((m) => ({ parser: m.parser })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-rust").then((m) => ({ support: m.rust() })),
  ),
});

registerLanguage({
  id: "go",
  label: "Go",
  aliases: ["golang"],
  highlight: memoizeLoader(() =>
    import("@lezer/go").then((m) => ({ parser: m.parser })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-go").then((m) => ({ support: m.go() })),
  ),
});

registerLanguage({
  id: "java",
  label: "Java",
  aliases: [],
  highlight: memoizeLoader(() =>
    import("@lezer/java").then((m) => ({ parser: m.parser })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-java").then((m) => ({ support: m.java() })),
  ),
});

registerLanguage({
  id: "cpp",
  label: "C++",
  aliases: ["c", "c++"],
  highlight: memoizeLoader(() =>
    import("@lezer/cpp").then((m) => ({ parser: m.parser })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-cpp").then((m) => ({ support: m.cpp() })),
  ),
});

registerLanguage({
  id: "xml",
  label: "XML",
  aliases: [],
  highlight: memoizeLoader(() =>
    import("@lezer/xml").then((m) => ({ parser: m.parser })),
  ),
  cm: memoizeLoader(() =>
    import("@codemirror/lang-xml").then((m) => ({ support: m.xml() })),
  ),
});
