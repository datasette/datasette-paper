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


def test_paper_link_renders_double_bracket():
    md = doc_to_markdown(_doc(_para({"type": "paper_link", "attrs": {"docId": 12}})))
    assert "[[12]]" in md


def test_mention_without_name_map_falls_back_to_actor_id():
    md = doc_to_markdown(
        _doc(_para(_text("Hi "), {"type": "mention", "attrs": {"actorId": "alice"}}))
    )
    assert md == "Hi [@alice](actor:alice)\n"


def test_mention_with_name_map_uses_display_name():
    md = doc_to_markdown(
        _doc(_para({"type": "mention", "attrs": {"actorId": "alice"}})),
        actor_names={"alice": "Alice Smith"},
    )
    assert md == "[@Alice Smith](actor:alice)\n"


def test_mention_percent_encodes_awkward_actor_ids():
    md = doc_to_markdown(
        _doc(_para({"type": "mention", "attrs": {"actorId": "team/eng dept"}}))
    )
    assert md == "[@team/eng dept](actor:team%2Feng%20dept)\n"


def test_tag_serializes_as_tag_scheme_link():
    md = doc_to_markdown(
        _doc(_para(_text("Our "), {"type": "tag", "attrs": {"tag": "roadmap"}}))
    )
    assert md == "Our [#roadmap](tag:roadmap)\n"


def test_tag_percent_encodes_nested_slug():
    md = doc_to_markdown(
        _doc(_para({"type": "tag", "attrs": {"tag": "inbox/to-read"}}))
    )
    assert md == "[#inbox/to-read](tag:inbox%2Fto-read)\n"


def test_inline_embed_serializes_as_datasette_scheme_link():
    md = doc_to_markdown(
        _doc(
            _para(
                _text("see "),
                {"type": "inline_embed", "attrs": {"ref": "/fixtures/facetable"}},
            )
        )
    )
    # The path keeps its slashes (it doubles as the label) and is the
    # authoritative identity after the `datasette:` scheme.
    assert md == "see [/fixtures/facetable](datasette:/fixtures/facetable)\n"


def test_block_embed_serializes_as_fenced_block():
    md = doc_to_markdown(
        _doc({"type": "block_embed", "attrs": {"ref": "/fixtures/facetable"}})
    )
    assert md == "```datasette-embed\n/fixtures/facetable\n```\n"


def test_block_embed_non_default_mode_emits_mode_line():
    md = doc_to_markdown(
        _doc(
            {
                "type": "block_embed",
                "attrs": {"ref": "/fixtures/facetable/1", "mode": "row"},
            }
        )
    )
    assert md == "```datasette-embed\n/fixtures/facetable/1\nmode: row\n```\n"
