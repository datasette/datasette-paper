"""Unit tests for the ProseMirror → markdown serializer."""

import pytest

from datasette_paper.markdown import doc_to_markdown


def _doc(*blocks):
    return {"type": "doc", "content": list(blocks)}


def _para(*inlines):
    return {"type": "paragraph", "content": list(inlines)}


def _text(s, *marks):
    n = {"type": "text", "text": s}
    if marks:
        n["marks"] = [{"type": m} if isinstance(m, str) else m for m in marks]
    return n


def test_empty_doc_renders_to_blank_line():
    assert doc_to_markdown(_doc(_para())) == "\n"


def test_paragraph_with_marks():
    md = doc_to_markdown(
        _doc(
            _para(
                _text("hello "),
                _text("bold", "strong"),
                _text(" "),
                _text("italic", "em"),
                _text(" "),
                _text("code", "code"),
            )
        )
    )
    assert md == "hello **bold** *italic* `code`\n"


def test_link_mark_emits_inline_link():
    md = doc_to_markdown(
        _doc(
            _para(
                _text("see "),
                _text(
                    "docs",
                    {"type": "link", "attrs": {"href": "https://example.com"}},
                ),
            )
        )
    )
    assert md == "see [docs](https://example.com)\n"


def test_headings_emit_h_prefix():
    md = doc_to_markdown(
        _doc(
            {"type": "heading", "attrs": {"level": 1}, "content": [_text("H1")]},
            {"type": "heading", "attrs": {"level": 3}, "content": [_text("H3")]},
        )
    )
    assert "# H1" in md
    assert "### H3" in md


def test_bullet_list():
    md = doc_to_markdown(
        _doc(
            {
                "type": "bullet_list",
                "content": [
                    {"type": "list_item", "content": [_para(_text("a"))]},
                    {"type": "list_item", "content": [_para(_text("b"))]},
                ],
            }
        )
    )
    assert md == "- a\n- b\n"


def test_ordered_list_with_start_attr():
    md = doc_to_markdown(
        _doc(
            {
                "type": "ordered_list",
                "attrs": {"order": 3},
                "content": [
                    {"type": "list_item", "content": [_para(_text("third"))]},
                    {"type": "list_item", "content": [_para(_text("fourth"))]},
                ],
            }
        )
    )
    assert md == "3. third\n4. fourth\n"


def test_blockquote_prefixes_each_line():
    md = doc_to_markdown(
        _doc(
            {
                "type": "blockquote",
                "content": [
                    _para(_text("first")),
                    _para(_text("second")),
                ],
            }
        )
    )
    # Blockquote with two paragraphs → "> first\n>\n> second\n"
    assert "> first" in md
    assert "> second" in md


def _callout(kind, title_text, *body_blocks):
    title_content = [_text(title_text)] if title_text else []
    return {
        "type": "callout",
        "attrs": {"kind": kind},
        "content": [
            {"type": "callout_title", "content": title_content},
            *body_blocks,
        ],
    }


# --- callout (ticket 01 — schema + markdown round-trip) ---


# @feat callout: serialize a titled callout to a `> [!KIND] Title` marker line
def test_callout_with_title_emits_marker_line():
    md = doc_to_markdown(
        _doc(_callout("warning", "Deployment gotcha", _para(_text("Body"))))
    )
    assert md.splitlines()[0] == "> [!WARNING] Deployment gotcha"
    assert "> Body" in md


def test_callout_without_title_emits_bare_marker_line():
    md = doc_to_markdown(_doc(_callout("note", "", _para(_text("Body")))))
    assert md.splitlines()[0] == "> [!NOTE]"


def test_callout_kind_serializes_uppercase():
    for kind in ("note", "tip", "important", "warning", "caution"):
        md = doc_to_markdown(_doc(_callout(kind, "", _para())))
        assert md.startswith(f"> [!{kind.upper()}]")


def test_callout_unknown_kind_clamps_to_note():
    # Defensive clamp — the serializer must never emit an invalid marker even
    # if a bad attr somehow reaches it (see pm_schema.py's "never raises"
    # materializer contract).
    md = doc_to_markdown(_doc(_callout("bogus", "", _para())))
    assert md.startswith("> [!NOTE]")


def test_callout_blank_body_line_is_bare_gt():
    # A blank line inside the body is a bare ">", not "> " with trailing
    # whitespace — same convention as a plain blockquote.
    md = doc_to_markdown(
        _doc(_callout("note", "", _para(_text("first")), _para(_text("second"))))
    )
    lines = md.splitlines()
    assert ">" in lines


def test_callout_body_uses_blockquote_line_prefixing():
    # Multi-line body (a bullet list) gets the same "> "-per-line convention
    # as a plain blockquote's line-prefixing helper.
    md = doc_to_markdown(
        _doc(
            _callout(
                "tip",
                "",
                {
                    "type": "bullet_list",
                    "content": [
                        {"type": "list_item", "content": [_para(_text("item 1"))]},
                        {"type": "list_item", "content": [_para(_text("item 2"))]},
                    ],
                },
            )
        )
    )
    assert "> - item 1" in md
    assert "> - item 2" in md


def test_extract_tasks_finds_task_items_inside_callout():
    from datasette_paper.markdown import extract_tasks

    doc = _doc(
        _callout(
            "note",
            "",
            {
                "type": "task_list",
                "content": [_task_item("inside callout")],
            },
        )
    )
    tasks = extract_tasks(doc)
    assert len(tasks) == 1
    assert tasks[0]["text"] == "inside callout"
    assert tasks[0]["depth"] > 0


def test_code_block_fenced():
    md = doc_to_markdown(
        _doc(
            {
                "type": "code_block",
                "content": [{"type": "text", "text": "x = 1\ny = 2"}],
            }
        )
    )
    assert md.startswith("```")
    assert "x = 1\ny = 2" in md
    assert md.rstrip().endswith("```")


# @feat code-language: serialize a code_block's language into the fence info string
def test_code_block_serializes_language():
    md = doc_to_markdown(
        _doc(
            {
                "type": "code_block",
                "attrs": {"language": "python"},
                "content": [{"type": "text", "text": "x = 1"}],
            }
        )
    )
    assert md == "```python\nx = 1\n```\n"


def test_code_block_null_language_is_bare_fence():
    md = doc_to_markdown(
        _doc({"type": "code_block", "attrs": {"language": None}, "content": []})
    )
    assert md == "```\n\n```\n"


@pytest.mark.parametrize("lang", ["source", "paper-embed", "paper-toc", "paper-table"])
def test_code_block_reserved_language_serializes_bare(lang):
    # A reserved token would parse back as a *different* node (e.g. `source`),
    # so the serializer must drop it to a bare fence.
    md = doc_to_markdown(
        _doc(
            {
                "type": "code_block",
                "attrs": {"language": lang},
                "content": [{"type": "text", "text": "body"}],
            }
        )
    )
    assert md == "```\nbody\n```\n"


@pytest.mark.parametrize("lang", ["db=data", "two words", "back`tick"])
def test_code_block_unsafe_language_serializes_bare(lang):
    # An unsafe token (whitespace / backtick / `=`) could smuggle a `db=`-shaped
    # token and flip a code block into a sql_block; drop it to a bare fence.
    md = doc_to_markdown(
        _doc(
            {
                "type": "code_block",
                "attrs": {"language": lang},
                "content": [{"type": "text", "text": "body"}],
            }
        )
    )
    assert md == "```\nbody\n```\n"


def test_horizontal_rule():
    md = doc_to_markdown(
        _doc(
            _para(_text("before")),
            {"type": "horizontal_rule"},
            _para(_text("after")),
        )
    )
    assert "---" in md
    assert "before" in md
    assert "after" in md


def test_hard_break_renders_as_backslash_newline():
    md = doc_to_markdown(
        _doc(
            _para(
                _text("line one"),
                {"type": "hard_break"},
                _text("line two"),
            )
        )
    )
    assert "line one\\\nline two" in md


def test_non_doc_root_raises():
    with pytest.raises(ValueError):
        doc_to_markdown({"type": "paragraph"})


# ---------------------------------------------------------------------------
# Task lists
# ---------------------------------------------------------------------------


def _task_item(text, checked=False):
    return {
        "type": "task_item",
        "attrs": {"checked": checked},
        "content": [_para(_text(text))],
    }


# @feat task-list: tests task_list GFM checkbox rendering
def test_task_list_renders_gfm_checkboxes():
    md = doc_to_markdown(
        _doc(
            {
                "type": "task_list",
                "content": [
                    _task_item("buy milk"),
                    _task_item("ship feature", checked=True),
                ],
            }
        )
    )
    assert "- [ ] buy milk" in md
    assert "- [x] ship feature" in md


def test_extract_tasks_returns_text_and_state():
    from datasette_paper.markdown import extract_tasks

    doc = _doc(
        {
            "type": "task_list",
            "content": [
                _task_item("first"),
                _task_item("second", checked=True),
            ],
        }
    )
    tasks = extract_tasks(doc)
    assert tasks == [
        {"text": "first", "checked": False, "depth": 1, "section": []},
        {"text": "second", "checked": True, "depth": 1, "section": []},
    ]


def test_extract_tasks_handles_nested_task_lists():
    """A task_item containing another task_list yields tasks at depth+1."""
    from datasette_paper.markdown import extract_tasks

    nested_inner = {
        "type": "task_list",
        "content": [_task_item("deep")],
    }
    outer = {
        "type": "task_list",
        "content": [
            {
                "type": "task_item",
                "attrs": {"checked": False},
                "content": [_para(_text("outer")), nested_inner],
            }
        ],
    }
    tasks = extract_tasks(_doc(outer))
    # Outer task at depth 1, nested at depth 3 (task_list nests +1, item itself does not, then nested task_list +1 again)
    depths = [t["depth"] for t in tasks]
    texts = [t["text"] for t in tasks]
    assert texts == ["outer", "deep"]
    assert depths[1] > depths[0]


def test_extract_tasks_finds_task_items_inside_blockquote_or_lists():
    from datasette_paper.markdown import extract_tasks

    doc = _doc(
        {
            "type": "blockquote",
            "content": [
                {
                    "type": "task_list",
                    "content": [_task_item("inside quote")],
                }
            ],
        }
    )
    tasks = extract_tasks(doc)
    assert len(tasks) == 1
    assert tasks[0]["text"] == "inside quote"


def _heading(level, text):
    return {"type": "heading", "attrs": {"level": level}, "content": [_text(text)]}


def test_extract_tasks_attaches_section_path():
    from datasette_paper.markdown import extract_tasks

    doc = _doc(
        _heading(1, "Project"),
        _heading(2, "Sprint 1"),
        {"type": "task_list", "content": [_task_item("a"), _task_item("b")]},
        _heading(3, "Sprint 1.2"),
        {"type": "task_list", "content": [_task_item("nested")]},
        _heading(2, "Sprint 2"),
        {"type": "task_list", "content": [_task_item("c", checked=True)]},
    )
    tasks = extract_tasks(doc)
    assert [t["text"] for t in tasks] == ["a", "b", "nested", "c"]
    assert tasks[0]["section"] == [
        {"level": 1, "text": "Project"},
        {"level": 2, "text": "Sprint 1"},
    ]
    assert tasks[1]["section"] == tasks[0]["section"]
    assert tasks[2]["section"] == [
        {"level": 1, "text": "Project"},
        {"level": 2, "text": "Sprint 1"},
        {"level": 3, "text": "Sprint 1.2"},
    ]
    # Sprint 2 popped both Sprint 1 and Sprint 1.2 (level >= 2)
    assert tasks[3]["section"] == [
        {"level": 1, "text": "Project"},
        {"level": 2, "text": "Sprint 2"},
    ]


def test_extract_tasks_section_empty_before_any_heading():
    from datasette_paper.markdown import extract_tasks

    doc = _doc(
        {"type": "task_list", "content": [_task_item("orphan")]},
        _heading(2, "Later"),
        {"type": "task_list", "content": [_task_item("under later")]},
    )
    tasks = extract_tasks(doc)
    assert tasks[0]["section"] == []
    assert tasks[1]["section"] == [{"level": 2, "text": "Later"}]


def test_group_tasks_by_section():
    from datasette_paper.markdown import extract_tasks, group_tasks_by_section

    doc = _doc(
        {"type": "task_list", "content": [_task_item("orphan")]},
        _heading(2, "Sprint 1"),
        {"type": "task_list", "content": [_task_item("a"), _task_item("b")]},
        _heading(3, "Sprint 1.2"),
        {"type": "task_list", "content": [_task_item("nested")]},
        _heading(2, "Sprint 2"),
        {"type": "task_list", "content": [_task_item("c")]},
    )
    groups = group_tasks_by_section(extract_tasks(doc))
    assert [g["heading"] for g in groups] == [
        None,
        "Sprint 1",
        "Sprint 1.2",
        "Sprint 2",
    ]
    assert [g["level"] for g in groups] == [None, 2, 3, 2]
    assert [[t["text"] for t in g["tasks"]] for g in groups] == [
        ["orphan"],
        ["a", "b"],
        ["nested"],
        ["c"],
    ]


def test_group_tasks_by_section_repeated_heading_text_makes_two_groups():
    """If `## A` reappears later, its tasks form a separate group."""
    from datasette_paper.markdown import extract_tasks, group_tasks_by_section

    doc = _doc(
        _heading(2, "A"),
        {"type": "task_list", "content": [_task_item("first A")]},
        _heading(2, "B"),
        {"type": "task_list", "content": [_task_item("in B")]},
        _heading(2, "A"),
        {"type": "task_list", "content": [_task_item("second A")]},
    )
    groups = group_tasks_by_section(extract_tasks(doc))
    assert [g["heading"] for g in groups] == ["A", "B", "A"]
    assert [[t["text"] for t in g["tasks"]] for g in groups] == [
        ["first A"],
        ["in B"],
        ["second A"],
    ]


# ---------------------------------------------------------------------------
# Serializer fixes: images, escaping, code-span fences, table-cell marks,
# overlapping inline marks. These pair with the round-trip coverage in
# test_markdown_parser.py.
# ---------------------------------------------------------------------------


def _img(src, alt="", title=None):
    attrs = {"src": src, "alt": alt, "title": title}
    return {"type": "image", "attrs": attrs}


def test_image_renders_inline():
    assert (
        doc_to_markdown(_doc(_para(_img("https://x/y.png", alt="a"))))
        == "![a](https://x/y.png)\n"
    )


def test_image_with_title():
    assert (
        doc_to_markdown(_doc(_para(_img("https://x/y.png", alt="a", title="t"))))
        == '![a](https://x/y.png "t")\n'
    )


def test_image_alt_with_brackets_is_escaped():
    # An unescaped `]` in alt would truncate the image syntax and drop it.
    assert (
        doc_to_markdown(_doc(_para(_img("https://x/y.png", alt="a]b"))))
        == "![a\\]b](https://x/y.png)\n"
    )


def test_image_title_with_quote_is_escaped():
    assert (
        doc_to_markdown(_doc(_para(_img("https://x/y.png", alt="a", title='q"r'))))
        == '![a](https://x/y.png "q\\"r")\n'
    )


def test_image_src_with_space_is_angle_bracketed():
    assert (
        doc_to_markdown(_doc(_para(_img("https://x/with space.png", alt="a"))))
        == "![a](<https://x/with space.png>)\n"
    )


def test_image_src_with_parens_is_angle_bracketed():
    assert (
        doc_to_markdown(_doc(_para(_img("https://x/a(b).png", alt="a"))))
        == "![a](<https://x/a(b).png>)\n"
    )


def test_plain_image_not_over_escaped():
    # A plain http(s) src with no special chars must be byte-identical.
    assert (
        doc_to_markdown(_doc(_para(_img("https://x/y.png", alt="a"))))
        == "![a](https://x/y.png)\n"
    )


def test_markup_chars_in_text_are_escaped():
    # A literal asterisk / underscore / bracket must not re-parse as markup.
    md = doc_to_markdown(_doc(_para(_text("a * b _ c [d]"))))
    assert md == "a \\* b \\_ c \\[d\\]\n"


def test_backslash_in_text_is_escaped():
    assert doc_to_markdown(_doc(_para(_text("a \\ b")))) == "a \\\\ b\n"


def test_code_span_content_with_backticks_uses_longer_fence():
    # A single inner backtick needs a 2-backtick fence. No space padding here
    # since the content neither starts nor ends with a backtick.
    md = doc_to_markdown(_doc(_para(_text("a `b` c", "code"))))
    assert md == "``a `b` c``\n"


def test_code_span_content_starting_with_backtick_is_padded():
    # Leading backtick → pad with a space so the fence isn't miscounted.
    md = doc_to_markdown(_doc(_para(_text("`x", "code"))))
    assert md == "`` `x ``\n"


def test_code_span_content_is_not_escaped():
    # Inside a code span, `*` is literal — must not be backslash-escaped.
    md = doc_to_markdown(_doc(_para(_text("a*b", "code"))))
    assert md == "`a*b`\n"


def test_overlapping_marks_em_outside_strong():
    # em on "foo ", em+strong on "bar" → strong opens *inside* the open em.
    md = doc_to_markdown(
        _doc(
            _para(
                _text("foo ", "em"),
                _text("bar", "em", "strong"),
            )
        )
    )
    assert md == "*foo **bar***\n"


def test_table_cell_marks_are_preserved():
    table = {
        "type": "table",
        "attrs": {"name": None},
        "content": [
            {
                "type": "table_row",
                "content": [
                    {
                        "type": "table_header",
                        "content": [_para(_text("Col"))],
                    }
                ],
            },
            {
                "type": "table_row",
                "content": [
                    {
                        "type": "table_cell",
                        "content": [_para(_text("bold", "strong"))],
                    }
                ],
            },
        ],
    }
    md = doc_to_markdown(_doc(table))
    assert "| **bold** |" in md


def test_named_table_emits_paper_table_sidecar():
    table = {
        "type": "table",
        "attrs": {"name": "sales"},
        "content": [
            {
                "type": "table_row",
                "content": [{"type": "table_header", "content": [_para(_text("Col"))]}],
            },
            {
                "type": "table_row",
                "content": [{"type": "table_cell", "content": [_para(_text("x"))]}],
            },
        ],
    }
    md = doc_to_markdown(_doc(table))
    # Sidecar fence precedes the pipe table, immediately (no blank line).
    assert md.startswith('```paper-table\n{"name": "sales"}\n```\n| Col |\n')


def test_anonymous_table_emits_no_sidecar():
    table = {
        "type": "table",
        "attrs": {"name": None},
        "content": [
            {
                "type": "table_row",
                "content": [{"type": "table_header", "content": [_para(_text("Col"))]}],
            }
        ],
    }
    md = doc_to_markdown(_doc(table))
    assert "paper-table" not in md


def test_named_table_round_trips_through_parser():
    from datasette_paper.markdown_parser import markdown_to_doc

    table = {
        "type": "table",
        "attrs": {"name": "sales report"},
        "content": [
            {
                "type": "table_row",
                "content": [{"type": "table_header", "content": [_para(_text("Col"))]}],
            },
            {
                "type": "table_row",
                "content": [{"type": "table_cell", "content": [_para(_text("x"))]}],
            },
        ],
    }
    md = doc_to_markdown(_doc(table))
    back = markdown_to_doc(md)
    assert back["content"][0]["type"] == "table"
    assert back["content"][0]["attrs"]["name"] == "sales report"


def test_paper_link_renders_double_bracket():
    md = doc_to_markdown(_doc(_para({"type": "paper_link", "attrs": {"docId": 12}})))
    assert "[[12]]" in md


# @feat mention: serialize falls back to actor id with no name map
def test_mention_without_name_map_falls_back_to_actor_id():
    md = doc_to_markdown(
        _doc(_para(_text("Hi "), {"type": "mention", "attrs": {"actorId": "alice"}}))
    )
    assert md == "Hi [@alice](paper:/actor/alice)\n"


def test_mention_with_name_map_uses_display_name():
    md = doc_to_markdown(
        _doc(_para({"type": "mention", "attrs": {"actorId": "alice"}})),
        actor_names={"alice": "Alice Smith"},
    )
    assert md == "[@Alice Smith](paper:/actor/alice)\n"


def test_mention_percent_encodes_awkward_actor_ids():
    md = doc_to_markdown(
        _doc(_para({"type": "mention", "attrs": {"actorId": "team/eng dept"}}))
    )
    assert md == "[@team/eng dept](paper:/actor/team%2Feng%20dept)\n"


# @feat tag: serialize tag atom to a paper:/tag/ scheme link
def test_tag_serializes_as_paper_scheme_link():
    md = doc_to_markdown(
        _doc(_para(_text("Our "), {"type": "tag", "attrs": {"tag": "roadmap"}}))
    )
    assert md == "Our [#roadmap](paper:/tag/roadmap)\n"


def test_tag_percent_encodes_nested_slug():
    md = doc_to_markdown(
        _doc(_para({"type": "tag", "attrs": {"tag": "inbox/to-read"}}))
    )
    assert md == "[#inbox/to-read](paper:/tag/inbox%2Fto-read)\n"


def test_inline_embed_serializes_as_paper_embed_scheme_link():
    md = doc_to_markdown(
        _doc(
            _para(
                _text("see "),
                {"type": "inline_embed", "attrs": {"ref": "/fixtures/facetable"}},
            )
        )
    )
    # The ref keeps its slashes (it doubles as the label) and is the
    # authoritative identity after the `paper:/embed/<kind>/` prefix. Kind is
    # the ticket-02 `datasette` placeholder (ticket 04 supplies the real kind).
    assert (
        md == "see [/fixtures/facetable](paper:/embed/datasette/fixtures/facetable)\n"
    )


# ---------------------------------------------------------------------------
# Ticket 04: resource_url resolver → real href + canonical ref in link title
# ---------------------------------------------------------------------------


def _resolver(mapping):
    """A resource_url resolver from a {(type, value): (kind, url)} mapping."""
    return lambda ref_type, value: mapping.get((ref_type, value))


def test_mention_with_resolver_emits_href_and_title():
    md = doc_to_markdown(
        _doc(_para({"type": "mention", "attrs": {"actorId": "lois"}})),
        resource_url=_resolver({("actor", "lois"): (None, "/-/profile/lois")}),
    )
    assert md == '[@lois](/-/profile/lois "paper:/actor/lois")\n'


def test_tag_with_resolver_emits_href_and_title():
    md = doc_to_markdown(
        _doc(_para({"type": "tag", "attrs": {"tag": "q3"}})),
        resource_url=_resolver({("tag", "q3"): (None, "/-/paper/tag/q3")}),
    )
    assert md == '[#q3](/-/paper/tag/q3 "paper:/tag/q3")\n'


def test_inline_embed_with_provider_resolver_uses_real_kind_and_href():
    md = doc_to_markdown(
        _doc(
            _para(
                {"type": "inline_embed", "attrs": {"ref": "/-/places/list/5"}},
            )
        ),
        resource_url=_resolver(
            {("embed", "/-/places/list/5"): ("place-list", "/-/places/list/5")}
        ),
    )
    # kind is the provider's kind (NOT datasette); href is the real URL, the
    # canonical paper:/embed/<kind>/<ref> ref sits in the title.
    assert md == (
        "[/-/places/list/5](/-/places/list/5 "
        '"paper:/embed/place-list/-/places/list/5")\n'
    )


def test_inline_embed_provider_without_url_emits_bare_canonical():
    # A provider matched (kind set) but no resource_url → bare canonical href.
    md = doc_to_markdown(
        _doc(_para({"type": "inline_embed", "attrs": {"ref": "/-/places/list/5"}})),
        resource_url=_resolver({("embed", "/-/places/list/5"): ("place-list", None)}),
    )
    assert md == "[/-/places/list/5](paper:/embed/place-list/-/places/list/5)\n"


def test_resolver_that_raises_falls_back_to_bare_canonical():
    def boom(ref_type, value):
        raise RuntimeError("provider blew up")

    md = doc_to_markdown(
        _doc(_para({"type": "mention", "attrs": {"actorId": "lois"}})),
        resource_url=boom,
    )
    assert md == "[@lois](paper:/actor/lois)\n"


def test_resolver_title_keeps_canonical_wellformed():
    # An awkward ref char (`"`) is percent-encoded in the canonical so the
    # markdown title stays well-formed; the visible label keeps the raw ref.
    md = doc_to_markdown(
        _doc(_para({"type": "inline_embed", "attrs": {"ref": '/a"b'}})),
        resource_url=_resolver({("embed", '/a"b'): ("datasette", "/real")}),
    )
    assert md == '[/a"b](/real "paper:/embed/datasette/a%22b")\n'


def test_block_embed_serializes_as_paper_embed_json_fence():
    md = doc_to_markdown(
        _doc({"type": "block_embed", "attrs": {"ref": "/fixtures/facetable"}})
    )
    # Sorted-key JSON body with all three attrs (config defaults to {}).
    assert md == (
        "```paper-embed\n"
        '{"config": {}, "mode": "table", "ref": "/fixtures/facetable"}\n```\n'
    )


def test_block_embed_non_default_mode_in_json_body():
    md = doc_to_markdown(
        _doc(
            {
                "type": "block_embed",
                "attrs": {"ref": "/fixtures/facetable/1", "mode": "row"},
            }
        )
    )
    assert md == (
        "```paper-embed\n"
        '{"config": {}, "mode": "row", "ref": "/fixtures/facetable/1"}\n```\n'
    )


def test_block_embed_non_empty_config_in_json_body():
    md = doc_to_markdown(
        _doc(
            {
                "type": "block_embed",
                "attrs": {
                    "ref": "/fixtures/facetable",
                    "mode": "row",
                    "config": {"sort": "-created", "columns": ["name", "id"]},
                },
            }
        )
    )
    # sort_keys gives a stable diff regardless of attr insertion order.
    assert md == (
        "```paper-embed\n"
        '{"config": {"columns": ["name", "id"], "sort": "-created"}, '
        '"mode": "row", "ref": "/fixtures/facetable"}\n```\n'
    )


def test_block_embed_columns_roundtrip_byte_stable():
    # Column-filter-specific guard (the generic config round-trip lives in the
    # paper-url-scheme board): a `config.columns` selection serializes to a
    # stable sorted-key fence and parses back with the author's order intact.
    from datasette_paper.markdown_parser import markdown_to_doc

    doc = _doc(
        {
            "type": "block_embed",
            "attrs": {
                "ref": "/data/vendors",
                "mode": "table",
                "config": {"columns": ["name", "region"]},
            },
        }
    )
    md = doc_to_markdown(doc)
    assert md == (
        "```paper-embed\n"
        '{"config": {"columns": ["name", "region"]}, '
        '"mode": "table", "ref": "/data/vendors"}\n```\n'
    )
    # serialize → parse → identical (order preserved, not reordered/dropped).
    assert markdown_to_doc(md) == doc


# @feat embed-filters: pytest round-trip — filters/sort/columns config ⇄ fence
def test_block_embed_filters_sort_columns_roundtrip_byte_stable():
    # The full filter vocabulary in one config: value-taking ops, a no-value
    # op (no `value` key at all), a sort, and a column subset. Serializes to
    # the exact sorted-keys JSON fence body and parses back to identical
    # attrs — the storage contract the frontend filter UI relies on.
    from datasette_paper.markdown_parser import markdown_to_doc

    doc = _doc(
        {
            "type": "block_embed",
            "attrs": {
                "ref": "/data/vendors",
                "mode": "table",
                "config": {
                    "filters": [
                        {"column": "name", "op": "contains", "value": "Vendor 1"},
                        {"column": "id", "op": "gte", "value": "5"},
                        {"column": "region", "op": "notblank"},
                    ],
                    "sort": {"column": "id", "desc": True},
                    "columns": ["name", "id"],
                },
            },
        }
    )
    md = doc_to_markdown(doc)
    assert md == (
        "```paper-embed\n"
        '{"config": {"columns": ["name", "id"], '
        '"filters": ['
        '{"column": "name", "op": "contains", "value": "Vendor 1"}, '
        '{"column": "id", "op": "gte", "value": "5"}, '
        '{"column": "region", "op": "notblank"}], '
        '"sort": {"column": "id", "desc": true}}, '
        '"mode": "table", "ref": "/data/vendors"}\n```\n'
    )
    # serialize → parse → identical (filter order, the value-less no-value
    # entry, and the sort direction all survive).
    assert markdown_to_doc(md) == doc


def test_toc_serializes_as_empty_paper_toc_fence():
    # All-default (empty) config → a clean empty-body fence.
    md = doc_to_markdown(_doc({"type": "toc", "attrs": {"config": {}}}))
    assert md == "```paper-toc\n```\n"


def test_toc_missing_attrs_serializes_as_empty_fence():
    md = doc_to_markdown(_doc({"type": "toc"}))
    assert md == "```paper-toc\n```\n"


def test_toc_with_config_serializes_sorted_json_and_roundtrips():
    from datasette_paper.markdown_parser import markdown_to_doc

    doc = _doc({"type": "toc", "attrs": {"config": {"maxLevel": 2, "minLevel": 2}}})
    md = doc_to_markdown(doc)
    # sort_keys gives a stable diff regardless of attr insertion order.
    assert md == '```paper-toc\n{"maxLevel": 2, "minLevel": 2}\n```\n'
    assert markdown_to_doc(md) == doc


def test_sql_block_serializes_as_sql_fence():
    md = doc_to_markdown(
        _doc(
            {
                "type": "sql_block",
                "attrs": {"db": "data", "hidden": False},
                "content": [{"type": "text", "text": "select 1 as n"}],
            }
        )
    )
    assert md == "```sql db=data\nselect 1 as n\n```\n"


def test_sql_block_hidden_emits_hidden_token():
    md = doc_to_markdown(
        _doc(
            {
                "type": "sql_block",
                "attrs": {"db": "data", "hidden": True},
                "content": [{"type": "text", "text": "select 1"}],
            }
        )
    )
    assert md == "```sql db=data hidden\nselect 1\n```\n"


# ---------------------------------------------------------------------------
# Ticket 05: combined fixture exercising ALL reference types in one doc.
# Catches interaction bugs the per-type tests miss (e.g. the paper: converter
# vs _split_paper_links ordering, the embed split-once gotcha next to a
# normalized tag, the JSON fence beside inline refs).
# ---------------------------------------------------------------------------


def test_all_reference_types_roundtrip_in_one_doc():
    from datasette_paper.markdown_parser import markdown_to_doc

    doc = _doc(
        _para(
            _text("Ping "),
            {"type": "mention", "attrs": {"actorId": "lois"}},
            _text(" re "),
            {"type": "tag", "attrs": {"tag": "q3"}},
            _text(" see "),
            {"type": "inline_embed", "attrs": {"ref": "/fixtures/facetable/1"}},
            _text(" and doc "),
            {"type": "paper_link", "attrs": {"docId": 42}},
        ),
        {
            "type": "block_embed",
            "attrs": {
                "ref": "/fixtures/facetable",
                "mode": "row",
                "config": {"columns": ["name", "id"], "sort": "-created"},
            },
        },
    )
    # No resolver → bare canonical hrefs, which round-trip byte-identically.
    md = doc_to_markdown(doc)
    back = markdown_to_doc(md)
    assert back == doc


def test_uppercase_hand_authored_tag_is_renormalized():
    # A hand-authored paper:/tag/<UPPER CASE> ref is re-normalized on parse.
    from datasette_paper.markdown_parser import markdown_to_doc

    back = markdown_to_doc("[#X](paper:/tag/Roadmap%20Q3)\n")
    tags = [n for n in back["content"][0]["content"] if n["type"] == "tag"]
    assert len(tags) == 1
    assert tags[0]["attrs"]["tag"] == "roadmap-q3"


def test_plain_external_link_is_never_a_ref():
    from datasette_paper.markdown_parser import markdown_to_doc

    back = markdown_to_doc("see [the docs](https://example.com/page)\n")
    content = back["content"][0]["content"]
    assert all(n["type"] not in ("mention", "tag", "inline_embed") for n in content)
    link = content[-1]
    assert link["marks"][0]["attrs"]["href"] == "https://example.com/page"


def test_source_serializes_as_source_fence():
    md = doc_to_markdown(
        _doc(
            {
                "type": "source",
                "attrs": {"name": "revenue", "db": "data"},
                "content": [
                    {"type": "text", "text": "select sum(amount) as total from t"}
                ],
            }
        )
    )
    assert (
        md
        == "```source name=revenue db=data\nselect sum(amount) as total from t\n```\n"
    )


def test_value_serializes_as_dollar_braces():
    md = doc_to_markdown(
        _doc(
            _para(
                _text("revenue is "),
                {
                    "type": "value",
                    "attrs": {
                        "source": "revenue",
                        "column": "total",
                        "format": None,
                    },
                },
                _text("."),
            )
        )
    )
    assert md == "revenue is ${{revenue.total}}.\n"


def test_value_serializes_with_format_suffix():
    cases = [
        ({"kind": "currency", "currency": "USD"}, "${{revenue.total | currency:USD}}"),
        ({"kind": "number", "decimals": 0}, "${{revenue.total | number:0}}"),
        ({"kind": "number"}, "${{revenue.total | number}}"),
        ({"kind": "percent", "decimals": 1}, "${{revenue.total | percent:1}}"),
        ({"kind": "date", "style": "medium"}, "${{revenue.total | date:medium}}"),
        ({"kind": "text"}, "${{revenue.total | text}}"),
    ]
    for fmt, expected in cases:
        md = doc_to_markdown(
            _doc(
                _para(
                    {
                        "type": "value",
                        "attrs": {
                            "source": "revenue",
                            "column": "total",
                            "format": fmt,
                        },
                    }
                )
            )
        )
        assert md == expected + "\n"


def test_value_with_null_format_emits_bare_form():
    md = doc_to_markdown(
        _doc(
            _para(
                {
                    "type": "value",
                    "attrs": {"source": "revenue", "column": "total", "format": None},
                }
            )
        )
    )
    assert md == "${{revenue.total}}\n"


def test_value_and_placeholder_coexist_in_one_paragraph():
    # The `$` prefix keeps value (`${{src.col}}`) disjoint from a placeholder's
    # bare `{{key}}`; both must serialize side by side without interference.
    md = doc_to_markdown(
        _doc(
            _para(
                {"type": "placeholder", "attrs": {"key": "today", "label": None}},
                _text(" — "),
                {
                    "type": "value",
                    "attrs": {
                        "source": "revenue",
                        "column": "total",
                        "format": None,
                    },
                },
            )
        )
    )
    assert md == "{{today}} — ${{revenue.total}}\n"


# ---------------------------------------------------------------------------
# Ticket 06: remaining lossy round-trips (sql_block / value column / fallback)
# ---------------------------------------------------------------------------


def test_dbless_sql_block_emits_empty_db_discriminator():
    # A db-less sql_block (db=None) must still emit the `db=` discriminator
    # token (`sql db=`) so it doesn't downgrade to a plain ```sql code block
    # on reparse.
    md = doc_to_markdown(
        _doc(
            {
                "type": "sql_block",
                "attrs": {"db": None, "hidden": False},
                "content": [{"type": "text", "text": "select 1 as n"}],
            }
        )
    )
    assert md == "```sql db=\nselect 1 as n\n```\n"


def test_dbless_sql_block_hidden_emits_empty_db_and_hidden():
    md = doc_to_markdown(
        _doc(
            {
                "type": "sql_block",
                "attrs": {"db": None, "hidden": True},
                "content": [{"type": "text", "text": "select 1"}],
            }
        )
    )
    assert md == "```sql db= hidden\nselect 1\n```\n"


@pytest.mark.parametrize(
    "column,expected",
    [
        ("total", "${{revenue.total}}\n"),  # bare \w+ stays unbracketed
        ("total sales", "${{revenue.[total sales]}}\n"),  # space → bracketed
        ("gross-margin", "${{revenue.[gross-margin]}}\n"),  # hyphen → bracketed
        ("a.b", "${{revenue.[a.b]}}\n"),  # dot → bracketed
    ],
)
def test_value_column_bracketing(column, expected):
    md = doc_to_markdown(
        _doc(
            _para(
                {
                    "type": "value",
                    "attrs": {"source": "revenue", "column": column, "format": None},
                }
            )
        )
    )
    assert md == expected


def test_value_bracketed_column_with_format_suffix():
    md = doc_to_markdown(
        _doc(
            _para(
                {
                    "type": "value",
                    "attrs": {
                        "source": "revenue",
                        "column": "total sales",
                        "format": {"kind": "currency", "currency": "USD"},
                    },
                }
            )
        )
    )
    assert md == "${{revenue.[total sales] | currency:USD}}\n"


def test_value_fallback_is_dropped_on_serialize():
    # Documented behaviour (see `_encode_value_format`): the markdown grammar
    # carries only `kind[:arg]`, so a custom `format.fallback` is intentionally
    # NOT serialized. The value's source/column/kind survive; the fallback is
    # lost on a doc→markdown→doc round-trip.
    md = doc_to_markdown(
        _doc(
            _para(
                {
                    "type": "value",
                    "attrs": {
                        "source": "revenue",
                        "column": "total",
                        "format": {
                            "kind": "currency",
                            "currency": "USD",
                            "fallback": "N/A",
                        },
                    },
                }
            )
        )
    )
    assert md == "${{revenue.total | currency:USD}}\n"
    assert "N/A" not in md
