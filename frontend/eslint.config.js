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
    // `@codemirror/*` core packages may be imported only through the single
    // chokepoint (cmCore.ts) so CM6 stays one lazy chunk absent from the entry
    // bundle — see plans/codemirror/02-design.md §4. languages.ts is the other
    // exemption: its lazy `cm()` loaders legitimately dynamic-import the
    // `@codemirror/lang-*` grammar wrappers.
    ignores: ["src/lib/cmCore.ts", "src/lib/languages.ts"],
    files: ["src/**/*.{ts,svelte}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["@codemirror/*"] },
      ],
    },
  },
  {
    ignores: ["dist/", "node_modules/", "../datasette_paper/static/"],
  },
];
