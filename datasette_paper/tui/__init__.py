"""Terminal client for paper docs.

A fourth client of the existing HTTP + SSE protocol (browser editor,
read-only endpoints, agent tools being the other three). ``client.py``
holds the protocol layer — ``PaperClient`` / ``DocSession`` — and imports
nothing from textual, so it is reusable on its own. The textual UI lives in
``app.py`` (and, from ticket 02, ``screens/`` + ``widgets/``) and is imported
late by the CLI command so the plugin never requires the ``[tui]`` extra.
"""
