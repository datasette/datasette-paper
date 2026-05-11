"""Step JSON helpers for tests that round-trip through `Instance.add_events`.

`Instance.add_events` validates each step against the live doc before
writing, so tests that exercise the POST or `add_events` path need real
steps that actually apply. Use `insert_at(pos, text)` to build a valid
`replace` step; chain via `insert_sequence(...)` for multi-char inserts.

Underscore-prefixed so pytest doesn't collect it.
"""

from __future__ import annotations

import json


def insert_at(pos: int, text: str = ".") -> str:
    """JSON-encoded ProseMirror `replace` step that inserts `text` at `pos`.

    For an empty doc (`paragraph()`) position 1 lands inside the
    paragraph, and each inserted char advances the cursor by 1.
    """
    return json.dumps(
        {
            "stepType": "replace",
            "from": pos,
            "to": pos,
            "slice": {"content": [{"type": "text", "text": text}]},
        }
    )


def insert_sequence(start_pos: int, text: str) -> list[str]:
    """A sequence of single-char `replace` steps inserting `text` left-to-right."""
    return [insert_at(start_pos + i, ch) for i, ch in enumerate(text)]
