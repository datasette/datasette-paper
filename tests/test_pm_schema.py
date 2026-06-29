"""Server-side schema (`pm_schema.schema`) materialize checks.

The schema is used by the Instance to apply steps over a snapshot; these tests
exercise `node_from_json` directly to prove a `block_embed` carrying the
additive `config` attr round-trips, and that a node lacking `config` falls back
to the `{}` default (no data migration needed).
"""

from prosemirror.model import Node

from datasette_paper.pm_schema import schema


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
