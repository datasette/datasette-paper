"""Markdown → ProseMirror JSON converter.

Pairs with ``datasette_paper.markdown.doc_to_markdown`` for the reverse
direction. Round-trip stable for the schema's supported node set;
intentionally lossy for content outside ``pm_schema`` (raw HTML renders
as plain text, strikethrough is dropped, etc.).

Schema lock-step group: this module, ``datasette_paper.pm_schema``,
``datasette_paper.markdown``, and ``frontend/src/lib/schema.ts`` must
all reflect the same nodes/marks. Adding a node here without mirroring
in the others will produce docs that fail ``Step.apply`` on the server.

Public API:

* ``markdown_to_doc(md)`` — full ``{"type": "doc", ...}`` node.
* ``markdown_to_fragment(md)`` — list of top-level block nodes, ready
  to splice into a PM ``ReplaceStep`` via
  ``Slice(Fragment.from_array(...), 0, 0)``.
"""

from __future__ import annotations

import re
from urllib.parse import unquote

from markdown_it import MarkdownIt
from mdit_py_plugins.tasklists import tasklists_plugin

from .util import normalize_tag


_MARK_OPEN_CLOSE = {
    "strong_open": ("strong_close", "strong"),
    "em_open": ("em_close", "em"),
    "link_open": ("link_close", "link"),
}

# Block-level node types — used to decide whether table-cell content needs a
# paragraph wrapper. Mirror of pm_schema's `block` group.
_BLOCK_TYPES = {
    "paragraph",
    "heading",
    "blockquote",
    "bullet_list",
    "ordered_list",
    "task_list",
    "code_block",
    "horizontal_rule",
    "table",
}


def _build_md() -> MarkdownIt:
    # ``commonmark`` preset + tables (GFM) + tasklists. ``html=False`` keeps
    # raw HTML from sneaking into the doc — anything that looks like HTML
    # falls back to plain text, which is safe for our schema.
    return (
        MarkdownIt("commonmark", {"html": False}).enable("table").use(tasklists_plugin)
    )


def markdown_to_doc(md_src: str) -> dict:
    """Parse CommonMark + GFM tables + tasklists into a PM ``doc`` node."""
    md = _build_md()
    tokens = md.parse(md_src or "")
    return _tokens_to_doc(tokens)


def markdown_to_fragment(md_src: str) -> list[dict]:
    """Parse markdown into a list of top-level block nodes.

    For an empty / whitespace-only input this returns ``[]`` rather than the
    placeholder paragraph that ``markdown_to_doc`` synthesises, so callers
    appending content don't insert an extra empty paragraph.
    """
    doc = markdown_to_doc(md_src)
    blocks = doc.get("content") or []
    # Strip the synthetic empty paragraph that markdown_to_doc inserts when
    # the input is empty — callers appending don't want it.
    if (
        len(blocks) == 1
        and blocks[0].get("type") == "paragraph"
        and not blocks[0].get("content")
    ):
        return []
    return blocks


# ---------------------------------------------------------------------------
# Block walker
# ---------------------------------------------------------------------------


def _tokens_to_doc(tokens) -> dict:
    root: dict = {"type": "doc", "content": []}
    stack: list[dict] = [root]
    # We need to know whether we're inside a `bullet_list` that was tagged as
    # a task list, so the inner `list_item_open` knows to emit `task_item`
    # instead of `list_item`. The frame is independent of the block stack
    # because lists can nest inside other things.
    list_kind_stack: list[str] = []

    def push(node: dict) -> dict:
        stack[-1].setdefault("content", []).append(node)
        stack.append(node)
        return node

    def pop() -> None:
        stack.pop()

    def append(node: dict) -> None:
        stack[-1].setdefault("content", []).append(node)

    for tok in tokens:
        t = tok.type

        if t == "heading_open":
            push(
                {"type": "heading", "attrs": {"level": int(tok.tag[1:])}, "content": []}
            )
        elif t == "heading_close":
            pop()

        elif t == "paragraph_open":
            push({"type": "paragraph", "content": []})
        elif t == "paragraph_close":
            pop()

        elif t == "blockquote_open":
            push({"type": "blockquote", "content": []})
        elif t == "blockquote_close":
            # blockquote content spec is `block+` — synthesise an empty
            # paragraph for the rare `>` (no content) edge case.
            if not stack[-1].get("content"):
                stack[-1]["content"] = [{"type": "paragraph"}]
            pop()

        elif t == "bullet_list_open":
            if _has_class(tok, "contains-task-list"):
                push({"type": "task_list", "content": []})
                list_kind_stack.append("task_list")
            else:
                push({"type": "bullet_list", "content": []})
                list_kind_stack.append("bullet_list")
        elif t == "bullet_list_close":
            list_kind_stack.pop()
            pop()

        elif t == "ordered_list_open":
            start = (tok.attrs or {}).get("start")
            node: dict = {"type": "ordered_list", "content": []}
            if start is not None:
                node["attrs"] = {"order": int(start)}
            push(node)
            list_kind_stack.append("ordered_list")
        elif t == "ordered_list_close":
            list_kind_stack.pop()
            pop()

        elif t == "list_item_open":
            current_list = list_kind_stack[-1] if list_kind_stack else None
            if current_list == "task_list":
                # pm_schema requires `task_list = task_item+`. The tasklist
                # plugin tags the parent <ul> with `contains-task-list` if at
                # least one child has a checkbox, but other children in the
                # same list keep the plain `<li>` class. Force every item to
                # task_item — _strip_task_checkbox handles the absent-checkbox
                # case by leaving the inline alone and returning checked=False.
                push({"type": "task_item", "attrs": {"checked": False}, "content": []})
            else:
                push({"type": "list_item", "content": []})
        elif t == "list_item_close":
            _ensure_leading_paragraph(stack[-1])
            pop()

        elif t == "inline":
            current = stack[-1]
            # A task_item's first paragraph has a leading checkbox token we
            # need to strip + use to set the item's `checked` attr.
            if (
                current.get("type") == "paragraph"
                and len(stack) >= 2
                and stack[-2].get("type") == "task_item"
                and not current.get("content")
            ):
                checked = _strip_task_checkbox(tok)
                stack[-2]["attrs"]["checked"] = checked
            inline_nodes = _inline_to_pm(tok)
            if inline_nodes:
                current.setdefault("content", []).extend(inline_nodes)

        elif t == "hr":
            append({"type": "horizontal_rule"})

        elif t in ("fence", "code_block"):
            text = tok.content or ""
            if text.endswith("\n"):
                text = text[:-1]
            # A fence whose info string is `datasette-embed` is a block embed,
            # not a code block: first line = ref path, optional `mode: <mode>`
            # line. (Indented code_block tokens carry no info string.)
            info = (getattr(tok, "info", "") or "").strip()
            if t == "fence" and info == "datasette-embed":
                lines = text.split("\n")
                ref = lines[0].strip() if lines else ""
                mode = "table"
                for line in lines[1:]:
                    stripped = line.strip()
                    if stripped.startswith("mode:"):
                        mode = stripped[len("mode:") :].strip() or "table"
                append(
                    {
                        "type": "datasette_embed",
                        "attrs": {"ref": ref or None, "mode": mode},
                    }
                )
                continue
            cb: dict = {"type": "code_block", "content": []}
            if text:
                cb["content"].append({"type": "text", "text": text})
            append(cb)

        elif t == "table_open":
            push({"type": "table", "attrs": {"name": None}, "content": []})
        elif t == "table_close":
            pop()

        elif t in ("thead_open", "tbody_open", "thead_close", "tbody_close"):
            # Our schema has no thead/tbody — rows go straight under `table`.
            pass

        elif t == "tr_open":
            push({"type": "table_row", "content": []})
        elif t == "tr_close":
            pop()

        elif t == "th_open":
            push(
                {
                    "type": "table_header",
                    "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                    "content": [],
                }
            )
        elif t == "th_close":
            _ensure_block_content(stack[-1])
            pop()

        elif t == "td_open":
            push(
                {
                    "type": "table_cell",
                    "attrs": {"colspan": 1, "rowspan": 1, "colwidth": None},
                    "content": [],
                }
            )
        elif t == "td_close":
            _ensure_block_content(stack[-1])
            pop()

        elif t == "html_block":
            # We don't model raw HTML — stash as a code_block so the content
            # is preserved verbatim rather than silently dropped.
            append(
                {
                    "type": "code_block",
                    "content": [{"type": "text", "text": tok.content.rstrip("\n")}],
                }
            )

        # Anything else (e.g. unsupported plugins firing on us) is skipped.

    if not root["content"]:
        root["content"].append({"type": "paragraph"})
    return root


# ---------------------------------------------------------------------------
# Inline walker
# ---------------------------------------------------------------------------


def _inline_to_pm(inline_token) -> list[dict]:
    """Convert an ``inline`` token's children into a list of PM inline nodes."""
    raw: list[dict] = []
    # Marks open/close via paired tokens. We keep a stack so the topmost open
    # mark is the first one in `node.marks`. A `{"_drop": True}` entry is a
    # sentinel for an open mark we chose not to materialize (e.g. an empty
    # href link) — it keeps the stack balanced for the matching close.
    mark_stack: list[dict] = []

    def real_marks() -> list[dict]:
        return [dict(m) for m in mark_stack if not m.get("_drop")]

    def push_text(text: str) -> None:
        if not text:
            return
        node: dict = {"type": "text", "text": text}
        marks = real_marks()
        if marks:
            node["marks"] = marks
        raw.append(node)

    for c in inline_token.children or []:
        t = c.type

        if t == "text":
            push_text(c.content)

        elif t == "code_inline":
            node = {"type": "text", "text": c.content}
            node["marks"] = real_marks() + [{"type": "code"}]
            raw.append(node)

        elif t == "softbreak":
            # CommonMark rendering rule: softbreak → literal space.
            push_text(" ")

        elif t == "hardbreak":
            raw.append({"type": "hard_break"})

        elif t == "image":
            attrs = dict(c.attrs or {})
            raw.append(
                {
                    "type": "image",
                    "attrs": {
                        "src": attrs.get("src", ""),
                        "alt": c.content or attrs.get("alt", ""),
                        "title": attrs.get("title"),
                    },
                }
            )

        elif t == "html_inline":
            # With html=False the only html_inline tokens are the tasklist
            # plugin's checkbox markers, which we handle at the block level.
            # Drop anything else as a no-op.
            pass

        elif t in _MARK_OPEN_CLOSE:
            mark_name = _MARK_OPEN_CLOSE[t][1]
            if mark_name == "link":
                attrs = dict(c.attrs or {})
                href = attrs.get("href") or ""
                if not href:
                    # pm_schema.link requires href — drop the mark for empty
                    # hrefs and let the wrapped text fall through unmarked.
                    mark_stack.append({"_drop": True})
                else:
                    mark_attrs: dict = {"href": href}
                    title = attrs.get("title")
                    if title:
                        mark_attrs["title"] = title
                    mark_stack.append({"type": "link", "attrs": mark_attrs})
            else:
                mark_stack.append({"type": mark_name})

        elif t in ("strong_close", "em_close", "link_close"):
            wanted = t.replace("_close", "")
            for j in range(len(mark_stack) - 1, -1, -1):
                m = mark_stack[j]
                if wanted == "link" and m.get("_drop"):
                    mark_stack.pop(j)
                    break
                if m.get("type") == wanted:
                    mark_stack.pop(j)
                    break

        # Unknown inline token kinds are dropped — better silent than crashing
        # in a converter that runs over arbitrary user input.

    return _coalesce_text(
        _split_paper_links(
            _convert_datasette_refs(_convert_tag_links(_convert_actor_mentions(raw)))
        )
    )


def _coalesce_text(nodes: list[dict]) -> list[dict]:
    """Merge adjacent text nodes with identical mark sets.

    PM treats two text nodes with the same marks as equivalent to a single
    text node; round-trips through the markdown serializer collapse them.
    Coalescing at conversion time keeps md → doc → md → doc stable.
    """
    out: list[dict] = []
    for node in nodes:
        if (
            node.get("type") == "text"
            and out
            and out[-1].get("type") == "text"
            and out[-1].get("marks") == node.get("marks")
        ):
            out[-1]["text"] = out[-1]["text"] + node["text"]
        else:
            out.append(node)
    return out


_ACTOR_SCHEME = "actor:"


def _actor_link_href(node: dict) -> str | None:
    """Return the `actor:`-scheme href of a text node's link mark, or None.

    Mentions serialize as `[@Name](actor:<id>)`; markdown-it parses that into
    text wrapped in a ``link`` mark whose href carries the `actor:` scheme.
    """
    if node.get("type") != "text":
        return None
    for m in node.get("marks") or []:
        if m.get("type") == "link":
            href = (m.get("attrs") or {}).get("href") or ""
            if href.startswith(_ACTOR_SCHEME):
                return href
    return None


def _convert_actor_mentions(nodes: list[dict]) -> list[dict]:
    """Replace `actor:`-scheme link text with id-only `mention` atoms.

    Detection is purely by the link mark's URI scheme — no `@`-boundary or
    path heuristics, so ordinary `[text](https://…)` links are never touched.
    Consecutive text nodes sharing the same actor href fold into a single
    mention; the visible label and the link mark are dropped (the NodeView
    resolves the live display name). The actor id is the scheme-stripped,
    percent-decoded href.
    """
    out: list[dict] = []
    prev_href: str | None = None
    for node in nodes:
        href = _actor_link_href(node)
        if href is None:
            prev_href = None
            out.append(node)
            continue
        # Same mention's text continuing across split text nodes — the atom
        # was already emitted, so swallow the remaining label fragments.
        if href == prev_href:
            continue
        actor_id = unquote(href[len(_ACTOR_SCHEME) :])
        out.append({"type": "mention", "attrs": {"actorId": actor_id}})
        prev_href = href
    return out


_TAG_SCHEME = "tag:"


def _tag_link_href(node: dict) -> str | None:
    """Return the `tag:`-scheme href of a text node's link mark, or None.

    Inline tags serialize as `[#slug](tag:<slug>)`; markdown-it parses that
    into text wrapped in a ``link`` mark whose href carries the `tag:` scheme.
    """
    if node.get("type") != "text":
        return None
    for m in node.get("marks") or []:
        if m.get("type") == "link":
            href = (m.get("attrs") or {}).get("href") or ""
            if href.startswith(_TAG_SCHEME):
                return href
    return None


def _convert_tag_links(nodes: list[dict]) -> list[dict]:
    """Replace `tag:`-scheme link text with value-only `tag` atoms.

    Mirrors _convert_actor_mentions: detection is purely by the link mark's
    URI scheme, so ordinary `[text](https://…)` links are never touched.
    Consecutive text nodes sharing the same tag href fold into a single atom;
    the visible label and the link mark are dropped. The slug is the
    scheme-stripped, percent-decoded href.
    """
    out: list[dict] = []
    prev_href: str | None = None
    for node in nodes:
        href = _tag_link_href(node)
        if href is None:
            prev_href = None
            out.append(node)
            continue
        if href == prev_href:
            continue
        # Normalize through the same rule as typed / doc-level tags so a
        # hand-authored `tag:` href can't smuggle in a slug the editor could
        # never produce (uppercase, spaces, `]`, …). An un-normalizable slug
        # drops the atom (lossy, like other out-of-schema content) but still
        # advances prev_href so trailing fragments of the link fold away.
        tag = normalize_tag(unquote(href[len(_TAG_SCHEME) :]))
        if tag is not None:
            out.append({"type": "tag", "attrs": {"tag": tag}})
        prev_href = href
    return out


_DATASETTE_SCHEME = "datasette:"


def _datasette_link_href(node: dict) -> str | None:
    """Return the `datasette:`-scheme href of a text node's link mark, or None.

    Inline refs serialize as `[label](datasette:<path>)`; markdown-it parses
    that into text wrapped in a ``link`` mark whose href carries the
    `datasette:` scheme.
    """
    if node.get("type") != "text":
        return None
    for m in node.get("marks") or []:
        if m.get("type") == "link":
            href = (m.get("attrs") or {}).get("href") or ""
            if href.startswith(_DATASETTE_SCHEME):
                return href
    return None


def _convert_datasette_refs(nodes: list[dict]) -> list[dict]:
    """Replace `datasette:`-scheme link text with identity-only `datasette_ref`
    atoms.

    Mirrors _convert_actor_mentions: detection is purely by the link mark's
    URI scheme, so ordinary `[text](https://…)` links are never touched.
    Consecutive text nodes sharing the same href fold into a single atom; the
    visible label and the link mark are dropped (the NodeView resolves the live
    label). The ref path is the scheme-stripped, percent-decoded href.
    """
    out: list[dict] = []
    prev_href: str | None = None
    for node in nodes:
        href = _datasette_link_href(node)
        if href is None:
            prev_href = None
            out.append(node)
            continue
        if href == prev_href:
            continue
        ref = unquote(href[len(_DATASETTE_SCHEME) :])
        out.append({"type": "datasette_ref", "attrs": {"ref": ref}})
        prev_href = href
    return out


_PAPER_LINK_RE = re.compile(r"\[\[(\d+)\]\]")


def _split_paper_links(nodes: list[dict]) -> list[dict]:
    """Split `[[<int>]]` occurrences inside text nodes into `paper_link` atoms.

    markdown-it has no notion of our `[[id]]` link syntax, so it arrives as
    literal text; we post-process the emitted inline nodes here. Surrounding
    text keeps its marks; the `paper_link` atom carries none (a bold/italic
    span around a link is meaningless for an id-only reference). Only the
    digits-only form matches, so `[[notanumber]]` stays literal text.
    """
    out: list[dict] = []
    for node in nodes:
        if node.get("type") != "text":
            out.append(node)
            continue
        text = node["text"]
        marks = node.get("marks")
        last = 0
        matched = False
        for m in _PAPER_LINK_RE.finditer(text):
            matched = True
            if m.start() > last:
                seg = {"type": "text", "text": text[last : m.start()]}
                if marks:
                    seg["marks"] = marks
                out.append(seg)
            out.append({"type": "paper_link", "attrs": {"docId": int(m.group(1))}})
            last = m.end()
        if not matched:
            out.append(node)
            continue
        if last < len(text):
            seg = {"type": "text", "text": text[last:]}
            if marks:
                seg["marks"] = marks
            out.append(seg)
    return out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _has_class(tok, cls_name: str) -> bool:
    cls = (tok.attrs or {}).get("class", "")
    return cls_name in cls.split()


def _strip_task_checkbox(inline_token) -> bool:
    """Pull the leading checkbox out of a task_item's first paragraph.

    Mutates ``inline_token.children`` in place and returns whether the
    checkbox was checked.
    """
    children = list(inline_token.children or [])
    checked = False
    if children and children[0].type == "html_inline":
        html = children[0].content
        # The tasklist plugin emits ``checked="checked"`` for done items.
        checked = 'checked="checked"' in html
        children = children[1:]
        # The plugin leaves a single space after the checkbox; trim it.
        if (
            children
            and children[0].type == "text"
            and children[0].content.startswith(" ")
        ):
            children[0].content = children[0].content[1:]
            if not children[0].content:
                children = children[1:]
    inline_token.children = children
    return checked


def _ensure_block_content(node: dict) -> None:
    """Wrap loose inline content in a paragraph (table cells require ``block+``)."""
    content = node.get("content") or []
    if not content:
        node["content"] = [{"type": "paragraph"}]
        return
    if all(c.get("type") not in _BLOCK_TYPES for c in content):
        node["content"] = [{"type": "paragraph", "content": content}]


def _ensure_leading_paragraph(node: dict) -> None:
    """Guarantee ``list_item`` / ``task_item`` opens with a paragraph.

    pm_schema's content spec for both is ``paragraph block*``. Markdown
    permits weird shapes — `- # heading-only item`, an empty bullet, a list
    item whose only child is a code block — that produce a first child that
    isn't a paragraph. Prepend an empty paragraph instead of dropping the
    real content, so the item validates without losing structure.
    """
    content = node.get("content") or []
    if not content:
        node["content"] = [{"type": "paragraph"}]
        return
    if content[0].get("type") != "paragraph":
        node["content"] = [{"type": "paragraph"}, *content]


__all__ = ["markdown_to_doc", "markdown_to_fragment"]
