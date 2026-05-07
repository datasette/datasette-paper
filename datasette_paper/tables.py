"""Walk a materialized ProseMirror doc and extract every `table` node.

Mirrors the structure of `extract_tasks` in `markdown.py`. Each result is
`{name, header, rows, position}`:

- `name`: the user-supplied `table.attrs.name` string, or `None`.
- `header`: list[str] if the first row is all `table_header` cells,
  else `None`.
- `rows`: list[list[str]] — the body rows (or all rows when `header`
  is `None`). Cells are flattened to plain text.
- `position`: zero-based document-order index, useful when the same
  name appears twice (caller picks first match) or for anonymous
  tables in the listing endpoint.

We assume rectangular tables — the editor never exposes merge/split,
so `colspan`/`rowspan` should always be 1. If they aren't (e.g. via
paste from another source), we still emit one entry per `table_row`
child, ignoring spans. The endpoint contract documents this.
"""

from typing import List, Optional

from .markdown import _flatten_text


def extract_tables(doc: dict) -> List[dict]:
    """Return every table in document order with header/rows flattened to strings."""
    out: List[dict] = []

    def walk(node: dict) -> None:
        t = node.get("type")
        if t == "table":
            out.append(_build_table(node, position=len(out)))
            return
        for child in node.get("content") or []:
            walk(child)

    walk(doc)
    return out


def find_table_by_name(doc: dict, name: str) -> Optional[dict]:
    """First table whose `name` attr equals `name`. None if none match."""
    for table in extract_tables(doc):
        if table["name"] == name:
            return table
    return None


def count_tables_with_name(doc: dict, name: str) -> int:
    """How many tables share this name — for the duplicates warning."""
    return sum(1 for t in extract_tables(doc) if t["name"] == name)


def _build_table(node: dict, position: int) -> dict:
    rows = node.get("content") or []
    name = node.get("attrs", {}).get("name")

    def cells(row: dict) -> list:
        return row.get("content") or []

    def cell_text(cell: dict) -> str:
        parts: List[str] = []
        for block in cell.get("content") or []:
            if block.get("type") == "paragraph":
                parts.append(_flatten_text(block.get("content") or []))
            else:
                parts.append(_flatten_text([block]))
        return " ".join(p for p in parts if p).strip()

    if not rows:
        return {
            "name": name,
            "header": None,
            "rows": [],
            "position": position,
        }

    first_cells = cells(rows[0])
    header_row_first = bool(first_cells) and all(
        c.get("type") == "table_header" for c in first_cells
    )

    if header_row_first:
        header = [cell_text(c) for c in first_cells]
        body_rows = rows[1:]
    else:
        header = None
        body_rows = rows

    body = [[cell_text(c) for c in cells(r)] for r in body_rows]

    return {
        "name": name,
        "header": header,
        "rows": body,
        "position": position,
    }
