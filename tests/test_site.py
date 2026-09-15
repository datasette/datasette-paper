"""Guards for the static landing page in site/ (published with the docs to
GitHub Pages by `just site`)."""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
INDEX = ROOT / "site" / "index.html"

pytestmark = pytest.mark.skipif(not INDEX.exists(), reason="site/ not scaffolded")


def test_landing_screenshots_exist():
    # `just site` copies these out of docs/screenshots/ at build time.
    names = set(re.findall(r'src="assets/([a-z0-9-]+\.png)"', INDEX.read_text()))
    missing = sorted(
        n for n in names if not (ROOT / "docs" / "screenshots" / n).is_file()
    )
    assert not missing, f"landing references missing screenshots: {missing}"


def test_landing_urls_relative():
    # Project page lives under /datasette-paper/, so root-absolute URLs break.
    bad = re.findall(r'(?:src|href)="/(?!/)[^"]*"', INDEX.read_text())
    assert not bad, f"root-absolute URLs: {bad}"


def test_landing_images_have_alt():
    for tag in re.findall(r"<img[^>]*>", INDEX.read_text()):
        assert re.search(r'alt="[^"]+"', tag), f"img missing alt: {tag}"
