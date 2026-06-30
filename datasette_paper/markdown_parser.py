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

import json
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

# Cap on the length of an inline `data:` image `src`. A multi-MB base64 blob
# rides the append-only step log + every snapshot + the SSE broadcast, so an
# oversized inline image is dropped here (its `alt` is kept as plain text where
# possible). Ordinary `http(s)` refs are cheap pointers and pass through
# untouched — the limit is specifically about inlined bytes. Mirrors the
# browser-side `MAX_IMAGE_BYTES` guard in `frontend/src/lib/image.ts`; the
# string length is the on-the-wire cost so we compare it directly.
MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024


def _is_oversized_data_src(src: str) -> bool:
    return src.startswith("data:") and len(src) > MAX_INLINE_IMAGE_BYTES


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
    "sql_block",
    "source",
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
    # Out-of-band table name carried by a `paper-table` sidecar fence; consumed
    # by the next `table_open` (the serializer emits the fence immediately
    # before its table). None means no name pending.
    pending_table_name: str | None = None

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
                # @feat task-list: parse a contains-task-list <ul> into a task_list node
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
            # A fence whose info string is `paper-embed` is a block embed, not a
            # code block: the body is one JSON object `{ref, mode, config}`
            # mirroring the node attrs. (Indented code_block tokens carry no
            # info string.) Be defensive — a hand-edited / malformed body must
            # never raise; fall back to an empty/`table` embed.
            info = (getattr(tok, "info", "") or "").strip()
            # A fence whose info string is `paper-table` is the out-of-band
            # sidecar carrying the `name` attr of the table that immediately
            # follows (GFM has no slot for it). The body is one JSON object
            # `{"name": <name>}`. Stash the name; the next `table_open` consumes
            # it. Emit no node of its own. Be defensive — a malformed body must
            # never raise; it just yields no pending name.
            if t == "fence" and info == "paper-table":
                try:
                    data = json.loads(text)
                    name = data.get("name") if isinstance(data, dict) else None
                except (ValueError, TypeError):
                    name = None
                pending_table_name = name if isinstance(name, str) else None
                continue
            # @feat block-embed: parse paper-embed JSON fence back into block_embed atom
            if t == "fence" and info == "paper-embed":
                try:
                    data = json.loads(text)
                    if not isinstance(data, dict):
                        raise ValueError
                except (ValueError, TypeError):
                    data = {}
                config = data.get("config")
                append(
                    {
                        "type": "block_embed",
                        "attrs": {
                            "ref": data.get("ref") or None,
                            "mode": data.get("mode") or "table",
                            "config": config if isinstance(config, dict) else {},
                        },
                    }
                )
                continue
            # A fence whose info string is `paper-toc` is a table-of-contents
            # block: the body is the optional config JSON (empty body → {}).
            # The heading list is derived at render time, never stored. Be
            # defensive — a malformed body must never raise.
            if t == "fence" and info == "paper-toc":
                try:
                    data = json.loads(text) if text.strip() else {}
                    if not isinstance(data, dict):
                        raise ValueError
                except (ValueError, TypeError):
                    data = {}
                append({"type": "toc", "attrs": {"config": data}})
                continue
            # A fence whose info string starts with `source` is a named SQL
            # query ("source") that inline `value` atoms reference by name.
            # The leading `source` token is the discriminator (checked before
            # the `sql` branch so neither shadows the other).
            # @feat source: parse a source-prefixed fence back into a source node
            if t == "fence" and info.split()[:1] == ["source"]:
                name = None
                db = None
                for token in info.split()[1:]:
                    if token.startswith("name="):
                        name = token[len("name=") :] or None
                    elif token.startswith("db="):
                        db = token[len("db=") :] or None
                source_block: dict = {
                    "type": "source",
                    "attrs": {"name": name, "db": db},
                    "content": [],
                }
                if text:
                    source_block["content"].append({"type": "text", "text": text})
                append(source_block)
                continue
            # A fence whose info string is `sql db=NAME [hidden]` is an
            # editable SQL query block. The leading `sql` token plus a `db=`
            # token are the discriminator: the serializer always emits `db=`
            # (empty for a db-less block, `sql db=`), so its *presence* — not a
            # populated value — separates a runnable sql_block from a plain
            # ```sql display code block (which carries no `db=` token).
            sql_tokens = info.split()
            if (
                t == "fence"
                and sql_tokens[:1] == ["sql"]
                and any(tok.startswith("db=") for tok in sql_tokens[1:])
            ):
                db = None
                hidden = False
                for token in sql_tokens[1:]:
                    if token.startswith("db="):
                        db = token[len("db=") :] or None
                    elif token == "hidden":
                        hidden = True
                # @feat sql-block: parse a ```sql db=NAME fence into a sql_block node
                sql_block: dict = {
                    "type": "sql_block",
                    "attrs": {"db": db, "hidden": hidden},
                    "content": [],
                }
                if text:
                    sql_block["content"].append({"type": "text", "text": text})
                append(sql_block)
                continue
            cb: dict = {"type": "code_block", "content": []}
            if text:
                cb["content"].append({"type": "text", "text": text})
            append(cb)

        # @feat tables: parse a GFM table open into a table node, consuming pending name
        elif t == "table_open":
            # Consume any name stashed by a preceding `paper-table` sidecar
            # fence; reset so it can't leak onto a later unnamed table.
            push(
                {
                    "type": "table",
                    "attrs": {"name": pending_table_name},
                    "content": [],
                }
            )
            pending_table_name = None
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


def _image_alt_text(image_token) -> str:
    """Reconstruct an image's literal alt text from its child tokens.

    markdown-it keeps the *raw* (still-escaped) alt in ``token.content``, so a
    serialized ``![a\\]b](u)`` would otherwise read back as the literal
    ``a\\]b``. The image token's children carry the parsed inline run, where
    ``text`` / ``text_special`` nodes already hold the un-escaped characters —
    concatenating those recovers what the serializer's ``_escape_image_alt``
    encoded, so the round-trip is lossless.
    """
    children = getattr(image_token, "children", None)
    if not children:
        return image_token.content or ""
    parts: list[str] = []
    for tok in children:
        if tok.type in ("text", "text_special", "code_inline"):
            parts.append(tok.content)
        elif tok.type in ("softbreak", "hardbreak"):
            parts.append(" ")
    return "".join(parts)


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
            src = attrs.get("src", "")
            alt = _image_alt_text(c) or attrs.get("alt", "")
            if _is_oversized_data_src(src):
                # Drop the oversized inline image but keep its alt as plain
                # text so the surrounding prose isn't silently mangled.
                if alt:
                    push_text(alt)
            else:
                raw.append(
                    {
                        "type": "image",
                        "attrs": {
                            "src": src,
                            "alt": alt,
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
        _split_sql_values(_split_paper_links(_convert_paper_refs(raw)))
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


_PAPER_SCHEME = "paper:/"  # note: scheme + leading path slash


def _parse_paper_ref(href: str) -> tuple[str, str]:
    """Split a `paper:/<type>/<value>` href into ``(type, value)``.

    Splits ONCE on the slash after the type so the value keeps any raw
    slashes it contains (critical for embed refs)::

        "paper:/actor/lois"                      -> ("actor", "lois")
        "paper:/tag/q3"                          -> ("tag", "q3")
        "paper:/embed/datasette/fixtures/face"   -> ("embed", "datasette/fixtures/face")
    """
    rest = href[len(_PAPER_SCHEME) :]
    kind, _, value = rest.partition("/")
    return kind, value


def _paper_ref_canonical(node: dict) -> str | None:
    """Return a text node's `paper:/`-scheme reference, or None.

    The canonical ref lives in the link mark's ``title`` (ticket 04's
    round-trip-safe channel) when present, otherwise the ``href``. A plain
    external link — `paper:/` in neither slot — returns None and is left as an
    ordinary link mark (the safety property).
    """
    if node.get("type") != "text":
        return None
    for m in node.get("marks") or []:
        if m.get("type") == "link":
            attrs = m.get("attrs") or {}
            title = attrs.get("title") or ""
            if title.startswith(_PAPER_SCHEME):
                return title
            href = attrs.get("href") or ""
            if href.startswith(_PAPER_SCHEME):
                return href
    return None


def _paper_ref_to_node(kind: str, value: str) -> dict | None:
    """Build the PM atom for a parsed `(kind, value)` paper ref, or None to drop.

    - ``actor`` → ``mention`` (actorId = percent-decoded value)
    - ``tag``   → ``tag`` (normalized; un-normalizable drops the atom)
    - ``embed`` → ``inline_embed`` (value is `<provider-kind>/<ref>`; split once
      more, re-add the leading slash stripped during serialize). The provider
      kind is informational at parse time — the frontend re-derives the provider
      from ``ref_prefixes`` — so it isn't stored (the schema has no `kind` attr).
    """
    # @feat mention: parse paper:/actor/ ref into a mention atom
    if kind == "actor":
        return {"type": "mention", "attrs": {"actorId": unquote(value)}}
    # @feat tag: parse paper:/tag/ ref, normalize slug, build tag atom
    if kind == "tag":
        # Normalize through the same rule as typed / doc-level tags so a
        # hand-authored ref can't smuggle in a slug the editor could never
        # produce (uppercase, spaces, `]`, …).
        tag = normalize_tag(unquote(value))
        if tag is None:
            return None
        return {"type": "tag", "attrs": {"tag": tag}}
    # @feat inline-embed: parse paper:/embed ref link back into inline_embed atom
    if kind == "embed":
        # value is "<provider-kind>/<ref-without-leading-slash>". Split once;
        # the entire remainder is the ref (it can contain raw slashes). The ref
        # is percent-decoded (serialize encodes spaces / `%` but keeps slashes)
        # and the leading slash stripped during serialize is restored.
        _provider_kind, _, ref = value.partition("/")
        return {"type": "inline_embed", "attrs": {"ref": "/" + unquote(ref)}}
    return None


def _convert_paper_refs(nodes: list[dict]) -> list[dict]:
    """Replace `paper:/`-scheme link text with the matching reference atom.

    Detection is purely by the link mark's `paper:/` scheme (read title-first,
    href-fallback) so ordinary `[text](https://…)` links are never touched.
    Consecutive text nodes sharing the same canonical ref fold into a single
    atom; the visible label and the link mark are dropped (the NodeView resolves
    the live label / display name).
    """
    out: list[dict] = []
    prev_ref: str | None = None
    for node in nodes:
        canonical = _paper_ref_canonical(node)
        if canonical is None:
            prev_ref = None
            out.append(node)
            continue
        # Same ref's text continuing across split text nodes — the atom was
        # already emitted, so swallow the remaining label fragments.
        if canonical == prev_ref:
            continue
        kind, value = _parse_paper_ref(canonical)
        atom = _paper_ref_to_node(kind, value)
        if atom is not None:
            out.append(atom)
        # Advance prev_ref even when the atom dropped (un-normalizable tag) so
        # trailing fragments of the link still fold away.
        prev_ref = canonical
    return out


_PAPER_LINK_RE = re.compile(r"\[\[(\d+)\]\]")


def _split_text_nodes(nodes, regex, make_atom):
    """Split `regex` occurrences inside text nodes into the atom returned by
    `make_atom(match)`.

    markdown-it has no notion of our custom inline syntaxes, so they arrive as
    literal text; we post-process the emitted inline nodes here. Surrounding
    text keeps its marks; the atom carries none. Non-text nodes and text that
    doesn't match pass through untouched.
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
        for m in regex.finditer(text):
            matched = True
            if m.start() > last:
                seg = {"type": "text", "text": text[last : m.start()]}
                if marks:
                    seg["marks"] = marks
                out.append(seg)
            out.append(make_atom(m))
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


# @feat paper-link: parse [[id]] markdown back into paper_link atoms
def _split_paper_links(nodes: list[dict]) -> list[dict]:
    """Split `[[<int>]]` occurrences inside text nodes into `paper_link` atoms.

    The `paper_link` atom carries no marks (a bold/italic span around a link is
    meaningless for an id-only reference). Only the digits-only form matches, so
    `[[notanumber]]` stays literal text.
    """
    return _split_text_nodes(
        nodes,
        _PAPER_LINK_RE,
        lambda m: {"type": "paper_link", "attrs": {"docId": int(m.group(1))}},
    )


# `${{source.column}}` — the leading `$` is what keeps this disjoint from the
# @feat placeholder: (write-only) bare {{key}} is intentionally NOT parsed back
# `placeholder` node's bare `{{key}}` (which markdown.py emits but never parses
# back), so the two never collide. The source is always a bare `\w+` (names are
# normalized to `[a-z0-9_]+`); the column is either a bare `\w+` OR a bracketed
# `[...]` form (`${{src.[total sales]}}`) so DB-derived columns containing
# spaces / hyphens / dots survive — the bracket body is anything up to the
# closing `]`. A bare `{{key}}` or a half-typed `${{` stays literal text. An
# optional `| kind:arg` suffix carries the per-value `format` (decoded by
# `_decode_value_format`).
_SQL_VALUE_RE = re.compile(
    r"\$\{\{\s*(\w+)\.(?:\[([^\]]+)\]|(\w+))\s*(?:\|\s*([^}]+?))?\s*\}\}"
)

_VALID_DATE_STYLES = {"iso", "medium", "long"}


def _decode_value_format(s):
    """Decode a `value` node's `| kind:arg` markdown suffix into a `format`
    dict. Inverse of `_encode_value_format` in `markdown.py` and mirror of
    `decodeFormat` in `frontend/src/lib/formatValue.ts` — keep the three in
    lock-step. Unknown/malformed → None (the caller keeps the ref, drops the
    format)."""
    if s is None:
        return None
    trimmed = s.strip()
    if trimmed == "":
        return None
    kind, sep, arg = trimmed.partition(":")
    kind = kind.strip()
    arg = arg.strip()
    if kind in ("number", "percent"):
        if arg == "":
            return {"kind": kind}
        if not arg.isdigit():
            return None
        return {"kind": kind, "decimals": int(arg)}
    if kind == "currency":
        return {"kind": "currency", "currency": arg} if arg else {"kind": "currency"}
    if kind == "date":
        if arg == "":
            return {"kind": "date"}
        if arg not in _VALID_DATE_STYLES:
            return None
        return {"kind": "date", "style": arg}
    if kind == "text":
        return {"kind": "text"}
    return None


# @feat value: split ${{source.column}} text matches into value atoms
def _split_sql_values(nodes: list[dict]) -> list[dict]:
    """Split `${{source.column}}` occurrences inside text nodes into `value`
    atoms. The `value` atom carries no marks.
    """
    return _split_text_nodes(
        nodes,
        _SQL_VALUE_RE,
        lambda m: {
            "type": "value",
            "attrs": {
                "source": m.group(1),
                # group 2 = bracketed column body, group 3 = bare `\w+` column;
                # exactly one matches.
                "column": m.group(2) if m.group(2) is not None else m.group(3),
                "format": _decode_value_format(m.group(4)),
            },
        },
    )


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
