"""Server-side schema (`pm_schema.schema`) materialize checks.

The schema is used by the Instance to apply steps over a snapshot; these tests
exercise `node_from_json` directly to prove a `block_embed` carrying the
additive `config` attr round-trips, and that a node lacking `config` falls back
to the `{}` default (no data migration needed).
"""

import pytest
from prosemirror.model import Node

from datasette_paper.pm_schema import (
    is_safe_href,
    is_safe_image_src,
    safe_href,
    safe_image_src,
    schema,
    step_href_violation,
)


def _materialize(node_json: dict) -> Node:
    """Build a one-paragraph doc wrapping `node_json` as a block child."""
    doc_json = {"type": "doc", "content": [node_json]}
    return Node.from_json(schema, doc_json)


def test_block_embed_with_config_materializes():
    config = {"columns": ["name", "id"], "sort": "-created"}
    doc = _materialize(
        {
            "type": "block_embed",
            "attrs": {"ref": "/fixtures/facetable", "mode": "row", "config": config},
        }
    )
    embed = doc.content.child(0)
    assert embed.type.name == "block_embed"
    assert embed.attrs["config"] == config
    assert embed.attrs["mode"] == "row"


def test_block_embed_without_config_applies_default():
    # A snapshot predating the `config` attr has no `config` key — ProseMirror
    # fills the `{}` default, proving no migration / step-log rewrite needed.
    doc = _materialize({"type": "block_embed", "attrs": {"ref": "/fixtures/facetable"}})
    embed = doc.content.child(0)
    assert embed.attrs["config"] == {}
    assert embed.attrs["mode"] == "table"


def test_block_embed_config_survives_json_roundtrip():
    config = {"nested": {"x": 1}, "list": [1, 2, 3]}
    doc = _materialize(
        {"type": "block_embed", "attrs": {"ref": "/r", "config": config}}
    )
    again = Node.from_json(schema, doc.to_json())
    assert again.content.child(0).attrs["config"] == config


def test_toc_with_config_materializes():
    config = {"minLevel": 2, "maxLevel": 2, "ordered": False}
    doc = _materialize({"type": "toc", "attrs": {"config": config}})
    toc = doc.content.child(0)
    assert toc.type.name == "toc"
    assert toc.attrs["config"] == config


def test_toc_without_config_applies_default():
    doc = _materialize({"type": "toc"})
    toc = doc.content.child(0)
    assert toc.attrs["config"] == {}


# ---------------------------------------------------------------------------
# Link / image href sanitization (stored-XSS fix, blockers-0629/01).
# Mirrors frontend/src/lib/__tests__/safeHref.test.ts — keep the allowlist in
# lock-step with frontend/src/lib/safeHref.ts.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "href",
    [
        "javascript:alert(1)",
        "JavaScript:alert(1)",  # case-insensitive
        "  javascript:alert(1)",  # leading whitespace stripped
        "java\tscript:alert(1)",  # embedded control char stripped
        "vbscript:msgbox(1)",
        "data:text/html,<script>alert(1)</script>",
    ],
)
def test_dangerous_link_href_is_unsafe(href):
    assert is_safe_href(href) is False
    assert safe_href(href) == "#"


@pytest.mark.parametrize(
    "href",
    [
        "https://example.com/x",
        "http://example.com",
        "mailto:a@b.com",
        "tel:+15551234",
        "#section",
        "/relative/path",
        "//example.com",  # protocol-relative resolves to http(s)
    ],
)
def test_allowed_link_href_passes_through(href):
    assert is_safe_href(href) is True
    assert safe_href(href) == href


def test_link_mark_todom_neutralizes_javascript_scheme():
    """The render sink (toDOM) emits an inert href for a dangerous scheme."""
    link = schema.marks["link"]
    node = link.create({"href": "javascript:alert(document.cookie)"})
    dom = link.spec["toDOM"](node)
    assert dom[0] == "a"
    assert dom[1]["href"] == "#"


def test_link_mark_todom_keeps_safe_scheme():
    link = schema.marks["link"]
    node = link.create({"href": "https://example.com/ok"})
    dom = link.spec["toDOM"](node)
    assert dom[1]["href"] == "https://example.com/ok"


def test_image_src_allows_inline_data_image_but_blocks_html():
    # Inline images are stored as `data:image/...` URIs — those must pass.
    assert is_safe_image_src("data:image/png;base64,AAAA") is True
    assert safe_image_src("data:image/png;base64,AAAA") == "data:image/png;base64,AAAA"
    # …but a scriptable `data:` / `javascript:` src is neutralized.
    assert is_safe_image_src("data:text/html,<script>alert(1)</script>") is False
    assert is_safe_image_src("javascript:alert(1)") is False
    assert safe_image_src("javascript:alert(1)") == "#"


def test_image_node_todom_neutralizes_dangerous_src():
    img = schema.nodes["image"]
    node = img.create({"src": "javascript:alert(1)"})
    dom = img.spec["toDOM"](node)
    assert dom[0] == "img"
    assert dom[1]["src"] == "#"
    # Inline data: image survives the render sink.
    ok = img.create({"src": "data:image/gif;base64,R0lGOD"})
    assert img.spec["toDOM"](ok)[1]["src"] == "data:image/gif;base64,R0lGOD"


def test_step_href_violation_finds_link_mark_in_replace_slice():
    step = {
        "stepType": "replace",
        "from": 1,
        "to": 1,
        "slice": {
            "content": [
                {
                    "type": "text",
                    "text": "click me",
                    "marks": [
                        {"type": "link", "attrs": {"href": "javascript:alert(1)"}}
                    ],
                }
            ]
        },
    }
    assert step_href_violation(step) is not None


def test_step_href_violation_finds_addmark_top_level_mark():
    step = {
        "stepType": "addMark",
        "mark": {"type": "link", "attrs": {"href": "vbscript:x"}},
        "from": 1,
        "to": 3,
    }
    assert step_href_violation(step) is not None


def test_step_href_violation_finds_image_node_src():
    step = {
        "stepType": "replace",
        "from": 1,
        "to": 1,
        "slice": {
            "content": [{"type": "image", "attrs": {"src": "javascript:alert(1)"}}]
        },
    }
    assert step_href_violation(step) is not None


def test_step_href_violation_allows_safe_links_and_images():
    step = {
        "stepType": "replace",
        "from": 1,
        "to": 1,
        "slice": {
            "content": [
                {
                    "type": "text",
                    "text": "ok",
                    "marks": [
                        {"type": "link", "attrs": {"href": "https://example.com"}}
                    ],
                },
                {"type": "image", "attrs": {"src": "data:image/png;base64,AAAA"}},
            ]
        },
    }
    assert step_href_violation(step) is None
