"""(Re)generate fixtures/markdown/*.doc.json from their .md sources.

Each fixture is authored as canonical markdown (`<name>.md`). This tool
parses it with the backend parser (`markdown_to_doc`), verifies the
doc → markdown round-trip reproduces the source byte-for-byte (so the
.md really is in canonical serialized form), and writes the parsed doc
as `<name>.doc.json`. Both golden runners then pin their serializer to
the pair — see fixtures/markdown/README.md.

Usage:
    uv run --prerelease=allow python tools/markdown_fixtures.py

Exits non-zero (writing nothing for that fixture) when a round-trip
diverges, printing a diff so you can adjust the .md to canonical form.
"""

import difflib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from datasette_paper.markdown import doc_to_markdown  # noqa: E402
from datasette_paper.markdown_parser import markdown_to_doc  # noqa: E402

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "markdown"


def main() -> int:
    failed = False
    for md_path in sorted(FIXTURES.glob("*.md")):
        if md_path.stem == "README":  # docs, not a fixture
            continue
        source = md_path.read_text()
        doc = markdown_to_doc(source)
        round_tripped = doc_to_markdown(doc)
        if round_tripped != source:
            failed = True
            print(f"NOT CANONICAL: {md_path.name} — md → doc → md diverges:")
            sys.stdout.writelines(
                difflib.unified_diff(
                    source.splitlines(keepends=True),
                    round_tripped.splitlines(keepends=True),
                    fromfile=f"{md_path.name} (source)",
                    tofile=f"{md_path.name} (round-tripped)",
                )
            )
            continue
        json_path = md_path.with_suffix("").with_suffix(".doc.json")
        json_path.write_text(json.dumps(doc, indent=2, sort_keys=True) + "\n")
        print(f"ok: {md_path.name} → {json_path.name}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
