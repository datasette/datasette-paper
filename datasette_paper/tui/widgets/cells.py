"""Shared cell-display formatting for the TUI's live ``DataTable`` results
(``sql_block``/``source`` results, ``block_embed`` table/row renders, and
``BrowseScreen``'s row browser) — one choke point so clamping and blob
display can't drift between the three, the terminal-sized analogue of the
web viewer's ``result-cells`` feature (clamp only here; no expand-in-place
interaction in v1, per the ticket).

A cell value is a JSON-safe Datasette scalar, or its ``{"$base64": true,
"encoded": ...}`` blob envelope (see ``datasette_api.py``'s module
docstring). ``format_cell`` renders either as a single display line: a
multi-line value is cut at its first newline (a terminal grid can't render
an embedded newline inside one cell without corrupting the row), then
clamped to ``MAX_CELL_WIDTH`` chars with a trailing ellipsis; a blob
becomes its decoded byte count, never the base64 payload itself.

@feat tui: DataTable cell clamp + blob-size formatting shared by all TUI result tables
"""

from __future__ import annotations

import base64
from typing import Any

MAX_CELL_WIDTH = 80


def clamp_text(text: str, width: int = MAX_CELL_WIDTH) -> str:
    """``text`` cut to ``width`` chars, "…"-suffixed when anything was cut."""
    if len(text) <= width:
        return text
    if width <= 1:
        return text[:width]
    return text[: width - 1] + "…"


def format_cell(value: Any, width: int = MAX_CELL_WIDTH) -> str:
    """Render one Datasette JSON cell value for display in a TUI DataTable."""
    if value is None:
        return ""
    if isinstance(value, dict) and value.get("$base64"):
        encoded = value.get("encoded") or ""
        try:
            n = len(base64.b64decode(encoded))
        except Exception:
            n = 0
        return f"<{n} bytes>"
    if isinstance(value, bool):
        return "true" if value else "false"
    text = str(value).split("\n", 1)[0]
    return clamp_text(text, width)
