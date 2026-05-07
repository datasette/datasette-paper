import tseslint from "typescript-eslint";
import svelte from "eslint-plugin-svelte";
import svelteParser from "svelte-eslint-parser";

export default [
  ...tseslint.configs.recommended,
  ...svelte.configs["flat/recommended"],
  {
    // .svelte files: outer parser is svelte-eslint-parser, inner script
    // parser is the TS parser so `<script lang="ts">` blocks parse.
    files: ["**/*.svelte"],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".svelte"],
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "../datasette_paper/static/"],
  },
];
