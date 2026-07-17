# Golden markdown fixtures

Language-agnostic pairs pinning the **two** markdown serializers — Python
(`datasette_paper/markdown.py`, behind the `/document` endpoint and
`datasette paper export`) and TypeScript
(`frontend/src/lib/markdownSerializer.ts`, behind the doc-header "Copy as
markdown" button) — to byte-identical output.

Each fixture is:

- `<name>.md` — canonical markdown, the hand-authored source of truth.
- `<name>.doc.json` — the ProseMirror doc it parses to, **generated**.

Runners:

- `tests/test_markdown_golden.py` — Python serializer + parser round-trip.
- `frontend/src/lib/__tests__/markdownGolden.test.ts` — client serializer.

## Adding a fixture

1. Write `<name>.md` in canonical form (what the serializers emit — e.g.
   `- ` bullets, tight lists, compact JSON fence bodies).
2. `just gen-markdown-fixtures` — parses the .md with the backend parser,
   verifies md → doc → md reproduces the source byte-for-byte (diff shown
   if not), and writes `<name>.doc.json`.
3. Run both runners; a client failure means the two serializers diverge —
   fix the serializer, not the fixture.

## Scope

Fixtures cover realistic content for every shared schema node — enforced
by `test_fixtures_cover_every_schema_node`, with one documented exception:
`placeholder` is write-only (substituted at create-from-template time,
never parsed back), so no markdown-authored fixture can contain the node;
its `{{key}}` serialization is pinned in both per-side unit suites.

They are NOT an adversarial escaping suite — the two serializers use
different text-escaping implementations (prosemirror-markdown's `esc` vs
markdown.py's hand escape) that agree on ordinary prose but may differ on
pathological inputs (e.g. text that looks like markdown syntax). Pin any
such case deliberately in the per-side unit tests instead.

Known markdown-inherent loss: two adjacent sibling lists of the SAME type
serialize with an extra blank line (both serializers, identical bytes),
but CommonMark folds them back into one list on re-parse — so that shape
can't be a fixture either. It's pinned per-side instead
(`test_adjacent_same_type_lists_*` in test_markdown.py and the "sibling
block separators" suite in markdownSerializer.test.ts).
