/**
 * Golden markdown fixtures — the TypeScript half of the parity suite.
 *
 * `fixtures/markdown/` (repo root) holds `<name>.md` / `<name>.doc.json`
 * pairs; `tests/test_markdown_golden.py` pins the Python serializer and
 * parser to them, and this file pins the client serializer — so "Copy as
 * markdown", the /document endpoint, and `datasette paper export` all
 * produce identical bytes for the covered constructs. See
 * fixtures/markdown/README.md for how to add a fixture.
 */

// @feat cli-export: golden parity — client serializer pinned to the shared fixtures

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import * as pmMarkdown from "prosemirror-markdown";

import { schema } from "../schema";
import { buildMarkdownSerializer, serializeDoc } from "../markdownSerializer";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/markdown",
);
const names = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".doc.json"))
  .map((f) => f.replace(/\.doc\.json$/, ""))
  .sort();

const serializer = buildMarkdownSerializer(pmMarkdown);

describe("golden markdown fixtures (parity with the backend serializer)", () => {
  it("found the fixture directory", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(`serializes ${name}.doc.json to ${name}.md byte-for-byte`, () => {
      const doc = JSON.parse(
        readFileSync(path.join(FIXTURES, `${name}.doc.json`), "utf8"),
      ) as unknown;
      const expected = readFileSync(path.join(FIXTURES, `${name}.md`), "utf8");
      const node = schema.nodeFromJSON(doc);
      // serializeDoc output has no trailing newline; the .md files are
      // newline-terminated (and doc_to_markdown emits the newline).
      expect(serializeDoc(serializer, node) + "\n").toBe(expected);
    });
  }
});
