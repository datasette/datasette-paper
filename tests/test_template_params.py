"""Tests for the placeholder resolver + substitution pass."""

from __future__ import annotations

import datetime
import json

import pytest

from conftest import actor_cookie, build_ds, plant_snapshot
from datasette_paper.template_params import (
    BUILTIN_RESOLVERS,
    build_context,
    builtin_keys,
    resolve_key,
    substitute_placeholders,
)


# ---------------------------------------------------------------------------
# Resolver registry
# ---------------------------------------------------------------------------


def test_builtin_keys_listed():
    keys = builtin_keys()
    # Every built-in resolver is reachable by name.
    assert set(keys) == set(BUILTIN_RESOLVERS.keys())
    # The standup-template fixtures rely on these specifically.
    for required in ("today", "now", "weekday", "actor", "year"):
        assert required in keys


def test_resolve_today_format():
    ctx = build_context(actor_id="alice")
    out = resolve_key("today", ctx)
    # YYYY-MM-DD; parseable as a date.
    parsed = datetime.date.fromisoformat(out)
    assert parsed.year >= 2025


def test_resolve_iso_week_format():
    ctx = build_context(actor_id=None)
    out = resolve_key("iso_week", ctx)
    # YYYY-Www; the week segment is two digits.
    year, week = out.split("-W")
    assert len(year) == 4 and year.isdigit()
    assert len(week) == 2 and week.isdigit()


def test_resolve_actor_falls_back_to_empty():
    """Anonymous actor produces empty string — substitute_placeholders
    will drop the node entirely to keep the doc schema-valid."""
    assert resolve_key("actor", build_context(actor_id=None)) == ""
    assert resolve_key("actor", build_context(actor_id="alice")) == "alice"


def test_resolve_unknown_key_falls_back_to_literal():
    """Unknown keys surface as `{key}` text so authors notice."""
    assert resolve_key("nope", build_context(actor_id="alice")) == "{nope}"


def test_now_is_stable_across_keys_in_one_context():
    """All time-derived keys read from the same ``now`` so a single
    substitution pass can't observe a tick boundary."""
    ctx = build_context(actor_id="alice")
    today_from_ctx = ctx["now"].strftime("%Y-%m-%d")
    assert resolve_key("today", ctx) == today_from_ctx


# ---------------------------------------------------------------------------
# substitute_placeholders
# ---------------------------------------------------------------------------


def _doc_with_placeholders():
    return {
        "type": "doc",
        "content": [
            {
                "type": "heading",
                "attrs": {"level": 1},
                "content": [
                    {"type": "text", "text": "Standup "},
                    {"type": "placeholder", "attrs": {"key": "today"}},
                ],
            },
            {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "Led by "},
                    {"type": "placeholder", "attrs": {"key": "actor"}},
                ],
            },
        ],
    }


def test_substitute_replaces_known_keys_with_text():
    ctx = build_context(actor_id="alice")
    out = substitute_placeholders(_doc_with_placeholders(), ctx)
    # Heading: "Standup " then today's date text.
    heading_content = out["content"][0]["content"]
    assert heading_content[0] == {"type": "text", "text": "Standup "}
    assert heading_content[1]["type"] == "text"
    datetime.date.fromisoformat(heading_content[1]["text"])
    # Paragraph: actor resolved to "alice".
    para = out["content"][1]["content"]
    assert para == [
        {"type": "text", "text": "Led by "},
        {"type": "text", "text": "alice"},
    ]


def test_substitute_drops_empty_resolved_values():
    """``actor`` for an anonymous context resolves to '' — the
    placeholder is dropped instead of producing an invalid empty
    text node."""
    ctx = build_context(actor_id=None)
    doc = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "Led by "},
                    {"type": "placeholder", "attrs": {"key": "actor"}},
                    {"type": "text", "text": "."},
                ],
            }
        ],
    }
    out = substitute_placeholders(doc, ctx)
    assert out["content"][0]["content"] == [
        {"type": "text", "text": "Led by "},
        {"type": "text", "text": "."},
    ]


def test_substitute_leaves_unknown_keys_as_literal_text():
    ctx = build_context(actor_id="alice")
    doc = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {"type": "placeholder", "attrs": {"key": "nope"}},
                ],
            }
        ],
    }
    out = substitute_placeholders(doc, ctx)
    assert out["content"][0]["content"] == [{"type": "text", "text": "{nope}"}]


def test_substitute_does_not_mutate_input():
    """The substitution returns a fresh tree."""
    doc = _doc_with_placeholders()
    snapshot = json.loads(json.dumps(doc))
    substitute_placeholders(doc, build_context(actor_id="alice"))
    assert doc == snapshot


def test_substitute_walks_nested_content():
    """Placeholders inside list items / blockquotes are reached."""
    doc = {
        "type": "doc",
        "content": [
            {
                "type": "bullet_list",
                "content": [
                    {
                        "type": "list_item",
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [
                                    {
                                        "type": "placeholder",
                                        "attrs": {"key": "actor"},
                                    }
                                ],
                            }
                        ],
                    }
                ],
            }
        ],
    }
    out = substitute_placeholders(doc, build_context(actor_id="bob"))
    item_para = out["content"][0]["content"][0]["content"][0]
    assert item_para == {
        "type": "paragraph",
        "content": [{"type": "text", "text": "bob"}],
    }


# @feat callout: the generic placeholder walk recurses into a callout's body
def test_substitute_walks_callout_body():
    """The walk is generic (recurses into any node's `content` list), so a
    placeholder inside a callout body — a node the walk predates — is
    reached with no callout-specific code."""
    doc = {
        "type": "doc",
        "content": [
            {
                "type": "callout",
                "attrs": {"kind": "note"},
                "content": [
                    {"type": "callout_title", "content": []},
                    {
                        "type": "paragraph",
                        "content": [{"type": "placeholder", "attrs": {"key": "actor"}}],
                    },
                ],
            }
        ],
    }
    out = substitute_placeholders(doc, build_context(actor_id="carol"))
    body_para = out["content"][0]["content"][1]
    assert body_para == {
        "type": "paragraph",
        "content": [{"type": "text", "text": "carol"}],
    }


# ---------------------------------------------------------------------------
# create_doc end-to-end
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
# @feat placeholder: end-to-end: created doc has no placeholder nodes left
async def test_create_from_template_substitutes_placeholders():
    """The new doc has no placeholder nodes left — keys are resolved
    against the creating actor's context."""
    ds = await build_ds()
    # Create the template via the API, then plant a doc with
    # placeholders as its seed snapshot.
    r = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Standup", "kind": "template"},
        cookies=actor_cookie(ds, "alice"),
    )
    template_id = r.json()["id"]
    template_doc = _doc_with_placeholders()
    await plant_snapshot(ds, template_id, template_doc, actor_id="alice", replace=True)

    # Open the template to bob via an acl Viewer grant so we can
    # demonstrate the resolver pulls from the *creator's* context,
    # not the template owner's.
    from datasette_acl.grants import grant, Principal
    from datasette_paper.permissions import (
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
    )

    await grant(
        ds,
        PAPER_DOC_RESOURCE_TYPE,
        PAPER_DOCS_PARENT,
        str(template_id),
        principal=Principal.actor("bob"),
        role="Viewer",
        by_actor="alice",
    )

    # Bob instantiates.
    r2 = await ds.client.post(
        "/-/paper/api/docs",
        json={"name": "Today", "template_id": template_id},
        cookies=actor_cookie(ds, "bob"),
    )
    assert r2.status_code == 201, r2.text
    new_id = r2.json()["id"]

    boot = await ds.client.get(
        f"/-/paper/api/docs/{new_id}", cookies=actor_cookie(ds, "bob")
    )
    body = boot.json()
    # No placeholder nodes anywhere in the resulting doc.
    text_doc = json.dumps(body["doc"])
    assert '"placeholder"' not in text_doc
    # Actor resolved to bob (the creator), not alice (the template owner).
    assert "bob" in text_doc
    # Today's UTC date appears in the heading (resolver uses UTC).
    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    assert today in text_doc


@pytest.mark.asyncio
async def test_template_params_endpoint():
    """GET /-/paper/api/template_params lists built-ins with samples."""
    ds = await build_ds()
    r = await ds.client.get(
        "/-/paper/api/template_params", cookies=actor_cookie(ds, "alice")
    )
    assert r.status_code == 200
    body = r.json()
    keys = [item["key"] for item in body["builtins"]]
    assert set(keys) == set(builtin_keys())
    by_key = {item["key"]: item["sample"] for item in body["builtins"]}
    assert by_key["actor"] == "alice"
    # today is a parseable date.
    datetime.date.fromisoformat(by_key["today"])
