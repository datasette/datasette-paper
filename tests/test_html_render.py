"""T02 — PM-JSON → static HTML renderer (datasette_paper/html_render.py).

Covers: every schema node renders (lock-step completeness), prose/inline/table/
task markup, output escaping (XSS), document-order block_id assignment, the
live-placeholder shape, and frozen-payload rendering.
"""

from __future__ import annotations

import pytest

from datasette_paper.html_render import Labels, doc_to_html, render_doc
from datasette_paper.pm_schema import schema


def _p(*inlines):
    return {"type": "paragraph", "content": list(inlines)}


def _text(t, *marks):
    node = {"type": "text", "text": t}
    if marks:
        node["marks"] = [{"type": m} if isinstance(m, str) else m for m in marks]
    return node


FIXTURE = {
    "type": "doc",
    "content": [
        {"type": "heading", "attrs": {"level": 2}, "content": [_text("Title")]},
        _p(
            _text("plain "),
            _text("bold", "strong"),
            _text("italic", "em"),
            _text("mono", "code"),
            _text(
                "link",
                {"type": "link", "attrs": {"href": "https://x.test", "title": "T"}},
            ),
        ),
        {"type": "blockquote", "content": [_p(_text("quoted"))]},
        {"type": "code_block", "content": [_text("x = 1")]},
        {"type": "horizontal_rule"},
        {
            "type": "bullet_list",
            "content": [{"type": "list_item", "content": [_p(_text("bullet"))]}],
        },
        {
            "type": "ordered_list",
            "attrs": {"order": 3},
            "content": [{"type": "list_item", "content": [_p(_text("ordered"))]}],
        },
        {
            "type": "task_list",
            "content": [
                {
                    "type": "task_item",
                    "attrs": {"checked": True},
                    "content": [_p(_text("done"))],
                },
                {
                    "type": "task_item",
                    "attrs": {"checked": False},
                    "content": [_p(_text("todo"))],
                },
            ],
        },
        {
            "type": "table",
            "attrs": {"name": "people"},
            "content": [
                {
                    "type": "table_row",
                    "content": [
                        {"type": "table_header", "content": [_p(_text("Name"))]},
                        {"type": "table_header", "content": [_p(_text("Age"))]},
                    ],
                },
                {
                    "type": "table_row",
                    "content": [
                        {"type": "table_cell", "content": [_p(_text("Alex"))]},
                        {"type": "table_cell", "content": [_p(_text("30"))]},
                    ],
                },
            ],
        },
        _p(
            {"type": "placeholder", "attrs": {"key": "today", "label": "Today"}},
            {"type": "paper_link", "attrs": {"docId": 7}},
            {"type": "mention", "attrs": {"actorId": "alice"}},
            {"type": "tag", "attrs": {"tag": "roadmap"}},
            {
                "type": "value",
                "attrs": {"source": "rev", "column": "total", "format": None},
            },
            {"type": "inline_embed", "attrs": {"ref": "/data/events"}},
            {"type": "image", "attrs": {"src": "/i.png", "alt": "pic", "title": None}},
            {"type": "hard_break"},
        ),
        {
            "type": "sql_block",
            "attrs": {"db": "analytics", "hidden": False},
            "content": [_text("select 1")],
        },
        {
            "type": "source",
            "attrs": {"name": "rev", "db": "analytics"},
            "content": [_text("select sum(x) as total from t")],
        },
        {
            "type": "block_embed",
            "attrs": {"ref": "/data/events", "mode": "table", "config": {"limit": 5}},
        },
    ],
}


def test_renders_all_prose_and_inline_markers():
    out = doc_to_html(FIXTURE)
    # prose
    assert "<h2>Title</h2>" in out
    assert "<strong>bold</strong>" in out
    assert "<em>italic</em>" in out
    assert "<code>mono</code>" in out
    assert '<a href="https://x.test" title="T" rel="nofollow noopener">link</a>' in out
    assert "<blockquote><p>quoted</p></blockquote>" in out
    assert '<pre class="pm-code-block"><code>x = 1</code></pre>' in out
    assert "<hr>" in out
    assert "<ul><li><p>bullet</p></li></ul>" in out
    assert '<ol start="3"><li><p>ordered</p></li></ol>' in out
    # task list with disabled checkboxes
    assert '<ul data-task-list="true">' in out
    assert (
        '<li data-task-item="true" data-checked="true"><input type="checkbox" disabled checked>'
        in out
    )
    assert (
        '<li data-task-item="true" data-checked="false"><input type="checkbox" disabled>'
        in out
    )
    # author table
    assert '<table data-name="people"><tbody>' in out
    assert "<th><p>Name</p></th>" in out
    assert "<td><p>Alex</p></td>" in out
    # inline atoms
    assert '<span class="pm-placeholder" data-placeholder="today">Today</span>' in out
    assert 'class="pm-paper-link" data-paper-link="7"' in out
    assert '<span class="pm-mention" data-mention="alice">@alice</span>' in out
    assert '<span class="pm-tag" data-tag="roadmap">#roadmap</span>' in out
    assert '<img src="/i.png" alt="pic">' in out
    assert "<br>" in out


def test_render_handles_every_schema_node():
    """Lock-step guard: every node the schema accepts must render to something.

    Build a one-of-each fixture and assert no node type silently vanishes. The
    FIXTURE above already contains every node; assert each leaves a marker.
    """
    out = doc_to_html(FIXTURE)
    # A representative marker per schema node (doc/text are structural).
    markers = {
        "heading": "<h2>",
        "paragraph": "<p>",
        "blockquote": "<blockquote>",
        "code_block": "pm-code-block",
        "horizontal_rule": "<hr>",
        "bullet_list": "<ul><li>",
        "ordered_list": "<ol",
        "list_item": "<li>",
        "task_list": "data-task-list",
        "task_item": "data-task-item",
        "table": "<table",
        "table_row": "<tr>",
        "table_cell": "<td>",
        "table_header": "<th>",
        "hard_break": "<br>",
        "image": "<img",
        "placeholder": "pm-placeholder",
        "paper_link": "pm-paper-link",
        "mention": "pm-mention",
        "tag": "pm-tag",
        "value": "pm-value",
        "inline_embed": "pm-inline-embed",
        "block_embed": "pm-block-embed",
        "sql_block": "pm-sql-block",
        "source": "pm-source-card",
    }
    # Sanity: we have a marker for every schema node except the structural ones.
    structural = {"doc", "text"}
    assert set(markers) | structural == set(schema.nodes.keys()), (
        "schema nodes changed — add an html_render handler + a marker here"
    )
    for node, marker in markers.items():
        assert marker in out, f"node {node!r} did not render (missing {marker!r})"


def test_output_is_escaped():
    doc = {
        "type": "doc",
        "content": [
            {"type": "heading", "attrs": {"level": 1}, "content": [_text("<script>h")]},
            _p(_text('a & b "c" <d>')),
            {
                "type": "table",
                "content": [
                    {
                        "type": "table_row",
                        "content": [
                            {"type": "table_cell", "content": [_p(_text("<x>"))]}
                        ],
                    }
                ],
            },
            {
                "type": "sql_block",
                "attrs": {"db": 'a"b', "hidden": False},
                "content": [_text("select '<i>'")],
            },
        ],
    }
    out = doc_to_html(doc)
    assert "<script>" not in out
    assert "&lt;script&gt;h" in out
    assert "a &amp; b" in out
    assert "&lt;d&gt;" in out
    assert "&lt;x&gt;" in out
    assert "select &#x27;&lt;i&gt;&#x27;" in out
    # db attr escaped inside the double-quoted attribute
    assert 'data-sql-db="a&quot;b"' in out


def test_block_ids_are_document_ordered():
    result = render_doc(FIXTURE)
    ids = [(b.block_id, b.kind) for b in result.blocks]
    # value + inline_embed live in the inline paragraph (doc order before the
    # block-level sql/source/embed that follow it).
    assert ids == [
        ("b0", "value"),
        ("b1", "inline_embed"),
        ("b2", "sql"),
        ("b3", "source"),
        ("b4", "embed"),
    ]
    assert result.has_live_blocks is True
    # every live data block carries its block id + the hydrate marker
    assert 'data-block-id="b2" data-publish-live="1"' in result.html


def test_live_placeholders_carry_config():
    out = doc_to_html(FIXTURE)
    assert 'data-sql-db="analytics" data-sql="select 1"' in out
    assert 'data-source-name="rev"' in out
    assert 'data-block-embed="/data/events" data-embed-mode="table"' in out
    assert 'data-embed-config="{&quot;limit&quot;: 5}"' in out
    assert '<div class="pm-data-slot">Loading live results…</div>' in out


def test_frozen_block_renders_baked_payload():
    payloads = {
        "b2": {
            "columns": ["country", "users"],
            "rows": [["US", 4210], ["IN", 3180]],
            "computed_at": "2026-06-28T00:00:00Z",
        }
    }
    result = render_doc(
        FIXTURE,
        mode_for=lambda bid: "frozen" if bid == "b2" else "live",
        payloads=payloads,
    )
    out = result.html
    # frozen sql block: baked rows inline, no live slot, no hydrate marker on it
    assert '<table class="pm-data-table">' in out
    assert "<th>country</th>" in out
    assert "<td>4210</td>" in out
    assert "data as of 2026-06-28T00:00:00Z" in out
    assert "pm-badge-frozen" in out
    # other blocks remain live → page still ships the hydrator
    assert result.has_live_blocks is True


def test_labels_resolve_inline_atoms():
    labels = Labels(
        actor=lambda aid: {"alice": "Alex Garcia"}.get(aid),
        paper=lambda did: {"title": "Q3 Plan", "href": "/-/paper/doc/7", "state": "ok"},
        embed=lambda ref: "events table",
    )
    out = doc_to_html(FIXTURE, labels=labels)
    assert "@Alex Garcia" in out
    assert ">Q3 Plan</a>" in out
    assert ">events table</a>" in out


def test_all_frozen_has_no_live_blocks():
    result = render_doc(
        FIXTURE,
        mode_for=lambda bid: "frozen",
        payloads={},
    )
    assert result.has_live_blocks is False
    assert "data-publish-live" not in result.html


def test_rejects_non_doc():
    with pytest.raises(ValueError):
        doc_to_html({"type": "paragraph"})
