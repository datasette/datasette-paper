"""Serialize a ProseMirror JSON doc (basic + lists schema) to CommonMark.

Mirrors prosemirror-markdown's defaults closely enough for sensible
round-trips through a CommonMark reader. Round-trip parity with
`prosemirror-markdown` is not a goal — escaping is intentionally minimal
and a few corner cases (e.g. tight vs loose lists, exact bullet markers)
may differ.
"""

import contextvars
import json
import re
from typing import Callable, List, Optional, Tuple
from urllib.parse import quote

# A resource-URL resolver: given (ref_type, value) it returns
# ``(kind, url)`` where:
#   * ``kind`` is the embed provider kind (only meaningful for ``"embed"``;
#     ``None`` for actor/tag whose canonical type segment is fixed), and
#   * ``url`` is a human/external-renderer URL for the resource, or ``None``
#     to emit the bare ``paper:/...`` ref with no href.
# Returning ``None`` instead of a tuple is equivalent to ``(None, None)``.
ResourceResolver = Callable[[str, str], Optional[Tuple[Optional[str], Optional[str]]]]

# Optional {actor_id: display_name} map consulted by the `mention` inline
# renderer, scoped to a single ``doc_to_markdown`` call. A ContextVar avoids
# threading the map through every recursive `_render_*` helper. Absent a name
# the renderer falls back to the actor id, which keeps the doc→md→doc
# round-trip (e.g. the agent edit path) lossless.
_actor_names: contextvars.ContextVar[dict] = contextvars.ContextVar(
    "paper_actor_names", default={}
)

# Optional resource-URL resolver, scoped to a single ``doc_to_markdown`` call —
# the parallel of ``_actor_names`` for ticket 04. Lets the pure serializer
# resolve real resource URLs (and the embed provider kind) without taking a
# ``datasette`` argument. Absent a resolver, inline refs serialize as the bare
# ``paper:/...`` href (ticket-02 behaviour).
_resource_url: contextvars.ContextVar[Optional[ResourceResolver]] = (
    contextvars.ContextVar("paper_resource_url", default=None)
)


def doc_to_markdown(
    doc: dict,
    actor_names: Optional[dict] = None,
    resource_url: Optional[ResourceResolver] = None,
) -> str:
    """Serialize a ProseMirror doc to a markdown string ending in a newline.

    ``actor_names`` optionally maps actor ids to display names for `mention`
    nodes; when omitted, mentions render with the actor id as their label.

    ``resource_url`` optionally resolves a real resource URL (and, for embeds,
    the provider kind) for each inline ref — see :data:`ResourceResolver`. When
    a URL is returned the ref serializes as ``[label](url "paper:/...")`` (the
    canonical ref kept in the link title so the parser reads it back
    losslessly); otherwise it serializes as the bare ``[label](paper:/...)``.
    """
    if doc.get("type") != "doc":
        raise ValueError("expected top-level 'doc' node")
    token = _actor_names.set(actor_names or {})
    url_token = _resource_url.set(resource_url)
    try:
        blocks = doc.get("content") or []
        out: List[str] = []
        for i, block in enumerate(blocks):
            if i:
                out.append("\n")
            out.append(_render_block(block))
        text = "".join(out).rstrip() + "\n"
        return text
    finally:
        _actor_names.reset(token)
        _resource_url.reset(url_token)


def _resolve_resource(ref_type: str, value: str) -> Tuple[Optional[str], Optional[str]]:
    """Call the scoped resolver for ``(ref_type, value)``; normalize the result.

    Returns ``(kind, url)`` with either element possibly ``None``. A resolver
    that raises is swallowed (best-effort enrichment must never break the pure
    serializer) and treated as no resolution.
    """
    resolver = _resource_url.get()
    if resolver is None:
        return None, None
    try:
        result = resolver(ref_type, value)
    except Exception:
        return None, None
    if not result:
        return None, None
    kind, url = result
    return kind, url


def _ref_link(label: str, canonical: str, url: Optional[str]) -> str:
    """Render an inline ref link.

    With a resource ``url``: ``[label](url "canonical")`` — the canonical
    ``paper:/`` ref lives in the title (the round-trip-safe channel). Without
    one: ``[label](canonical)`` (ticket-02 behaviour). The ``"`` in the title is
    escaped per CommonMark.
    """
    safe_label = label.replace("]", "\\]")
    if url:
        title = canonical.replace('"', '\\"')
        return f'[{safe_label}]({url} "{title}")'
    return f"[{safe_label}]({canonical})"


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
    if t == "sql_block":
        # An editable SQL query fenced with an info string of `sql db=NAME`
        # (+ a trailing `hidden` when the editor is collapsed). The `db=`
        # token is what distinguishes this from a plain ```sql code block
        # (markdown_parser.py keys off it).
        attrs = node.get("attrs") or {}
        db = attrs.get("db") or ""
        text = "".join(c.get("text", "") for c in content)
        info = "sql"
        if db:
            info += f" db={db}"
        if attrs.get("hidden"):
            info += " hidden"
        return "```" + info + "\n" + text + "\n```\n"
    if t == "source":
        # A named SQL query (a "source") fenced with an info string of
        # `source name=NAME db=DB`. The leading `source` token + `name=` are
        # the discriminators (markdown_parser.py keys off `source`). Inline
        # `value` atoms reference it by name as `${{name.column}}`.
        attrs = node.get("attrs") or {}
        name = attrs.get("name") or ""
        db = attrs.get("db") or ""
        text = "".join(c.get("text", "") for c in content)
        info = "source"
        if name:
            info += f" name={name}"
        if db:
            info += f" db={db}"
        return "```" + info + "\n" + text + "\n```\n"
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
    if t == "block_embed":
        attrs = node.get("attrs") or {}
        payload = {
            "ref": attrs.get("ref") or "",
            "mode": attrs.get("mode") or "table",
            "config": attrs.get("config") or {},
        }
        # A fenced block with info string `paper-embed`: the body is one JSON
        # object whose keys are exactly the node attrs. sort_keys → stable
        # diffs; ensure_ascii=False keeps unicode readable. The parser reads it
        # back in markdown_parser.py.
        body = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        return "```paper-embed\n" + body + "\n```\n"
    if t == "toc":
        attrs = node.get("attrs") or {}
        config = attrs.get("config") or {}
        # Empty config → empty fence body (the common case stays clean). A
        # non-empty config serializes as sorted JSON, read back in
        # markdown_parser.py. The rendered heading list is never persisted.
        if config:
            body = json.dumps(config, sort_keys=True, ensure_ascii=False)
            return "```paper-toc\n" + body + "\n```\n"
        return "```paper-toc\n```\n"
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

    GFM has no slot for the table's `name` attr (the id the `/tables/{name}`
    endpoint addresses), so a named table is preceded by an out-of-band
    sidecar fence ``` ```paper-table ``` whose body is one JSON object
    `{"name": <name>}` — mirroring the `paper-embed` / `paper-toc` JSON-body
    fence family. The parser (`markdown_parser.py`) reads it back and restores
    `attrs.name` on the table that immediately follows. Without it the name is
    silently dropped on every doc→md→doc round-trip (e.g. the agent
    `apply_markdown_edit` path), breaking `/tables/{name}` addressing.
    """
    rows = node.get("content") or []
    if not rows:
        return ""

    def cells(row: dict) -> list[dict]:
        return row.get("content") or []

    def cell_text(cell: dict) -> str:
        # cell content is `block+`; render the inlines of every paragraph
        # (preserving marks) and join. Non-paragraph blocks are rare in a
        # cell — render their inlines too rather than dropping them.
        parts: List[str] = []
        for block in cell.get("content") or []:
            if block.get("type") == "paragraph":
                parts.append(_render_inlines(block.get("content") or []))
            else:
                parts.append(_render_inlines(block.get("content") or []))
        text = " ".join(p for p in parts if p)
        # Escape pipes last so the cell-rendered markup (which contains no
        # bare pipes of its own) isn't disturbed; collapse newlines to spaces
        # since a GFM table cell is single-line.
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
    table_md = "\n".join(out) + "\n"

    name = (node.get("attrs") or {}).get("name")
    if name:
        # Sidecar fence carrying the out-of-band table name, emitted
        # immediately before the pipe table (no blank line — the closing
        # fence already ends the block, and GFM still detects the table on the
        # next line). JSON body keeps names with spaces / `=` / special chars
        # safe, matching the `paper-embed` / `paper-toc` family.
        body = json.dumps({"name": name}, sort_keys=True, ensure_ascii=False)
        return "```paper-table\n" + body + "\n```\n" + table_md
    return table_md


def _render_task_list(node: dict) -> str:
    """GFM-style task list: `- [ ] item` / `- [x] item`.

    The list marker for indentation purposes is just ``- `` (2 cols) — the
    ``[ ]`` checkbox is GFM *content*, not part of the marker. So
    continuation lines (nested lists, extra blocks) indent by 2, the same as
    a plain bullet. Indenting by the full ``- [ ] `` width (6) pushes nested
    content 4 cols past the item's content column, where CommonMark reads it
    as an indented code block instead of a child list.
    """
    items = node.get("content") or []
    out: List[str] = []
    for item in items:
        checked = bool(item.get("attrs", {}).get("checked", False))
        prefix = "- [x] " if checked else "- [ ] "
        # task_item content shape matches list_item; reuse the renderer
        rendered = _render_block(
            {"type": "list_item", "content": item.get("content") or []}
        ).rstrip("\n")
        first, *rest = rendered.split("\n")
        indent = "  "  # width of the "- " marker; checkbox is content
        out.append(prefix + first)
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


# Characters that would otherwise be parsed as markdown markup inside a text
# run. Backslash must be first in the class so it's escaped before the others
# (re.sub does a single left-to-right pass, but listing it first is clearer).
_ESCAPE_RE = re.compile(r"([\\`*_\[\]])")


def _escape_text(text: str) -> str:
    """Backslash-escape inline markup characters in a plain-text run.

    Keeps `*`, `_`, backticks, and brackets from re-parsing as emphasis /
    code / links when the serialized markdown is read back. Intentionally
    minimal — block-level markers (`#`, `>`, `-`) at line start are handled
    by the block renderers, not here.
    """
    return _ESCAPE_RE.sub(r"\\\1", text)


def _escape_image_alt(alt: str) -> str:
    """Escape an image's alt text for the `![alt](...)` link-text slot.

    Reuses the inline escaper: its set (``\\ ` * _ [ ]``) is a superset of
    what the alt slot needs — unescaped `[`/`]` would otherwise truncate or
    break the image syntax and drop the image on the round-trip.
    """
    return _escape_text(alt)


def _escape_image_src(src: str) -> str:
    """Escape an image destination for `![](dest)`.

    Per CommonMark, a bare destination cannot contain spaces and must have
    balanced parens. Wrapping in ``<...>`` sidesteps both, so angle-bracket
    any src containing whitespace or a paren (escaping literal ``<``/``>``);
    otherwise emit it bare and untouched so plain URLs are byte-identical.
    """
    if any(ch.isspace() for ch in src) or "(" in src or ")" in src:
        inner = src.replace("\\", "\\\\").replace("<", "\\<").replace(">", "\\>")
        return f"<{inner}>"
    return src


def _escape_image_title(title: str) -> str:
    """Escape an image title for the `"..."`-delimited title slot."""
    return title.replace("\\", "\\\\").replace('"', '\\"')


def _same_mark(a: dict, b: dict) -> bool:
    return a.get("type") == b.get("type") and a.get("attrs") == b.get("attrs")


def _code_span(text: str) -> str:
    """Wrap text as a CommonMark inline code span, fence sized to the content.

    The fence is a run of backticks one longer than the longest backtick run
    inside the text, so code content containing backticks (e.g. ``a `b` c``)
    round-trips. When the content begins or ends with a backtick — or is all
    spaces — a single space is padded on each side; a CommonMark reader strips
    exactly that padding back off, restoring the original content.
    """
    longest = 0
    cur = 0
    for ch in text:
        if ch == "`":
            cur += 1
            longest = max(longest, cur)
        else:
            cur = 0
    fence = "`" * (longest + 1)
    if text.startswith("`") or text.endswith("`") or text.strip(" ") == "":
        text = f" {text} "
    return f"{fence}{text}{fence}"


def _mark_delims(mark: dict) -> tuple[str, str]:
    """Return the (open, close) markdown delimiters for a range mark.

    ``code`` is *not* handled here — code spans need content-dependent
    fences (see :func:`_code_span`) so they're rendered inline at the text
    node rather than tracked as an open/close range mark.
    """
    t = mark.get("type")
    if t == "strong":
        return "**", "**"
    if t == "em":
        return "*", "*"
    if t == "link":
        attrs = mark.get("attrs") or {}
        href = attrs.get("href", "")
        title = attrs.get("title")
        close = f']({href} "{title}")' if title else f"]({href})"
        return "[", close
    return "", ""


def _encode_value_format(fmt) -> str:
    """Encode a `value` node's `format` attr into its `| kind:arg` markdown
    suffix (the part after the pipe). Mirror of `encodeFormat` in
    `frontend/src/lib/formatValue.ts` — keep the two in lock-step. `fallback`
    is intentionally not encoded; the markdown grammar carries only
    `kind[:arg]`. Returns "" for a null/unknown format."""
    if not fmt:
        return ""
    kind = fmt.get("kind")
    if kind == "number":
        d = fmt.get("decimals")
        return f"number:{d}" if d is not None else "number"
    if kind == "currency":
        c = fmt.get("currency")
        return f"currency:{c}" if c else "currency"
    if kind == "percent":
        d = fmt.get("decimals")
        return f"percent:{d}" if d is not None else "percent"
    if kind == "date":
        s = fmt.get("style")
        return f"date:{s}" if s else "date"
    if kind == "text":
        return "text"
    return ""


def _render_inlines(nodes: list) -> str:
    """Serialize a list of inline nodes, tracking open marks across nodes.

    Marks are opened/closed only when they change between adjacent nodes
    (the prosemirror-markdown approach), so a run like
    ``"bold "(strong) + "and em"(strong,em)`` renders as
    ``**bold *and em***`` instead of the per-node
    ``**bold ****and em***`` that double-counts the shared strong. Text
    inside an active ``code`` mark is emitted raw (code spans are literal).

    Marks are kept in the order the parser stored them (outer→inner); we
    don't impose a fixed priority, because the stored order already encodes
    the source nesting (e.g. em-outside-strong vs strong-outside-em). When a
    shared mark sits at a different depth in the next node, ``active`` is
    rotated to line it up so it can stay open rather than being closed and
    immediately reopened (which produces ambiguous ``***`` delimiter runs).
    """
    out: List[str] = []
    active: List[dict] = []  # marks currently open, outer→inner

    def close_through(keep: int) -> None:
        # Close active[keep:] innermost-first, then drop them.
        for mark in reversed(active[keep:]):
            out.append(_mark_delims(mark)[1])
        del active[keep:]

    for n in nodes or []:
        t = n.get("type")
        # `code` is rendered inline (content-sized fence), not tracked as an
        # open/close range mark — strip it out of the transition set.
        all_marks = n.get("marks") or []
        is_code = any(m.get("type") == "code" for m in all_marks)
        marks = [m for m in all_marks if m.get("type") != "code"]

        # Rotate `active` so each mark this node shares with the open set
        # lines up at the same index it occupies in `marks` — lets shared
        # marks stay open across the boundary instead of churning.
        for i, mark in enumerate(marks):
            for j, other in enumerate(active):
                if _same_mark(mark, other):
                    if j > i:
                        active[i : j + 1] = [other, *active[i:j]]
                    elif j < i:
                        active[j:i] = active[j + 1 : i] + [mark]
                    break

        # Keep the longest prefix of currently-open marks that still applies;
        # close the rest, then open whatever this node newly needs.
        common = 0
        while (
            common < len(active)
            and common < len(marks)
            and _same_mark(active[common], marks[common])
        ):
            common += 1
        close_through(common)
        for mark in marks[common:]:
            out.append(_mark_delims(mark)[0])
            active.append(mark)

        if t == "text":
            text = n.get("text", "")
            if is_code:
                out.append(_code_span(text))  # literal, content-sized fence
            else:
                out.append(_escape_text(text))
        elif t == "hard_break":
            out.append("\\\n")
        elif t == "image":
            attrs = n.get("attrs") or {}
            alt = _escape_image_alt(attrs.get("alt") or "")
            src = _escape_image_src(attrs.get("src") or "")
            title = attrs.get("title")
            if title:
                out.append(f'![{alt}]({src} "{_escape_image_title(title)}")')
            else:
                out.append(f"![{alt}]({src})")
        elif t == "placeholder":
            # Round-trip placeholders as `{{key}}` so the markdown export of
            # a template is self-documenting: anyone reading the markdown can
            # see where substitutions will land.
            key = n.get("attrs", {}).get("key", "")
            out.append("{{" + str(key) + "}}")
        elif t == "paper_link":
            doc_id = (n.get("attrs") or {}).get("docId")
            out.append(f"[[{doc_id}]]")
        elif t == "mention":
            actor_id = (n.get("attrs") or {}).get("actorId") or ""
            label = _actor_names.get().get(actor_id) or actor_id
            # `[@Name](url "paper:/actor/<id>")` (or bare `paper:/actor/<id>`
            # href if no resolver) — `@` inside the link text so it renders as a
            # single "@Name" link; the canonical `paper:/actor/` ref lets the
            # parser detect mentions unambiguously. Percent-encode the id so the
            # canonical stays well-formed.
            canonical = f"paper:/actor/{quote(actor_id, safe='')}"
            _kind, url = _resolve_resource("actor", actor_id)
            out.append(_ref_link("@" + label, canonical, url))
        elif t == "tag":
            tag = (n.get("attrs") or {}).get("tag") or ""
            # `[#tag](url "paper:/tag/<slug>")` (or bare href) — `#` inside the
            # link text so it renders as a single "#tag" link; the canonical
            # `paper:/tag/` ref lets the parser detect inline tags unambiguously
            # (a bare `#tag` would collide with ATX headings). Slugs are
            # normalized at every input path so `]` can't occur. Percent-encode
            # the slug for the canonical.
            canonical = f"paper:/tag/{quote(tag, safe='')}"
            _kind, url = _resolve_resource("tag", tag)
            out.append(_ref_link("#" + tag, canonical, url))
        elif t == "inline_embed":
            ref = (n.get("attrs") or {}).get("ref") or ""
            # `[label](url "paper:/embed/<kind>/<ref>")` (or bare canonical
            # href). The canonical ref's slashes stay raw (`safe='/'`) so the
            # path is readable, but spaces / `%` / other awkward chars are
            # percent-encoded so the markdown link destination round-trips
            # losslessly; the parser `unquote`s it back. There is no resolved
            # label at serialize time, so the ref doubles as the label.
            #
            # The provider `kind` and resource `url` come from the resolver
            # (ticket 04): an embed claimed by a provider gets that provider's
            # kind + its `resource_url(ref)`; an unclaimed (core Datasette) ref
            # falls back to kind "datasette". The ref begins with "/", so the
            # concatenation `paper:/embed/<kind>` + ref is a valid path.
            ref_path = ref if ref.startswith("/") else "/" + ref
            encoded_ref = quote(ref_path, safe="/")
            kind, url = _resolve_resource("embed", ref)
            kind = kind or "datasette"
            canonical = f"paper:/embed/{kind}{encoded_ref}"
            out.append(_ref_link(ref, canonical, url))
        elif t == "value":
            # An inline computed SQL value, referencing a `source` block by
            # name. Round-trips as `${{source.column}}`. The leading `$` keeps
            # it disjoint from the `placeholder` node's bare `{{key}}` above, so
            # the parser can tell the two apart unambiguously. An optional
            # `| kind:arg` suffix carries the per-value `format` (see
            # `_encode_value_format`); a null format emits the bare form.
            attrs = n.get("attrs") or {}
            source = str(attrs.get("source") or "")
            column = str(attrs.get("column") or "")
            fmt = _encode_value_format(attrs.get("format"))
            suffix = f" | {fmt}" if fmt else ""
            out.append("${{" + source + "." + column + suffix + "}}")

    close_through(0)
    return "".join(out)
