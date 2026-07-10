import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";

export default defineConfig({
  plugins: [svelte()],
  // Datasette serves datasette_paper/static/ at /-/static-plugins/datasette_paper/.
  // Manifest paths read by `datasette_vite.vite_entry` are resolved relative
  // to that prefix — `static/gen/foo.css` becomes `gen/foo.css` after the
  // helper strips the leading `static/`.
  base: "/-/static-plugins/datasette_paper/",
  build: {
    target: "esnext",
    // Mirrors datasette-libfec: outDir = plugin package root so
    // `manifest.json` lands at `datasette_paper/manifest.json` (where
    // `datasette_vite._load_manifest` looks for it), with assets nested
    // under `static/gen/`.
    outDir: path.resolve(__dirname, "../datasette_paper"),
    assetsDir: "static/gen",
    emptyOutDir: false,
    manifest: "manifest.json",
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "src/pages/index/main.ts"),
        doc: path.resolve(__dirname, "src/pages/doc/main.ts"),
        tag: path.resolve(__dirname, "src/pages/tag/main.ts"),
      },
      output: {
        // Name the CodeMirror chunks predictably (plans/codemirror/02-design.md
        // §7 promised `cm-core.<hash>.js` / `lang-<id>.<hash>.js`; left to
        // Rollup's default naming they all collapse to indistinguishable
        // `index-<hash>.js`, since every `@codemirror/*`/`@lezer/*` package's
        // entry point is literally `dist/index.js`). Named chunks are what let
        // the bundle-size tripwire (bundleSize.test.ts) and the e2e
        // viewer-cost assertion (codemirror.spec.ts) identify "was the CM/
        // grammar chunk fetched?" by request URL rather than a content hash.
        //
        // The bare `@lezer/*` grammar packages (tier-0's `highlight()`
        // loader — the near-zero-cost path codeHighlight.ts uses for every
        // viewer) get one `lang-<id>` chunk each. Deliberately NOT merged
        // with their `@codemirror/lang-*` CM wrapper counterpart (tier-1,
        // `cm()`): merging them once made Rollup's chunk graph route the
        // wrapper's OWN static edge to `@codemirror/language` (part of
        // `cm-core`) through the merged chunk, so a plain tier-0 grammar
        // load (e.g. python highlight() — no `@codemirror/*` involved at
        // all per languages.ts's docstring) started preloading `cm-core`
        // too — exactly the viewer-cost regression this config exists to
        // prevent. Left unbucketed, `@codemirror/lang-*` gets Rollup's
        // default automatic chunk (unnamed — nothing needs to reference it
        // by name); the base `@codemirror/{view,state,language,commands,
        // autocomplete}` packages share one `cm-core` chunk.
        //
        // (SQL is the one exception where tier-0 and tier-1 can't be
        // separated: there's no bare `@lezer/sql` package, so both loaders
        // import `@codemirror/lang-sql` itself — languages.ts's own comment
        // notes vite emits one shared chunk for it, and that chunk's own
        // `@codemirror/language` dependency means SQL's tier-0 highlighting
        // was already reaching into `@codemirror/*` before this config
        // existed. Accepted; codemirror.spec.ts's viewer-cost scenario uses
        // a python doc specifically to avoid asserting past that caveat.)
        //
        // `@lezer/common`/`lr`/`highlight` (parser primitives + the tier-0
        // token classifier codeHighlight.ts imports eagerly) get their own
        // `lezer-common` chunk — every lang-* chunk and cm-core need
        // `@lezer/common`, so leaving it unbucketed let Rollup drop it
        // inside one arbitrary lang-* chunk and produced a lang-* ⇄ cm-core
        // chunk cycle. `lezer-common` legitimately ships in the doc entry's
        // static graph (the bundle-size tripwire allowlists it, same as
        // `@lezer/highlight` always did before this config existed).
        //
        // `w3c-keyname` gets the same standalone-chunk treatment for a
        // subtler reason: it's a dependency BOTH `prosemirror-keymap`
        // (static, in every doc) and `@codemirror/view` (dynamic, inside
        // cm-core) share. Left unbucketed, Rollup picked exactly one
        // physical home for its (tiny) code and it landed inside whichever
        // CM chunk referenced it first, then had the *static* `doc` entry
        // import that CM chunk to reach it — i.e. it leaked a
        // `@codemirror/*` static edge into the entry, exactly what this
        // tripwire exists to catch. Pinning it to its own chunk breaks that:
        // the doc entry statically importing `vendor-keyname` (not
        // `@codemirror/*`/`@lezer/*`) is unremarkable and matches how
        // `prosemirror-keymap` used it before any CM chunk existed.
        manualChunks(id) {
          if (/node_modules\/w3c-keyname\//.test(id)) return "vendor-keyname";
          // Bash's shell mode comes from @codemirror/legacy-modes (no bare
          // @lezer/* grammar exists) — without this rule the @codemirror
          // catch-all below would fold it into cm-core, hiding it from the
          // per-language chunk assertions. The StreamLanguage wrapper it
          // needs still lives in cm-core, so bash tier-0 loads share SQL's
          // documented caveat.
          if (/node_modules\/@codemirror\/legacy-modes\//.test(id)) {
            return "lang-bash";
          }
          if (/node_modules\/@lezer\/(common|lr|highlight)\//.test(id)) {
            return "lezer-common";
          }
          const grammar = /node_modules\/@lezer\/([a-z]+)\//.exec(id);
          if (grammar) return `lang-${grammar[1]}`;
          if (
            /node_modules\/@codemirror\//.test(id) &&
            !/node_modules\/@codemirror\/lang-/.test(id)
          ) {
            return "cm-core";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    cors: true,
    origin: "http://localhost:5173",
    hmr: {
      host: "localhost",
      protocol: "ws",
    },
  },
});
