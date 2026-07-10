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
  experimental: {
    // Vite's runtime URLs (import-dep preloads, absolute asset refs) join
    // base + fileName verbatim, but the file `static/gen/foo.js` is served
    // from `<base>gen/foo.js` — apply the same leading-`static/` strip as
    // `vite_entry`. Without it those URLs 404, and a 404'd CSS preload
    // rejects the dynamic import that pulled it in.
    renderBuiltUrl(filename) {
      return `/-/static-plugins/datasette_paper/${filename.replace(/^static\//, "")}`;
    },
  },
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
        profile_section: path.resolve(
          __dirname,
          "src/pages/profile_section/main.ts",
        ),
      },
      output: {
        // Name chunks by CONTENT so the bundle tripwire (bundleSize.test.ts)
        // and the e2e viewer-cost assertion can identify CM/grammar fetches
        // by file name (every `@codemirror/*`/`@lezer/*` entry point is
        // `dist/index.js`, so default names collapse to `index-<hash>.js`).
        // Unlike `manualChunks`, naming never moves modules between chunks —
        // Rollup's default (correctly lazy) chunk graph stays intact, and a
        // name-based assertion like "no cm-core-* in the entry's static
        // graph" is content-based by construction. Precedence: grammar names
        // win over `cm-core` (SQL/bash have no bare `@lezer/*` package, both
        // tiers import a `@codemirror/*` one); `@lezer/{common,lr,highlight}`
        // are shared primitives that legitimately ship statically, named
        // distinctly so they never trip the `lang-*` assertions.
        chunkFileNames(chunk) {
          const ids = chunk.moduleIds ?? [];
          const first = (re: RegExp) => {
            for (const id of ids) {
              const m = re.exec(id);
              if (m) return m;
            }
            return null;
          };
          const grammar =
            first(/node_modules\/@lezer\/(?!common\/|lr\/|highlight\/)([a-z]+)\//) ??
            first(/node_modules\/@codemirror\/lang-([a-z]+)\//);
          const name = grammar
            ? `lang-${grammar[1]}`
            : first(/node_modules\/@codemirror\/legacy-modes\//)
              ? "lang-bash"
              : first(/node_modules\/@codemirror\//)
                ? "cm-core"
                : first(/node_modules\/@lezer\//)
                  ? "lezer-common"
                  : chunk.name;
          return `static/gen/${name}-[hash].js`;
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
