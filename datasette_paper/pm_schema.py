"""Server-side ProseMirror schema mirroring `frontend/src/lib/schema.ts`.

Used by the Instance to materialize the live doc by applying steps_tail
to the latest snapshot. Must match the JS schema exactly — divergence
will cause Step.apply to fail or produce silently-wrong content.

If you add nodes / marks on the JS side, mirror them here in lock-step.

Table nodes are hand-ported from `prosemirror-tables` (JS) — the Python
port has no `tableNodes` helper. The `table` node carries a custom
`name` attr used by the `/-/paper/api/docs/{id}/tables/{name}` endpoint.
`colspan`/`rowspan`/`colwidth` are kept (the JS plugin requires them)
even though we never expose merge/split UI; in practice every cell has
`colspan=rowspan=1`.
"""

import json
import re
from typing import Optional

from prosemirror.model import Schema
from prosemirror.schema.basic import schema as basic_schema
from prosemirror.schema.list import add_list_nodes

# ─── URL-scheme allowlists (mirror frontend/src/lib/safeHref.ts) ──────────────
#
# The stock prosemirror-schema-basic `link` mark and `image` node emit their
# `href`/`src` verbatim. The browser `toDOM` (schema.ts) is the render sink a
# viewer clicks, so the real XSS guard lives there — but we mirror the same
# allowlist here to keep the two schemas in lock-step (CLAUDE.md rule 1) and,
# more importantly, to back the server-side step validator in instance.py,
# which rejects a hand-crafted collab step carrying a `javascript:` href before
# it is ever persisted or broadcast.
#
# Allowlist, not blocklist: an attacker needs only one script-bearing scheme,
# so we enumerate the safe ones. ASCII control + space chars are stripped
# before the scheme is read (the URL parser ignores them), so `java\tscript:`
# can't smuggle a blocked scheme past the colon check.

_ALLOWED_HREF_SCHEMES = frozenset({"http", "https", "mailto", "tel"})
_ALLOWED_IMAGE_SCHEMES = frozenset({"http", "https"})
# scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
_SCHEME_RE = re.compile(r"^([a-zA-Z][a-zA-Z0-9+.\-]*):")
_CTRL_WS_RE = re.compile(r"[\x00-\x20]")


def _scheme_of(cleaned: str) -> Optional[str]:
    m = _SCHEME_RE.match(cleaned)
    return m.group(1).lower() if m else None


def is_safe_href(href) -> bool:
    """Whether a link ``href`` uses an allowlisted scheme, is an in-page
    ``#fragment``, or is a same-document relative path. Mirrors
    ``isSafeHref`` in frontend/src/lib/safeHref.ts."""
    if not href or not isinstance(href, str):
        return True
    cleaned = _CTRL_WS_RE.sub("", href)
    if not cleaned or cleaned.startswith("#"):
        return True
    if cleaned.startswith("/") and not cleaned.startswith("//"):
        return True
    scheme = _scheme_of(cleaned)
    if scheme is None:
        return True  # scheme-less relative reference
    return scheme in _ALLOWED_HREF_SCHEMES


def is_safe_image_src(src) -> bool:
    """Like :func:`is_safe_href` but for an image ``src``: also allows inline
    ``data:image/...`` URIs (paper stores pasted images inline) while still
    rejecting ``data:text/html`` / ``javascript:``. Mirrors ``isSafeImageSrc``
    in frontend/src/lib/safeHref.ts."""
    if not src or not isinstance(src, str):
        return True
    cleaned = _CTRL_WS_RE.sub("", src)
    if not cleaned:
        return True
    if cleaned[:11].lower() == "data:image/":
        return True
    if cleaned.startswith("/") and not cleaned.startswith("//"):
        return True
    scheme = _scheme_of(cleaned)
    if scheme is None:
        return True
    return scheme in _ALLOWED_IMAGE_SCHEMES


def safe_href(href):
    """A link ``href`` if safe, else ``"#"`` — the render-sink sanitizer."""
    return href if (href and is_safe_href(href)) else "#"


def safe_image_src(src):
    """An image ``src`` if safe, else ``"#"`` — the render-sink sanitizer."""
    return src if (src and is_safe_image_src(src)) else "#"


def step_href_violation(step_obj) -> Optional[str]:
    """Return a reason string if a step's JSON carries a ``link`` mark or an
    ``image`` node with a blocked URL scheme, else ``None``.

    Walks the whole step structure rather than decoding a specific step shape,
    so it catches a href hidden in a ReplaceStep's slice, an AddMarkStep's
    top-level ``mark``, or any nesting in between. Used by instance.py to
    reject a crafted step before it is persisted/broadcast.
    """
    stack = [step_obj]
    while stack:
        obj = stack.pop()
        if isinstance(obj, dict):
            attrs = obj.get("attrs")
            if isinstance(attrs, dict):
                if obj.get("type") == "link":
                    href = attrs.get("href")
                    if isinstance(href, str) and not is_safe_href(href):
                        return f"blocked link href scheme: {href!r}"
                elif obj.get("type") == "image":
                    src = attrs.get("src")
                    if isinstance(src, str) and not is_safe_image_src(src):
                        return f"blocked image src scheme: {src!r}"
            stack.extend(obj.values())
        elif isinstance(obj, list):
            stack.extend(obj)
    return None


_list_nodes = add_list_nodes(basic_schema.spec["nodes"], "paragraph block*", "block")

# Sanitize the image `src` at the render sink — mirrors schema.ts. toDOM is
# never rendered server-side, but we keep it in lock-step with the JS schema.
_image_spec = {
    **_list_nodes["image"],
    "toDOM": lambda node: [
        "img",
        {
            "src": safe_image_src(node.attrs.get("src")),
            "alt": node.attrs.get("alt"),
            "title": node.attrs.get("title"),
        },
    ],
}

# Override the basic-schema `code_block` to carry a `language` attr — mirrors
# schema.ts. toDOM is never rendered server-side but is kept in lock-step; the
# attr is what matters for node_from_json / Step.apply.
# @feat code-language: server code_block spec adds language attr (mirrors schema.ts)
_code_block_spec = {
    **_list_nodes["code_block"],
    "attrs": {"language": {"default": None}},
    "toDOM": lambda node: [
        "pre",
        (
            {"data-language": str(node.attrs["language"])}
            if node.attrs.get("language")
            else {}
        ),
        ["code", 0],
    ],
}

# Sanitize the link `href` at the render sink — mirrors schema.ts.
_link_mark_spec = {
    **basic_schema.spec["marks"]["link"],
    "toDOM": lambda node: [
        "a",
        {"href": safe_href(node.attrs.get("href")), "title": node.attrs.get("title")},
        0,
    ],
}
_marks = {**basic_schema.spec["marks"], "link": _link_mark_spec}

# Custom task_list / task_item — mirrors frontend/src/lib/schema.ts.
# @feat task-list: server task_list node spec (task_item follows; mirrors schema.ts)
_task_list_spec = {
    "group": "block",
    "content": "task_item+",
    "parseDOM": [{"tag": "ul[data-task-list]"}],
    "toDOM": lambda _node: ["ul", {"data-task-list": "true"}, 0],
}

_task_item_spec = {
    "attrs": {"checked": {"default": False}},
    "content": "paragraph block*",
    "defining": True,
    "parseDOM": [{"tag": "li[data-task-item]"}],
    "toDOM": lambda node: [
        "li",
        {"data-task-item": "true", "data-checked": str(node.attrs["checked"])},
        0,
    ],
}

# Table specs — mirror prosemirror-tables `tableNodes(...)` output with
# our custom `name` attr appended on the `table` node.
_cell_attrs = {
    "colspan": {"default": 1},
    "rowspan": {"default": 1},
    "colwidth": {"default": None},
}

# @feat tables: server table node spec with custom name attr (row/cell/header follow)
_table_spec = {
    "group": "block",
    "content": "table_row+",
    "tableRole": "table",
    "isolating": True,
    "attrs": {"name": {"default": None}},
    "parseDOM": [{"tag": "table"}],
    "toDOM": lambda node: [
        "table",
        ({"data-name": str(node.attrs["name"])} if node.attrs.get("name") else {}),
        ["tbody", 0],
    ],
}

_table_row_spec = {
    "content": "(table_cell | table_header)*",
    "tableRole": "row",
    "parseDOM": [{"tag": "tr"}],
    "toDOM": lambda _node: ["tr", 0],
}

_table_cell_spec = {
    "content": "block+",
    "attrs": _cell_attrs,
    "tableRole": "cell",
    "isolating": True,
    "parseDOM": [{"tag": "td"}],
    "toDOM": lambda _node: ["td", 0],
}

_table_header_spec = {
    "content": "block+",
    "attrs": _cell_attrs,
    "tableRole": "header_cell",
    "isolating": True,
    "parseDOM": [{"tag": "th"}],
    "toDOM": lambda _node: ["th", 0],
}

# Inline atom for template placeholders — mirrors the JS schema in
# frontend/src/lib/schema.ts. Authored only inside templates; the
# create-from-template route walks the materialized doc and replaces
# each placeholder with a text node using the resolver registry in
# datasette_paper/template_params.py. Docs that aren't templates
# should never contain a placeholder node; the materializer tolerates
# them either way (the node is a valid inline atom — it just won't be
# substituted outside the template-clone flow).
# @feat placeholder: server node spec (mirrors schema.ts) for node_from_json / Step.apply
_placeholder_spec = {
    "group": "inline",
    "inline": True,
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {"key": {"default": ""}, "label": {"default": None}},
    "parseDOM": [{"tag": "span[data-placeholder]"}],
    "toDOM": lambda node: [
        "span",
        {
            "data-placeholder": str(node.attrs.get("key", "")),
            "class": "pm-placeholder",
        },
        "{" + str(node.attrs.get("label") or node.attrs.get("key", "")) + "}",
    ],
}

# Inline atom for cross-document links — mirrors the JS schema in
# frontend/src/lib/schema.ts. id-only (`docId`); markdown round-trips as
# `[[id]]` via datasette_paper/markdown.py. toDOM is never rendered
# server-side but must be structurally valid for node_from_json/Step.apply.
# @feat paper-link: server-side node spec (mirrors schema.ts) for node_from_json / Step.apply
_paper_link_spec = {
    "group": "inline",
    "inline": True,
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {"docId": {"default": None}},
    "parseDOM": [{"tag": "a[data-paper-link]"}],
    "toDOM": lambda node: [
        "a",
        {
            "data-paper-link": str(node.attrs.get("docId") or ""),
            "class": "pm-paper-link",
        },
        f"Paper {node.attrs.get('docId')}",
    ],
}

# Inline atom for @mentions — mirrors the JS schema in
# frontend/src/lib/schema.ts. id-only (`actorId`); markdown round-trips as
# `[@label](paper:/actor/<id>)` via datasette_paper/markdown.py. toDOM is never
# rendered server-side but must be structurally valid for
# node_from_json/Step.apply.
# @feat mention: server node spec (mirrors schema.ts) for node_from_json / Step.apply
_mention_spec = {
    "group": "inline",
    "inline": True,
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {"actorId": {"default": None}},
    "parseDOM": [{"tag": "span[data-mention]"}],
    "toDOM": lambda node: [
        "span",
        {
            "data-mention": str(node.attrs.get("actorId") or ""),
            "class": "pm-mention",
        },
        f"@{node.attrs.get('actorId')}",
    ],
}

# Inline atom for #tags — mirrors the JS schema in
# frontend/src/lib/schema.ts. value-only (`tag`); markdown round-trips as
# `[#label](paper:/tag/<slug>)` via datasette_paper/markdown.py. No async resolver
# (the tag is its own label). toDOM must be structurally valid for
# node_from_json/Step.apply but is never rendered server-side.
# @feat tag: server node spec (mirrors schema.ts) for node_from_json / Step.apply
_tag_spec = {
    "group": "inline",
    "inline": True,
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {"tag": {"default": None}},
    "parseDOM": [{"tag": "span[data-tag]"}],
    "toDOM": lambda node: [
        "span",
        {
            "data-tag": str(node.attrs.get("tag") or ""),
            "class": "pm-tag",
        },
        f"#{node.attrs.get('tag')}",
    ],
}

# Inline atom for a calendar date (+ optional time / IANA zone) — mirrors the
# JS schema in frontend/src/lib/schema.ts. `date` is required (a date atom is
# never empty); `time` (24h `HH:MM`) and `tz` (IANA name) default null.
# markdown round-trips as `[<label>](paper:/date/<date>[T<time>][?tz=<zone>])`
# via datasette_paper/markdown.py. toDOM is a static fallback (the real chip is
# the NodeView) but must be structurally valid for node_from_json/Step.apply.
# @feat date: server node spec (mirrors schema.ts) for node_from_json / Step.apply
_date_spec = {
    "group": "inline",
    "inline": True,
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {"date": {}, "time": {"default": None}, "tz": {"default": None}},
    "parseDOM": [{"tag": "span[data-date]"}],
    "toDOM": lambda node: [
        "span",
        {
            "data-date": str(node.attrs.get("date") or ""),
            "data-date-time": str(node.attrs.get("time") or ""),
            "data-date-tz": str(node.attrs.get("tz") or ""),
            "class": "pm-date",
        },
        # Static fallback only (the real chip is the NodeView); never rendered
        # server-side, so a raw echo of the date is enough to stay valid.
        str(node.attrs.get("date") or ""),
    ],
}

# Inline atom for a single computed SQL value — mirrors the JS schema in
# frontend/src/lib/schema.ts. A reference (`source` name + `column`) plus an
# optional `format` config; the value is fetched live per-viewer by the
# NodeView and never persisted. markdown round-trips as `${{source.column}}`
# (optionally `| kind:arg`) via datasette_paper/markdown.py. toDOM is never
# rendered server-side but must be structurally valid for
# node_from_json/Step.apply.
# @feat value: server node spec (mirrors schema.ts); source/column/format attrs
_value_spec = {
    "group": "inline",
    "inline": True,
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {
        "source": {"default": None},
        "column": {"default": None},
        "format": {"default": None},
    },
    "parseDOM": [{"tag": "span[data-value]"}],
    "toDOM": lambda node: [
        "span",
        {
            "data-value": "true",
            "data-source": str(node.attrs.get("source") or ""),
            "data-column": str(node.attrs.get("column") or ""),
            "class": "pm-value",
        },
        str(node.attrs.get("column") or "?"),
    ],
}

# Inline atom for references to a Datasette resource — mirrors the JS schema
# in frontend/src/lib/schema.ts. identity-only (`ref`, a Datasette URL path);
# markdown round-trips as `[label](paper:/embed/<kind>/<ref>)` via
# datasette_paper/markdown.py. The display label is resolved per-viewer by the
# NodeView and never persisted. toDOM is never rendered server-side but must be
# structurally valid for node_from_json/Step.apply.
# @feat inline-embed: server node spec (mirrors schema.ts) for node_from_json / Step.apply
_inline_embed_spec = {
    "group": "inline",
    "inline": True,
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {"ref": {"default": None}},
    "parseDOM": [{"tag": "a[data-inline-embed]"}],
    "toDOM": lambda node: [
        "a",
        {
            "data-inline-embed": str(node.attrs.get("ref") or ""),
            "class": "pm-inline-embed",
        },
        str(node.attrs.get("ref") or ""),
    ],
}

# Block atom for an embedded read-only render of a Datasette resource —
# mirrors the JS schema. identity-only (`ref` + `mode` + opaque `config`);
# rendered data is fetched per-viewer and never persisted. markdown round-trips
# as a ```paper-embed JSON fence via datasette_paper/markdown.py. `config` is a
# provider-defined bag carried verbatim; it survives the DOM round-trip
# JSON-stringified in `data-embed-config` (parsed defensively → {}).
# @feat block-embed: server node spec (mirrors schema.ts) with ref/mode/config attrs
_block_embed_spec = {
    "group": "block",
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {
        "ref": {"default": None},
        "mode": {"default": "table"},
        "config": {"default": {}},
    },
    # parseDOM is never exercised server-side (materialization goes through
    # node_from_json, not DOM parsing), so — like the other specs here — we
    # only declare the tag; attrs (incl. `config`) arrive via the JSON.
    "parseDOM": [{"tag": "div[data-block-embed]"}],
    "toDOM": lambda node: [
        "div",
        {
            "data-block-embed": str(node.attrs.get("ref") or ""),
            "data-embed-mode": str(node.attrs.get("mode") or "table"),
            "data-embed-config": json.dumps(node.attrs.get("config") or {}),
            "class": "pm-block-embed",
        },
        str(node.attrs.get("ref") or ""),
    ],
}

# Block atom for a "lite" YouTube embed — mirrors the JS schema in
# frontend/src/lib/schema.ts. Identity-only: `provider` ("youtube" today), the
# provider video id, and an optional `start` offset in seconds. The facade
# render (thumbnail -> click-to-iframe) is client-only; markdown round-trips as
# a bare canonical watch URL via datasette_paper/markdown.py. toDOM is never
# rendered server-side but must be structurally valid for node_from_json.
# @feat video-embed: server node spec (mirrors schema.ts) with provider/videoId/start attrs
_video_embed_spec = {
    "group": "block",
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {
        "provider": {"default": "youtube"},
        "videoId": {"default": None},
        "start": {"default": None},
    },
    "parseDOM": [{"tag": "div[data-video-embed]"}],
    "toDOM": lambda node: [
        "div",
        {
            "data-video-embed": str(node.attrs.get("provider") or "youtube"),
            "data-video-id": str(node.attrs.get("videoId") or ""),
            "data-video-start": (
                "" if node.attrs.get("start") is None else str(node.attrs.get("start"))
            ),
            "class": "pm-video-embed",
        },
        str(node.attrs.get("videoId") or ""),
    ],
}

# Block atom for an auto-generated table of contents — mirrors the JS schema in
# frontend/src/lib/schema.ts. Content-free; the heading list is derived
# per-viewer and never persisted. `config` is an opaque options bag
# (minLevel/maxLevel/ordered) carried verbatim. markdown round-trips as a
# ```paper-toc JSON fence via datasette_paper/markdown.py. toDOM is never
# rendered server-side but must be structurally valid for node_from_json.
_toc_spec = {
    "group": "block",
    "atom": True,
    "selectable": True,
    "draggable": False,
    "attrs": {"config": {"default": {}}},
    # parseDOM is never exercised server-side (materialization goes through
    # node_from_json, not DOM parsing); only declare the tag.
    "parseDOM": [{"tag": "div[data-toc]"}],
    "toDOM": lambda node: [
        "div",
        {
            "data-toc": "true",
            "data-toc-config": json.dumps(node.attrs.get("config") or {}),
            "class": "pm-toc",
        },
        "Table of contents",
    ],
}

# Block node for an editable SQL query — mirrors the JS schema in
# frontend/src/lib/schema.ts. Unlike block_embed (an atom), the query is
# editable text content; `db` names the target database and `hidden` collapses
# the editor. Results are fetched per-viewer by the NodeView and never
# persisted. markdown round-trips as a ```sql db=NAME fence via
# datasette_paper/markdown.py. toDOM is never rendered server-side but must be
# structurally valid for node_from_json/Step.apply.
# @feat sql-block: server node spec (mirrors schema.ts) for node_from_json / Step.apply
_sql_block_spec = {
    "group": "block",
    "content": "text*",
    "marks": "",
    "code": True,
    "defining": True,
    "selectable": True,
    "attrs": {"db": {"default": None}, "hidden": {"default": False}},
    "parseDOM": [{"tag": "pre[data-sql-block]", "preserveWhitespace": "full"}],
    "toDOM": lambda node: [
        "pre",
        {
            "data-sql-block": "true",
            "data-sql-db": str(node.attrs.get("db") or ""),
            "data-sql-hidden": str(bool(node.attrs.get("hidden"))).lower(),
            "class": "pm-sql-block",
        },
        ["code", 0],
    ],
}

# Block node defining a named, parameterless SQL query — mirrors the JS schema
# in frontend/src/lib/schema.ts. Same shape as sql_block (the SQL is editable
# text content) plus a `name` attr that inline `value` atoms reference; renders
# no results table. markdown round-trips as a ```source name=NAME db=DB fence
# via datasette_paper/markdown.py. toDOM is never rendered server-side but must
# be structurally valid for node_from_json/Step.apply.
# @feat source: server node spec (mirrors schema.ts); name/db attrs, editable text
_source_spec = {
    "group": "block",
    "content": "text*",
    "marks": "",
    "code": True,
    "defining": True,
    "selectable": True,
    "attrs": {"name": {"default": None}, "db": {"default": None}},
    "parseDOM": [{"tag": "pre[data-source-block]", "preserveWhitespace": "full"}],
    "toDOM": lambda node: [
        "pre",
        {
            "data-source-block": "true",
            "data-source-name": str(node.attrs.get("name") or ""),
            "data-source-db": str(node.attrs.get("db") or ""),
            "class": "pm-source-card",
        },
        ["code", 0],
    ],
}

# The five GitHub-style admonition kinds — mirrors CALLOUT_KINDS in
# frontend/src/lib/schema.ts and _CALLOUT_KINDS in datasette_paper/markdown.py.
_CALLOUT_KINDS = frozenset({"note", "tip", "important", "warning", "caution"})


def _clamp_callout_kind(kind) -> str:
    """Clamp an arbitrary attr value to a valid callout kind, defaulting to
    "note". Never raises — a hand-crafted step or a stale snapshot carrying an
    unrecognized kind must not blow up ``Step.apply`` (the materializer's
    "never raises" contract; see datasette_paper/CLAUDE.md)."""
    return kind if isinstance(kind, str) and kind in _CALLOUT_KINDS else "note"


# Block node for a GitHub-style admonition — mirrors the JS schema in
# frontend/src/lib/schema.ts. Deliberately NOT in the `block` group;
# `_doc_spec` below overrides `doc`'s content to `(block | callout)+`, making
# a callout reachable only at the document's top level (no nesting — every
# other container stays `block+`). markdown round-trips it as
# `> [!KIND] Title` + `> `-prefixed body via datasette_paper/markdown.py.
# toDOM is never rendered server-side but must be structurally valid for
# node_from_json/Step.apply.
# @feat callout: server node spec for the callout block (mirrors schema.ts)
_callout_spec = {
    "content": "callout_title block+",
    "defining": True,
    # @feat callout: `collapsed` attr mirrors schema.ts — shared fold state
    "attrs": {"kind": {"default": "note"}, "collapsed": {"default": False}},
    "parseDOM": [{"tag": "div[data-callout]"}],
    "toDOM": lambda node: [
        "div",
        {
            "data-callout": _clamp_callout_kind(node.attrs.get("kind")),
            "class": f"pm-callout pm-callout--{_clamp_callout_kind(node.attrs.get('kind'))}",
            # Mirror schema.ts: emit data-collapsed only when folded.
            **({"data-collapsed": "true"} if node.attrs.get("collapsed") else {}),
        },
        0,
    ],
}

# Plain-text title child of `callout` — mirrors the JS schema. Only reachable
# as a callout's first child (no `group`); `marks: ""` keeps it plain text
# (it's flattened onto the markdown marker line, not rendered as prose).
# @feat callout: server node spec for the callout title child (mirrors schema.ts)
_callout_title_spec = {
    "content": "text*",
    "marks": "",
    "parseDOM": [{"tag": "div[data-callout-title]"}],
    # data-callout-title must round-trip through parseDOM (mirrors schema.ts —
    # a toDOM its own parse rule can't match breaks the client's DOM re-parse).
    "toDOM": lambda _node: [
        "div",
        {"data-callout-title": "", "class": "pm-callout-title"},
        0,
    ],
}

# Doc content override enabling callout's top-level-only nesting — mirrors
# the JS schema's `.update("doc", {content: "(block | callout)+"})`. Since
# `callout` isn't in the `block` group, this override is the only path a
# callout can reach the tree.
# @feat callout: doc content override — the no-nesting mechanism (mirrors schema.ts)
_doc_spec = {**_list_nodes["doc"], "content": "(block | callout)+"}

_nodes = {
    **_list_nodes,
    "doc": _doc_spec,
    "callout": _callout_spec,
    "callout_title": _callout_title_spec,
    "image": _image_spec,
    "code_block": _code_block_spec,
    "placeholder": _placeholder_spec,
    "paper_link": _paper_link_spec,
    "mention": _mention_spec,
    "tag": _tag_spec,
    "date": _date_spec,
    "value": _value_spec,
    "inline_embed": _inline_embed_spec,
    "block_embed": _block_embed_spec,
    "video_embed": _video_embed_spec,
    "toc": _toc_spec,
    "sql_block": _sql_block_spec,
    "source": _source_spec,
    "task_list": _task_list_spec,
    "task_item": _task_item_spec,
    "table": _table_spec,
    "table_row": _table_row_spec,
    "table_cell": _table_cell_spec,
    "table_header": _table_header_spec,
}

schema = Schema({"nodes": _nodes, "marks": _marks})
