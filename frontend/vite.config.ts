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
        publish: path.resolve(__dirname, "src/pages/publish/main.ts"),
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
