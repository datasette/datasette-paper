"""Inline #tag extraction from a materialized ProseMirror doc.

Sibling of links.extract_links / markdown.extract_tasks / tables.extract_tables:
walks the doc tree and returns every inline ``tag`` node's normalized slug in
document order (with repeats), so the tag-search endpoint can confirm that a
candidate doc really contains a given tag (and count occurrences).

Inline ``#tags`` live ONLY in the doc body as ``tag`` nodes — they are a
separate namespace from the doc-level ``_datasette_paper_doc_tag`` table.
"""

from .util import normalize_tag


def extract_tags(doc: dict) -> list[str]:
    """Every inline ``tag`` node's normalized slug in document order (repeats).

    Slugs are normalized through ``normalize_tag`` so they match what the ``#``
    suggest, doc-tag normalize, and markdown parser store; nodes whose slug
    normalizes to ``None`` (empty/invalid) are skipped.
    """
    out: list[str] = []

    def walk(node: dict) -> None:
        if node.get("type") == "tag":
            slug = normalize_tag((node.get("attrs") or {}).get("tag"))
            if slug is not None:
                out.append(slug)
        for child in node.get("content") or []:
            walk(child)

    walk(doc)
    return out
