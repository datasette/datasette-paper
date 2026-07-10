/**
 * Bundle-size tripwire (plans/codemirror/tickets/07-tests-e2e-registry.md):
 * proves — as CI signal rather than hope — the plan's core promise that
 * CodeMirror never rides the entry bundle. Reads the BUILT
 * `datasette_paper/manifest.json` and asserts:
 *
 *   - no `@codemirror/*` or per-language `@lezer/*` grammar module is
 *     reachable from the `doc` page entry by walking `imports` (Vite's
 *     static/initial import graph) — never `dynamicImports`;
 *   - each registered language backed by a bare `@lezer/*` grammar package
 *     ships its own named `lang-*` chunk, reachable from the entry ONLY via
 *     a `dynamicImports` edge (SQL has no separate bare `@lezer/sql`
 *     package — both of its loaders import `@codemirror/lang-sql` itself,
 *     so it's checked by module id instead of a `lang-sql` chunk name; see
 *     languages.ts's and vite.config.ts's comments);
 *   - the `cm-core` chunk (the `@codemirror/{view,state,language,commands,
 *     autocomplete}` bundle behind cmCore.ts's single lazy import — see its
 *     docstring) is reachable ONLY via a `dynamicImports` edge, never
 *     `imports`.
 *
 * `@lezer/common`/`lr`/`highlight` and `w3c-keyname` are deliberately NOT
 * flagged: they're shared low-level primitives that legitimately ship eager
 * (codeHighlight.ts's tier-0 classifier, and a dependency `prosemirror-
 * keymap` already shipped eagerly) — see the vite.config.ts `manualChunks`
 * comment for why they're pinned to their own chunks rather than left for
 * Rollup to place arbitrarily.
 *
 * REQUIRES A FRESH BUILD: run `just frontend` first. This file guards with
 * an existence check on the manifest and *skips* (not fails) when it's
 * absent, so a plain `npx vitest` (no build) stays green; `just
 * verify-frontend` / CI build first via `just frontend`.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// frontend/src/lib/__tests__ -> repo root -> datasette_paper/manifest.json
// (vite.config.ts's build.outDir points the built manifest there).
const MANIFEST_PATH = resolve(HERE, "../../../../datasette_paper/manifest.json");
const DOC_ENTRY = "src/pages/doc/main.ts";

// One distinct named `lang-<id>` chunk per grammar package in languages.ts
// (vite.config.ts's `manualChunks` buckets bare `@lezer/*` packages by name,
// plus an explicit `lang-bash` bucket for `@codemirror/legacy-modes`' shell
// mode — bash has no bare grammar package). SQL is excluded — see the module
// docstring. Update this list if languages.ts registers a language backed by
// a new grammar package.
const EXPECTED_LANG_CHUNKS = ["python", "javascript", "json", "yaml", "bash"];

// SQL's `@codemirror/lang-sql` module id (both `highlight()` and `cm()`
// import it — no separate bare grammar package to bucket by name).
const SQL_LANG_MODULE = "node_modules/@codemirror/lang-sql/dist/index.js";

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}
type Manifest = Record<string, ManifestChunk>;

function loadManifest(): Manifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
}

/**
 * Every manifest key reachable from `key` by walking `imports` transitively
 * (never `dynamicImports`) — Vite's static/initial import graph, i.e. what a
 * browser must fetch before the entry can execute at all.
 */
function staticGraph(manifest: Manifest, key: string, seen = new Set<string>()): Set<string> {
  if (seen.has(key)) return seen;
  seen.add(key);
  for (const dep of manifest[key]?.imports ?? []) staticGraph(manifest, dep, seen);
  return seen;
}

const manifest = loadManifest();

// `describe.skip` (rather than throwing) is the "guard + skip" the ticket
// asks for: a plain `vitest` run with no prior `just frontend` stays green.
(manifest ? describe : describe.skip)("bundle-size tripwire (doc entry)", () => {
  const m = manifest as Manifest;
  const entry = m[DOC_ENTRY];

  it("has a manifest entry for the doc page", () => {
    expect(entry).toBeTruthy();
    expect(entry.isEntry).toBe(true);
  });

  it("keeps every @codemirror/* and per-language @lezer/* module out of the entry's static import graph", () => {
    const graph = staticGraph(m, DOC_ENTRY);
    const offenders = [...graph]
      .map((key) => ({ key, file: m[key]?.file ?? "" }))
      .filter(
        ({ key, file }) =>
          /node_modules\/@codemirror\//.test(key) ||
          /^static\/gen\/cm-core-/.test(file) ||
          /^static\/gen\/lang-[a-z]+-/.test(file),
      );
    expect(offenders).toEqual([]);
  });

  it("ships one lang-* chunk per registered language, reachable only dynamically", () => {
    const dynamicFiles = (entry.dynamicImports ?? []).map((key) => m[key]?.file ?? "");
    const staticGraphFiles = new Set(
      [...staticGraph(m, DOC_ENTRY)].map((key) => m[key]?.file ?? ""),
    );
    for (const lang of EXPECTED_LANG_CHUNKS) {
      const pattern = new RegExp(`^static/gen/lang-${lang}-`);
      expect(
        dynamicFiles.some((f) => pattern.test(f)),
        `expected a dynamic lang-${lang} chunk`,
      ).toBe(true);
      expect(
        [...staticGraphFiles].some((f) => pattern.test(f)),
        `lang-${lang} chunk leaked into the static import graph`,
      ).toBe(false);
    }
  });

  it("ships SQL's @codemirror/lang-sql module, reachable only dynamically", () => {
    const dynamicKeys = entry.dynamicImports ?? [];
    expect(dynamicKeys).toContain(SQL_LANG_MODULE);
    expect(staticGraph(m, DOC_ENTRY).has(SQL_LANG_MODULE)).toBe(false);
  });

  it("keeps cm-core reachable only via a dynamic import edge", () => {
    const dynamicFiles = (entry.dynamicImports ?? []).map((key) => m[key]?.file ?? "");
    expect(dynamicFiles.some((f) => /^static\/gen\/cm-core-/.test(f))).toBe(true);
    const staticGraphFiles = [...staticGraph(m, DOC_ENTRY)].map((key) => m[key]?.file ?? "");
    expect(staticGraphFiles.some((f) => /^static\/gen\/cm-core-/.test(f))).toBe(false);
  });
});
