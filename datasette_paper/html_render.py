"""Render a ProseMirror JSON doc to static, read-only HTML (publishing).

This is the fifth member of the schema lock-step group
(``frontend/src/lib/schema.ts`` ↔ ``pm_schema.py`` ↔ ``markdown.py`` ↔
``markdown_parser.py`` ↔ this module): every node/mark the schema accepts must
have a rendering here. It mirrors each node's ``toDOM`` from ``schema.ts`` but
emits *final* HTML strings rather than ProseMirror DOM specs, so a published
page looks like the editor minus all editing chrome.

Prose (paragraphs, headings, lists, blockquotes, code blocks, author tables,
task lists) renders to its final form. Inline atoms (mentions, paper-links,
tags, placeholders) render with their resolved label baked in. **Data-bearing**
blocks (``sql_block`` / ``source`` / ``block_embed`` / ``value`` /
``inline_embed``) render per their *data mode*:

* ``live`` — emit a placeholder carrying the node's ``data-*`` config plus
  ``data-publish-live="1"`` and ``data-block-id``; the client hydrator
  (``frontend/src/pages/publish``) fetches + renders it per-viewer.
* ``frozen`` — render the baked payload inline (see ``payloads`` arg). The
  publish pipeline computes those payloads once at publish time.

``block_id`` is a document-order ordinal (``b0``, ``b1`` …) assigned over the
data-bearing nodes during the walk. It is stable within an immutable published
version and is the key the frozen-payload store and the live hydrator both use.

Output safety: all doc content + resolved labels + query payloads are
HTML-escaped and inserted as text; only this module's own structural markup is
raw. Mirrors the editor's "cell values enter the DOM as text nodes" rule.
"""

from __future__ import annotations

import html
import json
from dataclasses import dataclass, field
from typing import Callable, Optional

# Inline atoms that carry no editable text content (used to decide whether a
# node's children should be recursed into as inlines).
_HEADING_MAX = 6


@dataclass
class Labels:
    """Server-resolved identity labels for inline atoms.

    Each callable is optional; absent one, the renderer falls back to the same
    static label the node's ``toDOM`` uses. The publish route resolves these
    asynchronously (mention names, paper-link titles, embed labels) and passes
    the resulting lookups in; the renderer itself stays pure + synchronous.
    """

    actor: Optional[Callable[[str], Optional[str]]] = None
    # paper(doc_id) -> {"title": str, "href": str, "state": str} | None
    paper: Optional[Callable[[int], Optional[dict]]] = None
    embed: Optional[Callable[[str], Optional[str]]] = None

    def actor_label(self, actor_id: str) -> str:
        if self.actor:
            try:
                got = self.actor(actor_id)
                if got:
                    return got
            except Exception:
                pass
        return actor_id or "?"

    def paper_info(self, doc_id) -> dict:
        if self.paper and doc_id is not None:
            try:
                got = self.paper(doc_id)
                if got:
                    return got
            except Exception:
                pass
        return {
            "title": f"Paper {doc_id if doc_id is not None else '?'}",
            "href": f"/-/paper/doc/{doc_id}" if doc_id is not None else "#",
            "state": "ok",
        }

    def embed_label(self, ref: str) -> str:
        if self.embed and ref:
            try:
                got = self.embed(ref)
                if got:
                    return got
            except Exception:
                pass
        return ref or "?"


@dataclass
class DataBlock:
    """A data-bearing node discovered during the render walk.

    ``config`` carries everything the live hydrator or the frozen executor
    needs: ``{db, sql}`` for sql/source, ``{ref, mode, config}`` for embeds,
    ``{source, column, format}`` for values, ``{ref}`` for inline embeds.
    ``name`` is the source name (``source`` blocks only).
    """

    block_id: str
    kind: str  # 'sql' | 'source' | 'embed' | 'value' | 'inline_embed'
    config: dict
    name: Optional[str] = None


@dataclass
class RenderResult:
    html: str
    blocks: list[DataBlock] = field(default_factory=list)
    has_live_blocks: bool = False


def _esc(text) -> str:
    """Escape text for an HTML text node."""
    return html.escape("" if text is None else str(text), quote=False)


def _attr(value) -> str:
    """Escape a value for use inside a double-quoted HTML attribute."""
    return html.escape("" if value is None else str(value), quote=True)


def doc_to_html(
    doc: dict,
    *,
    labels: Optional[Labels] = None,
    mode_for: Optional[Callable[[str], str]] = None,
    payloads: Optional[dict] = None,
) -> str:
    """Convenience wrapper returning just the HTML body. See :func:`render_doc`."""
    return render_doc(doc, labels=labels, mode_for=mode_for, payloads=payloads).html


def render_doc(
    doc: dict,
    *,
    labels: Optional[Labels] = None,
    mode_for: Optional[Callable[[str], str]] = None,
    payloads: Optional[dict] = None,
) -> RenderResult:
    """Render a ``doc`` node to a :class:`RenderResult`.

    ``labels`` resolves inline-atom identity labels (defaults to static
    fallbacks). ``mode_for(block_id)`` returns ``"live"`` or ``"frozen"`` for
    each data block (defaults to all-live). ``payloads`` maps ``block_id`` →
    baked payload dict for frozen blocks (defaults to empty).
    """
    if doc.get("type") != "doc":
        raise ValueError("expected top-level 'doc' node")
    renderer = _Renderer(
        labels=labels or Labels(),
        mode_for=mode_for or (lambda _block_id: "live"),
        payloads=payloads or {},
    )
    body = renderer.render_blocks(doc.get("content") or [])
    return RenderResult(
        html=body,
        blocks=renderer.blocks,
        has_live_blocks=renderer.has_live_blocks,
    )


class _Renderer:
    def __init__(self, *, labels: Labels, mode_for, payloads: dict) -> None:
        self.labels = labels
        self.mode_for = mode_for
        self.payloads = payloads
        self.blocks: list[DataBlock] = []
        self.has_live_blocks = False
        self._counter = 0

    # -- data-block bookkeeping ------------------------------------------

    def _next_block(self, kind: str, config: dict, *, name=None) -> tuple[str, str]:
        """Allocate a block_id, record the DataBlock, and resolve its mode."""
        block_id = f"b{self._counter}"
        self._counter += 1
        self.blocks.append(
            DataBlock(block_id=block_id, kind=kind, config=config, name=name)
        )
        mode = self.mode_for(block_id) or "live"
        if mode != "frozen":
            self.has_live_blocks = True
            mode = "live"
        return block_id, mode

    # -- block rendering -------------------------------------------------

    def render_blocks(self, nodes: list) -> str:
        return "".join(self.render_block(n) for n in nodes or [])

    def render_block(self, node: dict) -> str:
        t = node.get("type")
        attrs = node.get("attrs") or {}
        content = node.get("content") or []

        if t == "paragraph":
            return f"<p>{self.render_inlines(content)}</p>"
        if t == "heading":
            level = max(1, min(_HEADING_MAX, int(attrs.get("level", 1))))
            return f"<h{level}>{self.render_inlines(content)}</h{level}>"
        if t == "horizontal_rule":
            return "<hr>"
        if t == "code_block":
            text = "".join(c.get("text", "") for c in content)
            return f'<pre class="pm-code-block"><code>{_esc(text)}</code></pre>'
        if t == "blockquote":
            return f"<blockquote>{self.render_blocks(content)}</blockquote>"
        if t == "bullet_list":
            return f"<ul>{self._list_items(content)}</ul>"
        if t == "ordered_list":
            order = attrs.get("order")
            start = f' start="{int(order)}"' if order not in (None, 1) else ""
            return f"<ol{start}>{self._list_items(content)}</ol>"
        if t == "list_item":
            return f"<li>{self.render_blocks(content)}</li>"
        if t == "task_list":
            return f'<ul data-task-list="true">{self.render_blocks(content)}</ul>'
        if t == "task_item":
            checked = bool(attrs.get("checked", False))
            box = '<input type="checkbox" disabled%s>' % (" checked" if checked else "")
            return (
                '<li data-task-item="true" data-checked="%s">%s'
                '<div class="task-item-content">%s</div></li>'
                % ("true" if checked else "false", box, self.render_blocks(content))
            )
        if t == "table":
            return self._render_table(node)
        if t == "sql_block":
            return self._render_sql_block(node)
        if t == "source":
            return self._render_source_block(node)
        if t == "block_embed":
            return self._render_block_embed(node)
        # Unknown block: render any inline content, else nothing.
        if content:
            return f"<div>{self.render_inlines(content)}</div>"
        return ""

    def _list_items(self, items: list) -> str:
        # bullet/ordered list children are list_item nodes; render each as <li>.
        out = []
        for item in items or []:
            if item.get("type") == "list_item":
                out.append(f"<li>{self.render_blocks(item.get('content') or [])}</li>")
            else:  # defensive: stray non-list_item child
                out.append(self.render_block(item))
        return "".join(out)

    # -- tables ----------------------------------------------------------

    def _render_table(self, node: dict) -> str:
        attrs = node.get("attrs") or {}
        name = attrs.get("name")
        name_attr = f' data-name="{_attr(name)}"' if name else ""
        rows = "".join(self._render_table_row(r) for r in node.get("content") or [])
        return f"<table{name_attr}><tbody>{rows}</tbody></table>"

    def _render_table_row(self, row: dict) -> str:
        cells = "".join(self._render_table_cell(c) for c in row.get("content") or [])
        return f"<tr>{cells}</tr>"

    def _render_table_cell(self, cell: dict) -> str:
        tag = "th" if cell.get("type") == "table_header" else "td"
        a = cell.get("attrs") or {}
        extra = ""
        colspan = a.get("colspan")
        rowspan = a.get("rowspan")
        if colspan not in (None, 1):
            extra += f' colspan="{int(colspan)}"'
        if rowspan not in (None, 1):
            extra += f' rowspan="{int(rowspan)}"'
        return f"<{tag}{extra}>{self.render_blocks(cell.get('content') or [])}</{tag}>"

    # -- data blocks (live placeholder / frozen payload) -----------------

    def _render_sql_block(self, node: dict) -> str:
        attrs = node.get("attrs") or {}
        db = attrs.get("db") or ""
        sql = "".join(c.get("text", "") for c in node.get("content") or [])
        if attrs.get("hidden"):
            # Hidden SQL: viewers see only the results, never the query text.
            sql_html = ""
        else:
            sql_html = f'<pre class="pm-sql-src"><code>{_esc(sql)}</code></pre>'
        block_id, mode = self._next_block("sql", {"db": db, "sql": sql})
        head = (
            '<div class="pm-data-head">'
            f'<span class="pm-data-db">{_esc(db)}</span>'
            '<span class="pm-data-kind">SQL</span>'
            f"{self._mode_badge(mode)}</div>"
        )
        if mode == "frozen":
            body = self._frozen_table(self.payloads.get(block_id))
        else:
            body = '<div class="pm-data-slot">Loading live results…</div>'
        return (
            f'<div class="pm-sql-block" data-block-id="{block_id}"'
            f"{self._live_attrs(mode)}"
            f' data-sql-db="{_attr(db)}" data-sql="{_attr(sql)}">'
            f"{head}{sql_html}{body}</div>"
        )

    def _render_source_block(self, node: dict) -> str:
        attrs = node.get("attrs") or {}
        name = attrs.get("name") or ""
        db = attrs.get("db") or ""
        sql = "".join(c.get("text", "") for c in node.get("content") or [])
        block_id, mode = self._next_block(
            "source", {"db": db, "sql": sql, "name": name}, name=name
        )
        # A source renders only its definition card; its query result feeds the
        # inline `value` atoms (live: via the hydrator's source store; frozen:
        # baked into each value at publish time).
        head = (
            '<div class="pm-source-card-head">'
            '<span class="pm-source-card-sigil">§</span>'
            f'<span class="pm-source-card-name">{_esc(name)}</span>'
            f'<span class="pm-source-card-db">{_esc(db)}</span>'
            f"{self._mode_badge(mode)}</div>"
        )
        return (
            f'<div class="pm-source-card" data-block-id="{block_id}"'
            f"{self._live_attrs(mode)}"
            f' data-source-name="{_attr(name)}" data-source-db="{_attr(db)}"'
            f' data-sql="{_attr(sql)}">'
            f'{head}<pre class="pm-source-card-code"><code>{_esc(sql)}</code></pre>'
            "</div>"
        )

    def _render_block_embed(self, node: dict) -> str:
        attrs = node.get("attrs") or {}
        ref = attrs.get("ref") or ""
        mode_attr = attrs.get("mode") or "table"
        config = attrs.get("config") or {}
        config_json = json.dumps(config, sort_keys=True)
        block_id, mode = self._next_block(
            "embed", {"ref": ref, "mode": mode_attr, "config": config}
        )
        head = (
            '<div class="pm-data-head">'
            f'<span class="pm-data-ref">{_esc(ref)}</span>'
            f"{self._mode_badge(mode)}</div>"
        )
        if mode == "frozen":
            body = self._frozen_table(self.payloads.get(block_id))
        else:
            body = '<div class="pm-data-slot">Loading embed…</div>'
        return (
            f'<div class="pm-block-embed" data-block-id="{block_id}"'
            f"{self._live_attrs(mode)}"
            f' data-block-embed="{_attr(ref)}" data-embed-mode="{_attr(mode_attr)}"'
            f' data-embed-config="{_attr(config_json)}">'
            f"{head}{body}</div>"
        )

    def _frozen_table(self, payload: Optional[dict]) -> str:
        """Render a baked {columns, rows} payload as a static results table."""
        if not payload:
            return '<div class="pm-data-empty">No data</div>'
        columns = payload.get("columns") or []
        rows = payload.get("rows") or []
        thead = "".join(f"<th>{_esc(c)}</th>" for c in columns)
        body_rows = []
        for row in rows:
            cells = "".join(f"<td>{_esc(v)}</td>" for v in row)
            body_rows.append(f"<tr>{cells}</tr>")
        computed_at = payload.get("computed_at")
        footer = (
            f'<div class="pm-data-asof">data as of {_esc(computed_at)}</div>'
            if computed_at
            else ""
        )
        return (
            '<table class="pm-data-table"><thead><tr>'
            f"{thead}</tr></thead><tbody>{''.join(body_rows)}</tbody></table>"
            f"{footer}"
        )

    def _mode_badge(self, mode: str) -> str:
        if mode == "frozen":
            return '<span class="pm-badge pm-badge-frozen">frozen</span>'
        return '<span class="pm-badge pm-badge-live">live</span>'

    def _live_attrs(self, mode: str) -> str:
        return ' data-publish-live="1"' if mode == "live" else ""

    # -- inline rendering ------------------------------------------------

    def render_inlines(self, nodes: list) -> str:
        return "".join(self.render_inline(n) for n in nodes or [])

    def render_inline(self, node: dict) -> str:
        t = node.get("type")
        attrs = node.get("attrs") or {}

        if t == "text":
            return self._apply_marks(
                _esc(node.get("text", "")), node.get("marks") or []
            )
        if t == "hard_break":
            return "<br>"
        if t == "image":
            src = _attr(attrs.get("src") or "")
            alt = _attr(attrs.get("alt") or "")
            title = attrs.get("title")
            title_attr = f' title="{_attr(title)}"' if title else ""
            return f'<img src="{src}" alt="{alt}"{title_attr}>'
        if t == "placeholder":
            key = attrs.get("key") or ""
            label = attrs.get("label") or key
            return (
                f'<span class="pm-placeholder" data-placeholder="{_attr(key)}">'
                f"{_esc(label)}</span>"
            )
        if t == "paper_link":
            doc_id = attrs.get("docId")
            info = self.labels.paper_info(doc_id)
            state = info.get("state", "ok")
            cls = "pm-paper-link"
            if state and state != "ok":
                cls += f" pm-paper-link--{_attr(state)}"
            return (
                f'<a class="{cls}" data-paper-link="{_attr(doc_id)}"'
                f' href="{_attr(info.get("href") or "#")}">{_esc(info.get("title"))}</a>'
            )
        if t == "mention":
            actor_id = attrs.get("actorId") or ""
            label = self.labels.actor_label(actor_id)
            return (
                f'<span class="pm-mention" data-mention="{_attr(actor_id)}">'
                f"@{_esc(label)}</span>"
            )
        if t == "tag":
            tag = attrs.get("tag") or ""
            return f'<span class="pm-tag" data-tag="{_attr(tag)}">#{_esc(tag)}</span>'
        if t == "value":
            return self._render_value(node)
        if t == "inline_embed":
            return self._render_inline_embed(node)
        return ""

    def _apply_marks(self, text: str, marks: list) -> str:
        """Wrap already-escaped text in its marks, outermost-first.

        ``marks`` is ordered outer→inner (per the schema), so we wrap from the
        innermost (last) outward, producing nested tags in source order.
        """
        out = text
        for mark in reversed(marks or []):
            mt = mark.get("type")
            if mt == "strong":
                out = f"<strong>{out}</strong>"
            elif mt == "em":
                out = f"<em>{out}</em>"
            elif mt == "code":
                out = f"<code>{out}</code>"
            elif mt == "link":
                ma = mark.get("attrs") or {}
                href = _attr(ma.get("href") or "")
                title = ma.get("title")
                title_attr = f' title="{_attr(title)}"' if title else ""
                rel = ' rel="nofollow noopener"'
                out = f'<a href="{href}"{title_attr}{rel}>{out}</a>'
        return out

    def _render_value(self, node: dict) -> str:
        attrs = node.get("attrs") or {}
        source = attrs.get("source") or ""
        column = attrs.get("column") or ""
        fmt = attrs.get("format")
        block_id, mode = self._next_block(
            "value", {"source": source, "column": column, "format": fmt}
        )
        if mode == "frozen":
            payload = self.payloads.get(block_id) or {}
            text = payload.get("text")
            display = _esc(text if text is not None else column)
        else:
            display = _esc(column)
        return (
            f'<span class="pm-value" data-block-id="{block_id}"'
            f"{self._live_attrs(mode)}"
            f' data-source="{_attr(source)}" data-column="{_attr(column)}"'
            f' data-format="{_attr(json.dumps(fmt))}">{display}</span>'
        )

    def _render_inline_embed(self, node: dict) -> str:
        attrs = node.get("attrs") or {}
        ref = attrs.get("ref") or ""
        label = self.labels.embed_label(ref)
        block_id, mode = self._next_block("inline_embed", {"ref": ref})
        return (
            f'<a class="pm-inline-embed" data-block-id="{block_id}"'
            f"{self._live_attrs(mode)}"
            f' data-inline-embed="{_attr(ref)}" href="{_attr(ref or "#")}">'
            f"{_esc(label)}</a>"
        )
