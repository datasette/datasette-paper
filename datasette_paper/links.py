"""Link-edge extraction from a materialized ProseMirror doc.

Third sibling of markdown.extract_tasks / tables.extract_tables: walks the
doc tree and returns every paper_link target docId in document order (with
repeats), so the write-tail reindex can collapse them to per-dst counts.
"""


def extract_links(doc: dict) -> list[int]:
    """Every paper_link target docId in document order (with repeats)."""
    out: list[int] = []

    def walk(node: dict) -> None:
        if node.get("type") == "paper_link":
            did = (node.get("attrs") or {}).get("docId")
            if did is not None:
                out.append(int(did))
        for child in node.get("content") or []:
            walk(child)

    walk(doc)
    return out
