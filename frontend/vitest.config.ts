import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: {
    conditions: ["browser"],
  },
  test: {
    // ProseMirror's EditorView requires a DOM environment
    environment: "jsdom",
    // e2e/ holds Playwright specs; vitest must skip them.
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  },
});
