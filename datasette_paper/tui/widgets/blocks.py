"""Per-top-level-block widgets for the reader (dispatch by PM node type).

Every top-level block of the materialized doc becomes one focusable ``Block``
container so navigation, the focus accent bar, live patching, and ticket 04's
editing are all block-granular. The inner widget is chosen by node type:

* default — a textual ``Markdown`` widget over the block's serialized markdown
  (paragraphs, headings, lists, task lists, blockquotes, code fences, GFM
  tables all render here), run through the display-only prettify pass first;
* ``callout`` — a kind-tinted bordered container with a title line and a
  Markdown body that Space collapses locally (no network, no step);
* ``sql_block`` / ``source`` / ``block_embed`` — static placeholders showing
  the SQL / ref plus a "ticket 03" hint (made live in ticket 03).

@feat tui: per-top-level-block widget dispatch for the reader doc view
"""

from __future__ import annotations

from rich.text import Text
from textual.containers import Vertical
from textual.widgets import Label, Markdown, Static

from ..prettify import prettify_markdown
from ...markdown import doc_to_markdown

# The five callout kinds → a tint class (mirrors markdown.py's _CALLOUT_KINDS).
CALLOUT_KINDS = ("note", "tip", "important", "warning", "caution")


class Block(Vertical):
    """Focusable wrapper around one top-level block's inner widget.

    The container itself takes focus (the block cursor); the left accent bar is
    pure CSS on ``Block.-cursor``. ``node_type`` lets the screen dispatch
    block-scoped key actions (e.g. Space on a callout) without re-reading the
    doc model.
    """

    can_focus = True

    def __init__(self, inner, node_type: str) -> None:
        super().__init__(inner)
        self.node_type = node_type
        self._inner = inner

    def toggle_collapsed(self) -> bool:
        """Space handler: collapse a callout body locally. Returns True if this
        block handled it (i.e. it is a callout)."""
        if isinstance(self._inner, Callout):
            self._inner.toggle()
            return True
        return False


class Callout(Vertical):
    """A GitHub-style admonition: tinted border, title line, Markdown body.

    ``collapsed`` mirrors the doc attr and is toggled locally by Space — same
    rule as the read-only web viewers, no collab step is emitted.
    """

    def __init__(self, kind: str, title: str, body_md: str, collapsed: bool) -> None:
        super().__init__()
        self.kind = kind if kind in CALLOUT_KINDS else "note"
        self._title = title
        self._body_md = body_md
        self.collapsed = collapsed
        self.add_class(f"callout--{self.kind}")

    def compose(self):
        header = self._title or self.kind.upper()
        yield Label(header, classes="callout-title")
        self._body = Markdown(self._body_md, classes="callout-body")
        self._body.display = not self.collapsed
        yield self._body

    def toggle(self) -> None:
        self.collapsed = not self.collapsed
        self._body.display = not self.collapsed


def _callout_parts(node_json: dict) -> tuple[str, str]:
    """(title, body_markdown) for a callout node. The first child is the
    plain-text ``callout_title``; the rest are ordinary blocks serialized via a
    single-node wrapper doc (display-only, never fed back to an edit buffer)."""
    content = node_json.get("content") or []
    title = ""
    body_children = content
    if content and content[0].get("type") == "callout_title":
        title = "".join(
            c.get("text", "") for c in (content[0].get("content") or [])
        ).strip()
        body_children = content[1:]
    body_md = doc_to_markdown({"type": "doc", "content": body_children})
    return title, body_md


def _sql_text(node_json: dict) -> str:
    return "".join(c.get("text", "") for c in (node_json.get("content") or []))


def make_block(session, i: int, links_map: dict, actors_map: dict) -> Block:
    """Build the ``Block`` widget for top-level block ``i`` of ``session.doc``."""
    node = session.doc.child(i)
    t = node.type.name
    node_json = node.to_json()

    if t == "callout":
        attrs = node_json.get("attrs") or {}
        title, body_md = _callout_parts(node_json)
        body_md = prettify_markdown(body_md, links_map, actors_map)
        inner = Callout(
            kind=attrs.get("kind") or "note",
            title=prettify_markdown(title, links_map, actors_map),
            body_md=body_md,
            collapsed=bool(attrs.get("collapsed")),
        )
    elif t in ("sql_block", "source", "block_embed"):
        inner = _placeholder(t, node_json)
    else:
        md = prettify_markdown(session.block_markdown(i), links_map, actors_map)
        inner = Markdown(md)

    return Block(inner, node_type=t)


def _placeholder(t: str, node_json: dict) -> Static:
    """A static, non-live rendering of a SQL / source / embed block.

    Ticket 03 replaces these with runnable widgets; for now they show the SQL
    text / ref and their db/name metadata so the reader is still legible.
    """
    attrs = node_json.get("attrs") or {}
    if t == "sql_block":
        db = attrs.get("db") or ""
        header = f"SQL  db={db}" if db else "SQL"
        body = _sql_text(node_json)
    elif t == "source":
        name = attrs.get("name") or ""
        db = attrs.get("db") or ""
        meta = " ".join(
            p for p in (f"name={name}" if name else "", f"db={db}" if db else "") if p
        )
        header = f"SOURCE  {meta}".rstrip()
        body = _sql_text(node_json)
    else:  # block_embed
        ref = attrs.get("ref") or ""
        mode = attrs.get("mode") or "table"
        header = f"EMBED  {ref}  (mode={mode})"
        body = ""
    text = (header + "\n\n" + body) if body else header
    text += "\n\n(run: ticket 03)"
    # Text() (not markup) so `[`/`]` in the SQL isn't parsed as Rich markup.
    widget = Static(Text(text), classes="sql-placeholder")
    widget.border_title = t
    return widget
