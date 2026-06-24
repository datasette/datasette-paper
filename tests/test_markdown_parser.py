"""Unit tests for the markdown → ProseMirror parser (``markdown_parser.py``).

Every produced doc is validated against the real ``pm_schema`` so schema
drift surfaces here. Round-trip tests pair the parser with the existing
``doc_to_markdown`` serializer — see ``test_markdown.py`` for the reverse
direction's own coverage.

The parser was prototyped under ``experiment/`` against a large fixture
corpus (realistic LLM output + adversarial edge cases); these unit tests
pin the behaviour that corpus established. Known serializer-side
round-trip gaps are tracked as ``xfail`` below.
"""

import pytest

from datasette_paper.markdown import doc_to_markdown
from datasette_paper.markdown_parser import markdown_to_doc, markdown_to_fragment
from datasette_paper.pm_schema import schema


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def parse_and_validate(md: str) -> dict:
    """Parse + validate the result against the real ProseMirror schema."""
    doc = markdown_to_doc(md)
    schema.node_from_json(doc).check()
    return doc


def types_only(node: dict) -> str:
    """Compact `type[child, child]` shape for assert messages."""
    t = node.get("type", "?")
    content = node.get("content") or []
    if not content:
        return t
    return f"{t}[{', '.join(types_only(c) for c in content)}]"


# ---------------------------------------------------------------------------
# Block elements
# ---------------------------------------------------------------------------


class TestBlocks:
    def test_empty_input_produces_blank_paragraph(self):
        doc = parse_and_validate("")
        assert doc == {"type": "doc", "content": [{"type": "paragraph"}]}

    def test_whitespace_only_input(self):
        doc = parse_and_validate("   \n\n   \n")
        assert doc == {"type": "doc", "content": [{"type": "paragraph"}]}

    def test_paragraph(self):
        doc = parse_and_validate("hello world\n")
        assert doc["content"] == [
            {"type": "paragraph", "content": [{"type": "text", "text": "hello world"}]}
        ]

    @pytest.mark.parametrize("level", [1, 2, 3, 4, 5, 6])
    def test_heading_levels(self, level):
        doc = parse_and_validate("#" * level + " title\n")
        h = doc["content"][0]
        assert h["type"] == "heading"
        assert h["attrs"]["level"] == level
        assert h["content"] == [{"type": "text", "text": "title"}]

    def test_horizontal_rule(self):
        doc = parse_and_validate("before\n\n---\n\nafter\n")
        assert (
            types_only(doc) == "doc[paragraph[text], horizontal_rule, paragraph[text]]"
        )

    def test_code_block_fenced(self):
        doc = parse_and_validate("```\nprint('x')\n```\n")
        cb = doc["content"][0]
        assert cb["type"] == "code_block"
        assert cb["content"] == [{"type": "text", "text": "print('x')"}]

    def test_code_block_fenced_with_language_drops_info(self):
        # The schema has no language attr today; verify we silently drop it
        # without producing an invalid doc.
        doc = parse_and_validate("```python\nx = 1\n```\n")
        cb = doc["content"][0]
        assert cb["type"] == "code_block"
        assert "attrs" not in cb or "language" not in (cb.get("attrs") or {})

    def test_code_block_indented(self):
        doc = parse_and_validate("    indented code\n")
        cb = doc["content"][0]
        assert cb["type"] == "code_block"
        assert cb["content"] == [{"type": "text", "text": "indented code"}]

    def test_sql_block_from_sql_db_fence(self):
        doc = parse_and_validate("```sql db=data\nselect 1 as n\n```\n")
        sb = doc["content"][0]
        assert sb["type"] == "sql_block"
        assert sb["attrs"] == {"db": "data", "hidden": False}
        assert sb["content"] == [{"type": "text", "text": "select 1 as n"}]

    def test_sql_block_hidden_token(self):
        doc = parse_and_validate("```sql db=data hidden\nselect 1\n```\n")
        sb = doc["content"][0]
        assert sb["type"] == "sql_block"
        assert sb["attrs"] == {"db": "data", "hidden": True}

    def test_plain_sql_fence_without_db_stays_code_block(self):
        # The `db=` token is the discriminator: a plain ```sql fence is just a
        # syntax-display code block, not a runnable SQL query block.
        doc = parse_and_validate("```sql\nselect 1\n```\n")
        cb = doc["content"][0]
        assert cb["type"] == "code_block"

    def test_sql_block_round_trips(self):
        md = "```sql db=data hidden\nselect * from t\n```\n"
        assert doc_to_markdown(parse_and_validate(md)) == md

    def test_blockquote(self):
        doc = parse_and_validate("> quote\n")
        assert types_only(doc) == "doc[blockquote[paragraph[text]]]"

    def test_blockquote_nested(self):
        doc = parse_and_validate("> outer\n>\n> > inner\n")
        outer = doc["content"][0]
        assert outer["type"] == "blockquote"
        inner = outer["content"][-1]
        assert inner["type"] == "blockquote"
        assert types_only(inner) == "blockquote[paragraph[text]]"

    def test_html_block_becomes_code_block(self):
        doc = parse_and_validate("<div>raw</div>\n")
        # With html=False the html_block path isn't taken — md-it falls back
        # to plain text rendering. Verify the content survives as text.
        text = doc_to_markdown(doc)
        assert "<div>raw</div>" in text


# ---------------------------------------------------------------------------
# Inline marks
# ---------------------------------------------------------------------------


class TestMarks:
    def test_strong(self):
        doc = parse_and_validate("**bold**\n")
        text_node = doc["content"][0]["content"][0]
        assert text_node["text"] == "bold"
        assert text_node["marks"] == [{"type": "strong"}]

    def test_em(self):
        doc = parse_and_validate("*em*\n")
        text_node = doc["content"][0]["content"][0]
        assert text_node["marks"] == [{"type": "em"}]

    def test_code_inline(self):
        doc = parse_and_validate("`x`\n")
        text_node = doc["content"][0]["content"][0]
        assert text_node["text"] == "x"
        assert text_node["marks"] == [{"type": "code"}]

    def test_link(self):
        doc = parse_and_validate("[label](https://example.com)\n")
        text_node = doc["content"][0]["content"][0]
        assert text_node["text"] == "label"
        assert text_node["marks"] == [
            {"type": "link", "attrs": {"href": "https://example.com"}}
        ]

    def test_link_with_title(self):
        doc = parse_and_validate('[x](https://example.com "t")\n')
        text_node = doc["content"][0]["content"][0]
        attrs = text_node["marks"][0]["attrs"]
        assert attrs["href"] == "https://example.com"
        assert attrs["title"] == "t"

    def test_link_empty_href_drops_mark(self):
        """`[text]()` would crash the schema if we kept a link mark with no href.

        The mark drops cleanly and the text comes through unmarked.
        """
        doc = parse_and_validate("[text]()\n")
        text_node = doc["content"][0]["content"][0]
        assert text_node["text"] == "text"
        assert "marks" not in text_node

    def test_nested_marks(self):
        doc = parse_and_validate("**bold *and em***\n")
        # Two text nodes: 'bold ' (strong) and 'and em' (strong+em).
        para = doc["content"][0]
        assert len(para["content"]) == 2
        assert para["content"][0]["text"] == "bold "
        assert para["content"][0]["marks"] == [{"type": "strong"}]
        assert para["content"][1]["text"] == "and em"
        assert {m["type"] for m in para["content"][1]["marks"]} == {"strong", "em"}

    def test_mark_inside_link(self):
        doc = parse_and_validate("[**bold**](https://example.com)\n")
        text_node = doc["content"][0]["content"][0]
        assert text_node["text"] == "bold"
        types = {m["type"] for m in text_node["marks"]}
        assert types == {"strong", "link"}


# ---------------------------------------------------------------------------
# Inline non-mark nodes
# ---------------------------------------------------------------------------


class TestInlineNodes:
    def test_softbreak_renders_as_space(self):
        doc = parse_and_validate("line1\nline2\n")
        text_node = doc["content"][0]["content"][0]
        assert text_node["text"] == "line1 line2"

    def test_hardbreak(self):
        doc = parse_and_validate("a\\\nb\n")
        nodes = doc["content"][0]["content"]
        assert [n["type"] for n in nodes] == ["text", "hard_break", "text"]

    def test_image(self):
        doc = parse_and_validate('![alt](https://example.com/x.png "title")\n')
        img = doc["content"][0]["content"][0]
        assert img["type"] == "image"
        assert img["attrs"] == {
            "src": "https://example.com/x.png",
            "alt": "alt",
            "title": "title",
        }

    def test_image_no_title(self):
        doc = parse_and_validate("![alt](https://example.com/x.png)\n")
        img = doc["content"][0]["content"][0]
        assert img["attrs"]["title"] is None

    def test_text_coalescing(self):
        """Adjacent text nodes with identical marks should be merged."""
        # Soft break produces three tokens (text, softbreak-as-space, text)
        # which should coalesce into a single text node.
        doc = parse_and_validate("a\nb\n")
        para = doc["content"][0]
        assert len(para["content"]) == 1
        assert para["content"][0]["text"] == "a b"

    def test_paper_link(self):
        doc = parse_and_validate("see [[12]] ok\n")
        para = doc["content"][0]
        assert para["type"] == "paragraph"
        content = para["content"]
        assert [n["type"] for n in content] == ["text", "paper_link", "text"]
        assert content[0]["text"] == "see "
        assert content[1]["attrs"]["docId"] == 12
        assert content[2]["text"] == " ok"

    def test_paper_link_non_numeric_stays_text(self):
        doc = parse_and_validate("[[notanumber]]\n")
        content = doc["content"][0]["content"]
        assert [n["type"] for n in content] == ["text"]
        assert content[0]["text"] == "[[notanumber]]"

    def test_paper_link_multiple(self):
        doc = parse_and_validate("a [[1]] b [[2]] c\n")
        content = doc["content"][0]["content"]
        links = [n for n in content if n["type"] == "paper_link"]
        assert [link["attrs"]["docId"] for link in links] == [1, 2]

    def test_mention_from_actor_scheme_link(self):
        doc = parse_and_validate("Hi [@Alice Smith](actor:alice-id) there\n")
        content = doc["content"][0]["content"]
        assert [n["type"] for n in content] == ["text", "mention", "text"]
        assert content[0]["text"] == "Hi "
        assert content[1]["attrs"]["actorId"] == "alice-id"
        assert "marks" not in content[1]
        assert content[2]["text"] == " there"

    def test_mention_percent_decodes_actor_id(self):
        doc = parse_and_validate("[@Team](actor:team%2Feng%20dept)\n")
        content = doc["content"][0]["content"]
        assert [n["type"] for n in content] == ["mention"]
        assert content[0]["attrs"]["actorId"] == "team/eng dept"

    def test_ordinary_link_is_not_a_mention(self):
        doc = parse_and_validate("see [docs](https://example.com/y)\n")
        content = doc["content"][0]["content"]
        assert all(n["type"] != "mention" for n in content)
        link = content[-1]
        assert link["marks"][0]["attrs"]["href"] == "https://example.com/y"

    def test_tag_from_tag_scheme_link(self):
        doc = parse_and_validate("Our [#roadmap](tag:roadmap) plan\n")
        content = doc["content"][0]["content"]
        assert [n["type"] for n in content] == ["text", "tag", "text"]
        assert content[0]["text"] == "Our "
        assert content[1]["attrs"]["tag"] == "roadmap"
        assert "marks" not in content[1]
        assert content[2]["text"] == " plan"

    def test_tag_percent_decodes_slug(self):
        doc = parse_and_validate("[#nested](tag:inbox%2Fto-read)\n")
        content = doc["content"][0]["content"]
        assert [n["type"] for n in content] == ["tag"]
        assert content[0]["attrs"]["tag"] == "inbox/to-read"

    def test_ordinary_link_is_not_a_tag(self):
        doc = parse_and_validate("see [docs](https://example.com/y)\n")
        content = doc["content"][0]["content"]
        assert all(n["type"] != "tag" for n in content)
        link = content[-1]
        assert link["marks"][0]["attrs"]["href"] == "https://example.com/y"

    def test_tag_slug_is_normalized(self):
        # A hand-authored href with chars the editor could never type
        # (uppercase, `]`) is normalized to the canonical slug rule, so the
        # stored tag never contains `]`.
        doc = parse_and_validate("[#x](tag:Foo%5DBar)\n")
        content = doc["content"][0]["content"]
        assert [n["type"] for n in content] == ["tag"]
        assert content[0]["attrs"]["tag"] == "foobar"

    def test_unnormalizable_tag_slug_drops_atom(self):
        # A slug that normalizes to empty produces no tag atom (lossy, like
        # other out-of-schema content) rather than an invalid empty tag.
        doc = parse_and_validate("[#x](tag:%5D%5D)\n")
        content = doc["content"][0]["content"]
        assert all(n["type"] != "tag" for n in content)


# ---------------------------------------------------------------------------
# Inline + block embeds
# ---------------------------------------------------------------------------


class TestInlineEmbed:
    def test_ref_from_datasette_scheme_link(self):
        doc = parse_and_validate("see [x](datasette:/fixtures/facetable) ok\n")
        content = doc["content"][0]["content"]
        assert [n["type"] for n in content] == ["text", "inline_embed", "text"]
        assert content[0]["text"] == "see "
        assert content[1]["attrs"]["ref"] == "/fixtures/facetable"
        assert "marks" not in content[1]
        assert content[2]["text"] == " ok"

    def test_ref_percent_decodes_path(self):
        doc = parse_and_validate("[x](datasette:/db/t%20with%20space/1)\n")
        content = doc["content"][0]["content"]
        assert [n["type"] for n in content] == ["inline_embed"]
        assert content[0]["attrs"]["ref"] == "/db/t with space/1"

    def test_ordinary_link_is_not_a_ref(self):
        doc = parse_and_validate("see [docs](https://example.com/y)\n")
        content = doc["content"][0]["content"]
        assert all(n["type"] != "inline_embed" for n in content)


class TestBlockEmbed:
    def test_embed_fence_default_mode(self):
        doc = parse_and_validate("```datasette-embed\n/fixtures/facetable\n```\n")
        block = doc["content"][0]
        assert block["type"] == "block_embed"
        assert block["attrs"] == {"ref": "/fixtures/facetable", "mode": "table"}

    def test_embed_fence_with_mode_line(self):
        doc = parse_and_validate(
            "```datasette-embed\n/fixtures/facetable/1\nmode: row\n```\n"
        )
        block = doc["content"][0]
        assert block["type"] == "block_embed"
        assert block["attrs"] == {"ref": "/fixtures/facetable/1", "mode": "row"}

    def test_plain_fence_stays_code_block(self):
        doc = parse_and_validate("```\n/fixtures/facetable\n```\n")
        assert doc["content"][0]["type"] == "code_block"

    def test_other_info_string_stays_code_block(self):
        doc = parse_and_validate("```python\nx = 1\n```\n")
        assert doc["content"][0]["type"] == "code_block"


# ---------------------------------------------------------------------------
# Lists
# ---------------------------------------------------------------------------


class TestLists:
    def test_bullet_list(self):
        doc = parse_and_validate("- a\n- b\n- c\n")
        assert types_only(doc).startswith("doc[bullet_list[")

    def test_ordered_list(self):
        doc = parse_and_validate("1. one\n2. two\n")
        ol = doc["content"][0]
        assert ol["type"] == "ordered_list"

    def test_ordered_list_start_attr(self):
        doc = parse_and_validate("3. three\n4. four\n")
        ol = doc["content"][0]
        assert ol.get("attrs", {}).get("order") == 3

    def test_nested_bullet_list(self):
        doc = parse_and_validate("- a\n  - a.1\n  - a.2\n- b\n")
        ul = doc["content"][0]
        first_item = ul["content"][0]
        # list_item content: paragraph + nested bullet_list
        assert any(c["type"] == "bullet_list" for c in first_item["content"])

    def test_deeply_nested_lists(self):
        doc = parse_and_validate("- a\n  - b\n    - c\n      - d\n        - e\n")
        # Just assert it parses + validates.
        assert doc["content"][0]["type"] == "bullet_list"


class TestTaskLists:
    def test_task_list_open_and_closed(self):
        doc = parse_and_validate("- [ ] open\n- [x] done\n")
        tl = doc["content"][0]
        assert tl["type"] == "task_list"
        items = tl["content"]
        assert items[0]["attrs"]["checked"] is False
        assert items[1]["attrs"]["checked"] is True

    def test_task_item_text_strips_checkbox_marker(self):
        doc = parse_and_validate("- [ ] hello\n")
        item = doc["content"][0]["content"][0]
        para = item["content"][0]
        assert para["content"][0]["text"] == "hello"

    def test_nested_task_lists(self):
        md = "- [ ] parent\n  - [ ] child open\n  - [x] child done\n"
        doc = parse_and_validate(md)
        parent_item = doc["content"][0]["content"][0]
        # parent contains a paragraph + a nested task_list
        nested = [c for c in parent_item["content"] if c["type"] == "task_list"]
        assert len(nested) == 1
        assert nested[0]["content"][0]["attrs"]["checked"] is False
        assert nested[0]["content"][1]["attrs"]["checked"] is True

    def test_mixed_items_in_one_list_become_all_task_items(self):
        """When md-it groups a checkbox item and a plain item into one <ul>,
        we have to commit to one shape (pm_schema's task_list rejects
        list_item children). Policy: promote everything to task_item with
        the plain ones unchecked."""
        doc = parse_and_validate("- [ ] task\n- plain\n")
        tl = doc["content"][0]
        assert tl["type"] == "task_list"
        # Both children should be task_items
        kinds = {c["type"] for c in tl["content"]}
        assert kinds == {"task_item"}
        assert tl["content"][0]["attrs"]["checked"] is False  # explicit unchecked
        assert tl["content"][1]["attrs"]["checked"] is False  # implicit (no checkbox)

    def test_task_list_and_bullet_list_in_same_doc(self):
        """A heading between two lists keeps them distinct."""
        doc = parse_and_validate("- [ ] task\n\n## sep\n\n- bullet\n")
        kinds = [c["type"] for c in doc["content"]]
        assert kinds == ["task_list", "heading", "bullet_list"]


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------


class TestTables:
    def test_simple_table(self):
        md = "| h1 | h2 |\n| --- | --- |\n| a | b |\n"
        doc = parse_and_validate(md)
        table = doc["content"][0]
        assert table["type"] == "table"
        rows = table["content"]
        assert len(rows) == 2
        header_cells = rows[0]["content"]
        body_cells = rows[1]["content"]
        assert all(c["type"] == "table_header" for c in header_cells)
        assert all(c["type"] == "table_cell" for c in body_cells)

    def test_table_cell_wraps_content_in_paragraph(self):
        doc = parse_and_validate("| a |\n| --- |\n| body |\n")
        table = doc["content"][0]
        body_cell = table["content"][1]["content"][0]
        # Content spec for table_cell is `block+` — text must be wrapped.
        inner = body_cell["content"][0]
        assert inner["type"] == "paragraph"
        assert inner["content"] == [{"type": "text", "text": "body"}]

    def test_table_name_attr_defaults_to_none(self):
        doc = parse_and_validate("| h |\n| --- |\n| x |\n")
        table = doc["content"][0]
        assert table["attrs"]["name"] is None

    def test_table_with_marks_inside_cells(self):
        md = "| h |\n| --- |\n| **bold** |\n"
        doc = parse_and_validate(md)
        cell = doc["content"][0]["content"][1]["content"][0]
        text = cell["content"][0]["content"][0]
        assert text["text"] == "bold"
        assert text["marks"] == [{"type": "strong"}]


# ---------------------------------------------------------------------------
# Robustness on ugly / hostile input
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "label,src",
    [
        ("unbalanced strong", "this **never closes\n"),
        ("unbalanced fence", "```\nno close\n"),
        ("missing href", "[text]()\n"),
        ("very long line", "x" * 10_000),
        ("unicode", "café — résumé 😀\n"),
        ("script tag", "<script>alert(1)</script>\n"),
        ("only heading marker", "##\n"),
        ("table missing cells", "| a | b |\n| --- | --- |\n| only |\n"),
        ("just heading marker no space", "#nospace\n"),
    ],
)
def test_ugly_inputs_validate(label, src):
    """Every ugly input still produces a schema-valid PM doc."""
    doc = parse_and_validate(src)
    assert doc["type"] == "doc"


# ---------------------------------------------------------------------------
# Fragment helper
# ---------------------------------------------------------------------------


class TestFragment:
    def test_fragment_returns_block_list(self):
        blocks = markdown_to_fragment("# Heading\n\nparagraph\n")
        assert [b["type"] for b in blocks] == ["heading", "paragraph"]

    def test_fragment_empty_input_returns_empty_list(self):
        """Append helpers don't want a placeholder paragraph injected."""
        assert markdown_to_fragment("") == []
        assert markdown_to_fragment("   \n\n") == []

    def test_fragment_is_pm_fragment_compatible(self):
        """The list should round-trip through PM's Fragment API + Step.apply."""
        from prosemirror.model import Fragment, Node, Slice
        from prosemirror.transform import ReplaceStep

        start_doc = Node.from_json(schema, markdown_to_doc("# Existing\n"))
        blocks = markdown_to_fragment("- one\n- two\n")
        pm_nodes = [Node.from_json(schema, b) for b in blocks]
        fragment = Fragment.from_array(pm_nodes)
        step = ReplaceStep(
            start_doc.content.size,
            start_doc.content.size,
            Slice(fragment, 0, 0),
        )
        result = step.apply(start_doc)
        assert not result.failed
        result.doc.check()
        types = [c["type"] for c in result.doc.to_json()["content"]]
        assert types == ["heading", "bullet_list"]


# ---------------------------------------------------------------------------
# Round-trip: md → doc → md → doc converges in one pass.
# ---------------------------------------------------------------------------


ROUNDTRIP_STABLE = [
    "# H1\n\npara with **bold** and *em*.\n",
    "- a\n- b\n  - b.1\n- c\n",
    "1. one\n2. two\n",
    "- [ ] open\n- [x] done\n",
    "> quote\n>\n> > nested\n",
    "```\ncode\n```\n",
    "| h | h |\n| --- | --- |\n| a | b |\n",
    "para 1\n\n---\n\npara 2\n",
    "soft\nbreak\n",
    "hard\\\nbreak\n",
    "[link](https://example.com)\n",
    "[text]()\n",
    "para with **adj** **acent** bold\n",
    # --- regression cases for the serializer round-trip fixes ---
    # marks inside table cells (were flattened to plain text)
    "| col | val |\n| --- | --- |\n| **bold** | `code` |\n",
    # images (were dropped on serialize)
    "![alt](https://example.com/x.png)\n",
    '![alt](https://example.com/x.png "a title")\n',
    # datasette inline ref + block embed
    "see [/fixtures/facetable](datasette:/fixtures/facetable)\n",
    "```datasette-embed\n/fixtures/facetable\n```\n",
    "```datasette-embed\n/fixtures/facetable/1\nmode: row\n```\n",
    # markdown-significant chars in plain text (re-parsed as markup unescaped)
    "literal star \\* and underscore \\_ and bracket \\[x\\]\n",
    "a backslash \\\\ in text\n",
    # overlapping marks: em outside strong, and strong outside em
    "*em **and strong***\n",
    "**bold *and em***\n",
    # inline code whose content contains backticks (needs a longer fence)
    "a code span with `` ` `` a backtick\n",
    # deep task-list nesting (indented past the code-block threshold before)
    "- [ ] a\n  - [ ] b\n    - [x] c\n",
    # nested mixed lists deeper than two levels
    "- a\n  - b\n    - c\n      - d\n",
]


@pytest.mark.parametrize("src", ROUNDTRIP_STABLE)
def test_md_doc_md_doc_converges(src):
    doc1 = parse_and_validate(src)
    md1 = doc_to_markdown(doc1)
    doc2 = markdown_to_doc(md1)
    schema.node_from_json(doc2).check()
    assert doc1 == doc2


def test_image_roundtrips_through_serializer():
    src = "![alt](https://example.com/x.png)\n"
    doc1 = parse_and_validate(src)
    md1 = doc_to_markdown(doc1)
    doc2 = markdown_to_doc(md1)
    assert doc1 == doc2


def _image_node(src, alt="", title=None):
    return {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "image",
                        "attrs": {"src": src, "alt": alt, "title": title},
                    }
                ],
            }
        ],
    }


@pytest.mark.parametrize(
    "src,alt,title",
    [
        # alt with bracket / other inline-markup chars (would truncate the
        # image syntax and drop the image entirely without escaping).
        ("https://x/y.png", "a]b", None),
        ("https://x/y.png", "x[y]z", None),
        ("https://x/y.png", "star * under _ tick `x`", None),
        # title containing the `"` delimiter.
        ("https://x/y.png", "a", 'q"r'),
        # src with balanced and unbalanced parens (angle-bracket form).
        ("https://x/a(b).png", "alt", None),
        ("https://x/a(b.png", "alt", None),
        # plain reference — must survive untouched.
        ("https://example.com/x.png", "alt", None),
        ("https://example.com/x.png", "alt", "a title"),
    ],
)
def test_image_attrs_roundtrip_with_special_chars(src, alt, title):
    doc1 = _image_node(src, alt, title)
    schema.node_from_json(doc1).check()
    md = doc_to_markdown(doc1)
    doc2 = markdown_to_doc(md)
    assert doc1 == doc2, md


def test_image_src_with_space_survives_roundtrip():
    # markdown-it percent-encodes the space when normalizing the URL, so the
    # src is not byte-identical — the key guarantee is the image is NOT lost.
    doc1 = _image_node("https://x/with space.png", alt="a")
    md = doc_to_markdown(doc1)
    doc2 = markdown_to_doc(md)
    node = doc2["content"][0].get("content")
    assert node and node[0]["type"] == "image", md
    assert node[0]["attrs"]["alt"] == "a"


def test_mention_roundtrips_through_serializer():
    src = "Hi [@Alice](actor:alice-id) there\n"
    doc1 = parse_and_validate(src)
    md1 = doc_to_markdown(doc1)
    doc2 = markdown_to_doc(md1)
    assert doc1 == doc2


def test_inline_embed_roundtrips_through_serializer():
    src = "see [/fixtures/facetable](datasette:/fixtures/facetable) ok\n"
    doc1 = parse_and_validate(src)
    md1 = doc_to_markdown(doc1)
    doc2 = markdown_to_doc(md1)
    assert doc1 == doc2


def test_block_embed_roundtrips_through_serializer():
    src = "```datasette-embed\n/fixtures/facetable/1\nmode: row\n```\n"
    doc1 = parse_and_validate(src)
    md1 = doc_to_markdown(doc1)
    doc2 = markdown_to_doc(md1)
    assert doc1 == doc2


@pytest.mark.parametrize("actor_id", ["alice", "team/eng dept", "weird:id"])
def test_mention_doc_to_md_to_doc_preserves_actor_id(actor_id):
    doc = {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [{"type": "mention", "attrs": {"actorId": actor_id}}],
            }
        ],
    }
    back = markdown_to_doc(doc_to_markdown(doc))
    mentions = [n for n in back["content"][0]["content"] if n["type"] == "mention"]
    assert len(mentions) == 1
    assert mentions[0]["attrs"]["actorId"] == actor_id
