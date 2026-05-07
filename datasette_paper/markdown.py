"""Serialize a ProseMirror JSON doc (basic + lists schema) to CommonMark.

Mirrors prosemirror-markdown's defaults closely enough for sensible
round-trips through a CommonMark reader. Round-trip parity with
`prosemirror-markdown` is not a goal — escaping is intentionally minimal
and a few corner cases (e.g. tight vs loose lists, exact bullet markers)
may differ.
"""

from typing import List


def doc_to_markdown(doc: dict) -> str:
    """Serialize a ProseMirror doc to a markdown string ending in a newline."""
    if doc.get("type") != "doc":
        raise ValueError("expected top-level 'doc' node")
    blocks = doc.get("content") or []
    out: List[str] = []
    for i, block in enumerate(blocks):
        if i:
            out.append("\n")
        out.append(_render_block(block))
    text = "".join(out).rstrip() + "\n"
    return text


def _render_block(node: dict) -> str:
    t = node.get("type")
    content = node.get("content") or []
    if t == "paragraph":
        return _render_inlines(content) + "\n"
    if t == "heading":
        level = max(1, min(6, int(node.get("attrs", {}).get("level", 1))))
        return "#" * level + " " + _render_inlines(content) + "\n"
    if t == "horizontal_rule":
        return "---\n"
    if t == "code_block":
        text = "".join(c.get("text", "") for c in content)
        return "```\n" + text + "\n```\n"
    if t == "blockquote":
        inner_parts: List[str] = []
        for i, child in enumerate(content):
            if i:
                inner_parts.append("\n")
            inner_parts.append(_render_block(child))
        inner = "".join(inner_parts).rstrip("\n")
        return (
            "\n".join("> " + line if line else ">" for line in inner.split("\n")) + "\n"
        )
    if t == "bullet_list":
        return _render_list(node, ordered=False)
    if t == "ordered_list":
        return _render_list(node, ordered=True)
    if t == "task_list":
        return _render_task_list(node)
    if t == "table":
        return _render_table(node)
    if t == "list_item":
        # list_item is rendered by _render_list with markers; calling here
        # returns the bare child blocks.
        parts: List[str] = []
        for i, child in enumerate(content):
            if i:
                parts.append("\n")
            parts.append(_render_block(child))
        return "".join(parts)
    # Fallback: unknown block — render its inlines if any, else empty.
    return _render_inlines(content) + ("\n" if content else "")


def _render_table(node: dict) -> str:
    """GFM-style pipe table.

    First row becomes the header iff every cell in it is a `table_header`.
    Otherwise we synthesise an empty header (GFM requires one) so the
    table still parses round-tripped through any CommonMark-GFM reader.
    Cell text is the flattened inline content of the cell's blocks; pipes
    inside cell text are escaped. We assume rectangular tables (no
    colspan/rowspan) since the editor doesn't expose merge.
    """
    rows = node.get("content") or []
    if not rows:
        return ""

    def cells(row: dict) -> list[dict]:
        return row.get("content") or []

    def cell_text(cell: dict) -> str:
        # cell content is `block+`; flatten the inlines of every paragraph.
        parts: List[str] = []
        for block in cell.get("content") or []:
            if block.get("type") == "paragraph":
                parts.append(_flatten_text(block.get("content") or []))
            else:
                parts.append(_flatten_text([block]))
        text = " ".join(p for p in parts if p)
        return text.replace("|", r"\|").replace("\n", " ").strip()

    first_cells = cells(rows[0])
    header_row_first = bool(first_cells) and all(
        c.get("type") == "table_header" for c in first_cells
    )
    width = max(len(cells(r)) for r in rows)

    def pad(values: list[str]) -> list[str]:
        return values + [""] * (width - len(values))

    if header_row_first:
        header = pad([cell_text(c) for c in first_cells])
        body = rows[1:]
    else:
        header = [""] * width
        body = rows

    out: List[str] = []
    out.append("| " + " | ".join(header) + " |")
    out.append("| " + " | ".join("---" for _ in range(width)) + " |")
    for r in body:
        out.append("| " + " | ".join(pad([cell_text(c) for c in cells(r)])) + " |")
    return "\n".join(out) + "\n"


def _render_task_list(node: dict) -> str:
    """GFM-style task list: `- [ ] item` / `- [x] item`."""
    items = node.get("content") or []
    out: List[str] = []
    for item in items:
        checked = bool(item.get("attrs", {}).get("checked", False))
        marker = "- [x] " if checked else "- [ ] "
        # task_item content shape matches list_item; reuse the renderer
        rendered = _render_block(
            {"type": "list_item", "content": item.get("content") or []}
        ).rstrip("\n")
        first, *rest = rendered.split("\n")
        indent = " " * len(marker)
        out.append(marker + first)
        for line in rest:
            out.append((indent + line) if line else "")
    return "\n".join(out) + "\n"


def _render_list(node: dict, ordered: bool) -> str:
    items = node.get("content") or []
    start = int(node.get("attrs", {}).get("order", 1)) if ordered else 1
    out: List[str] = []
    for i, item in enumerate(items):
        marker = f"{start + i}. " if ordered else "- "
        rendered = _render_block(item).rstrip("\n")
        first, *rest = rendered.split("\n")
        indent = " " * len(marker)
        out.append(marker + first)
        for line in rest:
            out.append((indent + line) if line else "")
    return "\n".join(out) + "\n"


def extract_tasks(doc: dict) -> List[dict]:
    """Walk a ProseMirror doc and collect every task_item.

    Returns a list of `{text, checked, depth, section}` dicts in document
    order. `depth` increments under each enclosing task_list / list_item /
    blockquote so consumers can render nested tasks with appropriate
    indentation. `section` is the path of enclosing headings (outermost to
    innermost) — e.g. `[{"level": 2, "text": "Sprint 1"}, {"level": 3,
    "text": "Sprint 1.2"}]`. A task before any heading has `section: []`.
    """
    tasks: List[dict] = []
    NESTING = {
        "task_list",
        "bullet_list",
        "ordered_list",
        "list_item",
        "blockquote",
        "table",
        "table_row",
        "table_cell",
        "table_header",
    }
    section_stack: List[dict] = []

    def walk(node: dict, depth: int) -> None:
        t = node.get("type")
        if t == "heading":
            level = max(1, min(6, int(node.get("attrs", {}).get("level", 1))))
            text = _flatten_text(node.get("content") or []).strip()
            while section_stack and section_stack[-1]["level"] >= level:
                section_stack.pop()
            section_stack.append({"level": level, "text": text})
            return
        if t == "task_item":
            # The reported `text` is the item's own paragraph content,
            # not text from nested task_lists — those become separate
            # entries at the next depth level.
            text_parts: List[str] = []
            for child in node.get("content") or []:
                if child.get("type") == "paragraph":
                    text_parts.append(_flatten_text(child.get("content") or []))
            tasks.append(
                {
                    "text": "".join(text_parts).strip(),
                    "checked": bool(node.get("attrs", {}).get("checked", False)),
                    "depth": depth,
                    "section": [dict(s) for s in section_stack],
                }
            )
            for child in node.get("content") or []:
                if child.get("type") != "paragraph":
                    walk(child, depth + 1)
            return
        next_depth = depth + 1 if t in NESTING else depth
        for child in node.get("content") or []:
            walk(child, next_depth)

    walk(doc, 0)
    return tasks


def group_tasks_by_section(tasks: List[dict]) -> List[dict]:
    """Group tasks by their (deepest) heading section, preserving doc order.

    A new group starts whenever the section path changes between consecutive
    tasks — so two distinct headings with the same text produce two groups,
    not one. Tasks before any heading land in a group with `section: []`.
    """
    groups: List[dict] = []
    sentinel = object()
    prev_key: object = sentinel
    for task in tasks:
        key = tuple((s["level"], s["text"]) for s in task.get("section") or [])
        if key != prev_key:
            section = list(task.get("section") or [])
            groups.append(
                {
                    "section": section,
                    "heading": section[-1]["text"] if section else None,
                    "level": section[-1]["level"] if section else None,
                    "tasks": [],
                }
            )
            prev_key = key
        groups[-1]["tasks"].append(task)
    return groups


def _flatten_text(nodes: list) -> str:
    """Concatenate every `text` node in a content list, ignoring marks."""
    parts: List[str] = []
    for n in nodes or []:
        if n.get("type") == "text":
            parts.append(n.get("text", ""))
        elif n.get("type") == "hard_break":
            parts.append(" ")
        else:
            parts.append(_flatten_text(n.get("content") or []))
    return "".join(parts)


def _render_inlines(nodes: list) -> str:
    parts: List[str] = []
    for n in nodes or []:
        t = n.get("type")
        if t == "text":
            text = n.get("text", "")
            for mark in n.get("marks") or []:
                mt = mark.get("type")
                if mt == "code":
                    text = f"`{text}`"
                elif mt == "strong":
                    text = f"**{text}**"
                elif mt == "em":
                    text = f"*{text}*"
                elif mt == "link":
                    href = mark.get("attrs", {}).get("href", "")
                    text = f"[{text}]({href})"
            parts.append(text)
        elif t == "hard_break":
            parts.append("\\\n")
    return "".join(parts)
