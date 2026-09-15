project = "datasette-paper"
author = "Alex Garcia"
copyright = "2026, Alex Garcia"

extensions = ["myst_parser", "sphinx_copybutton", "sphinx.ext.extlinks"]
myst_enable_extensions = ["colon_fence"]
myst_heading_anchors = 3  # PERMISSIONS.md has in-page #anchors
source_suffix = {".md": "markdown"}
master_doc = "index"
smartquotes = False

# EMBED_PROVIDERS.md has a ```js fence containing escaped-regex literals that
# trip Pygments' JS lexer (it falls back to relaxed-mode lexing and renders
# fine either way) -- untouched per-file content, not a real doc problem, so
# suppress the warning category rather than edit that file.
suppress_warnings = ["misc.highlighting_failure"]

# The uppercase originals are pulled in via {include} wrappers; don't also
# build them as standalone pages. Screenshots dir has no sources.
exclude_patterns = [
    "_build",
    "PERMISSIONS.md",
    "EMBED_PROVIDERS.md",
    "screenshots/sample-embeds/**",
]

html_theme = "furo"
html_title = "datasette-paper"
html_baseurl = "https://datasette.github.io/datasette-paper/docs/"
html_static_path = ["_static"]
html_theme_options = {
    "sidebar_hide_name": False,
    "source_repository": "https://github.com/datasette/datasette-paper/",
    "source_branch": "main",
    "source_directory": "docs/",
}

extlinks = {
    "issue": ("https://github.com/datasette/datasette-paper/issues/%s", "#%s"),
    "pr": ("https://github.com/datasette/datasette-paper/pull/%s", "#%s"),
}
