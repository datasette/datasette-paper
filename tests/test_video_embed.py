"""video_embed node: markdown serialize + parse round-trip.

@feat video-embed: backend markdown round-trip for the video_embed atom
"""

from datasette_paper.markdown import doc_to_markdown
from datasette_paper.markdown_parser import markdown_to_doc
from datasette_paper.youtube import parse_youtube_url, youtube_watch_url


ID = "dQw4w9WgXcQ"


def _video(video_id=ID, start=None, provider="youtube"):
    return {
        "type": "video_embed",
        "attrs": {"provider": provider, "videoId": video_id, "start": start},
    }


def _doc(*blocks):
    return {"type": "doc", "content": list(blocks)}


def test_serializes_to_a_bare_canonical_watch_url():
    assert doc_to_markdown(_doc(_video())) == f"https://www.youtube.com/watch?v={ID}\n"
    assert (
        doc_to_markdown(_doc(_video(start=90)))
        == f"https://www.youtube.com/watch?v={ID}&t=90s\n"
    )


def test_lone_youtube_url_paragraph_parses_to_video_embed():
    for src in (
        f"https://www.youtube.com/watch?v={ID}",
        f"https://youtu.be/{ID}",
        f"https://www.youtube.com/embed/{ID}",
    ):
        doc = markdown_to_doc(src)
        assert doc["content"] == [_video()], src


def test_start_offset_round_trips():
    doc = markdown_to_doc(f"https://youtu.be/{ID}?t=1m30s")
    assert doc["content"] == [_video(start=90)]
    assert doc_to_markdown(doc).strip() == youtube_watch_url(ID, 90)


def test_round_trip_is_stable():
    md = f"https://www.youtube.com/watch?v={ID}&t=90s\n"
    assert doc_to_markdown(markdown_to_doc(md)) == md


def test_non_youtube_url_stays_a_link_paragraph():
    doc = markdown_to_doc("https://example.com/watch?v=abc")
    assert doc["content"][0]["type"] == "paragraph"


def test_youtube_url_in_a_list_item_stays_a_link():
    # Only top-level paragraphs convert — a nested URL keeps its link.
    doc = markdown_to_doc(f"- https://youtu.be/{ID}")
    assert doc["content"][0]["type"] == "bullet_list"
    # No video_embed anywhere in the tree.
    assert "video_embed" not in doc_to_markdown(doc)


def test_url_with_surrounding_text_is_not_an_embed():
    doc = markdown_to_doc(f"watch this https://youtu.be/{ID} now")
    assert doc["content"][0]["type"] == "paragraph"


def test_parse_youtube_url_helper():
    assert parse_youtube_url(f"https://youtu.be/{ID}?t=42") == (ID, 42)
    assert parse_youtube_url("https://vimeo.com/1") is None
