#!/usr/bin/env python3
"""Keep a hand-authored feature registry in sync with in-code `@feat` markers.

A lightweight, dependency-free traceability check for any codebase. Two
human-authored sources, each owning what it's closest to:

  - a registry markdown file (default FEATURES.md) — a table whose first
    column is a backticked slug and whose last backticked-only column (if
    present) is the feature's "start here" file. Source of truth for the
    *feature-level* description.
  - marker comments in the source (keyword set by --marker, default
    "@feat") — one per load-bearing site, each carrying a short "what this
    codepath does" note. In whatever comment syntax the file uses:

        <marker> <slug>: what this codepath does here
        <marker> <slug-a> <slug-b>: a note shared by several slugs

Nothing is generated. Grepping the marker keyword is the per-site view;
the registry is the index you read first. This script only validates that
the two stay consistent:

  - every marker carries a non-empty description;
  - every slug used in a marker is registered (no orphans);
  - every registered slug has at least one marker, and — unless
    --no-require-test — at least one marker in a test file;
  - a registered start file actually carries a marker for its slug;
  - lock-step groups (--lockstep): if a feature touches any file in the
    group it must touch them all (mirror files that must change together,
    e.g. a schema defined in parallel on two sides of a wire), unless the
    slug is listed in --lockstep-exempt (a non-schema feature that
    legitimately lives partly in a mirror file — e.g. an extractor that
    reads the schema's nodes from inside the serializer).

Everything project-specific is a flag; run `--help` for the list. Exits
non-zero and prints every violation on failure.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

DEFAULT_EXCLUDES = [
    ".git",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
    ".svelte-kit",
    ".venv",
]
DEFAULT_EXTS = [
    ".py",
    ".pyi",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".svelte",
    ".vue",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".rb",
    ".php",
    ".c",
    ".h",
    ".cc",
    ".cpp",
    ".cs",
    ".swift",
    ".scala",
    ".css",
    ".scss",
    ".html",
]
# A path is a "test file" if its repo-relative posix path matches this.
DEFAULT_TEST_REGEX = (
    r"(^|/)(tests?|__tests__|spec|e2e)/|(^|/)test_|\.(test|spec)\.[\w]+$"
)

SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="features_check",
        description="Validate `@feat` markers against a feature registry.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--root",
        type=Path,
        default=Path.cwd(),
        help="repo root; --scan/--lockstep paths are relative to it",
    )
    p.add_argument(
        "--registry",
        default="FEATURES.md",
        help="registry markdown file (relative to --root unless absolute)",
    )
    p.add_argument(
        "--scan",
        action="append",
        metavar="DIR",
        help="directory to scan for markers (repeatable; default: the root)",
    )
    p.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="NAME",
        help=f"directory name to skip (repeatable; added to {DEFAULT_EXCLUDES})",
    )
    p.add_argument(
        "--ext",
        action="append",
        default=[],
        metavar=".EXT",
        help="file extension to scan (repeatable; added to a broad default set)",
    )
    p.add_argument(
        "--marker",
        default="@feat",
        help="marker keyword to grep for in comments",
    )
    p.add_argument(
        "--lockstep",
        action="append",
        default=[],
        metavar="A,B,C",
        help="comma-separated group of files that must be marked together "
        "(repeatable for multiple groups); paths relative to --root",
    )
    p.add_argument(
        "--lockstep-exempt",
        action="append",
        default=[],
        metavar="SLUG",
        help="feature slug allowed to touch a lock-step file without touching "
        "the whole group (a non-schema feature that legitimately lives partly "
        "in a mirror file, e.g. an extractor in the serializer); repeatable",
    )
    p.add_argument(
        "--require-test",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="require each feature to carry a marker in a test file",
    )
    p.add_argument(
        "--test-regex",
        default=DEFAULT_TEST_REGEX,
        help="regex (on the repo-relative posix path) identifying a test file",
    )
    return p.parse_args(argv)


def norm_ext(e: str) -> str:
    return e if e.startswith(".") else "." + e


def iter_source_files(
    root: Path, scan_dirs: list[str], excludes: set[str], exts: set[str]
) -> list[Path]:
    out: list[Path] = []
    for rel_dir in scan_dirs:
        base = (root / rel_dir).resolve()
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or path.suffix not in exts:
                continue
            if excludes & set(path.relative_to(root).parts):
                continue
            out.append(path)
    return out


def parse_markers(
    files: list[Path], root: Path, marker_re: re.Pattern, errors: list[str]
) -> dict[str, set[str]]:
    """slug -> set of repo-relative posix paths carrying a marker for it."""
    feature_paths: dict[str, set[str]] = {}
    for path in files:
        rel = path.relative_to(root).as_posix()
        for lineno, text in enumerate(
            path.read_text(encoding="utf-8", errors="replace").splitlines(), 1
        ):
            m = marker_re.search(text)
            if not m:
                continue
            slug_part, sep, desc = m.group("body").partition(":")
            if not sep or not desc.strip():
                errors.append(
                    f"{rel}:{lineno}: marker needs a description "
                    "(`<marker> <slug>: what this codepath does`)"
                )
            for slug in slug_part.split():
                if not SLUG_RE.match(slug):
                    errors.append(
                        f"{rel}:{lineno}: bad slug {slug!r} (want kebab-case [a-z0-9-])"
                    )
                    continue
                feature_paths.setdefault(slug, set()).add(rel)
    return feature_paths


# A registry row: first cell a backticked slug; the last cell, when it is a
# lone backticked token, is the feature's start file.
_CELL_PATH_RE = re.compile(r"^`([^`]+)`$")


def parse_registry(path: Path, errors: list[str]) -> dict[str, str | None]:
    """slug -> start file (or None) parsed from the registry markdown table."""
    registry: dict[str, str | None] = {}
    if not path.exists():
        errors.append(f"registry file not found: {path}")
        return registry
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if not cells:
            continue
        head = _CELL_PATH_RE.match(cells[0])
        if not head or not SLUG_RE.match(head.group(1)):
            continue  # header / separator / non-feature rows
        slug = head.group(1)
        start = None
        if len(cells) >= 3:
            tail = _CELL_PATH_RE.match(cells[-1])
            if tail:
                start = tail.group(1)
        registry[slug] = start
    return registry


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    root = args.root.resolve()
    registry_path = Path(args.registry)
    if not registry_path.is_absolute():
        registry_path = root / registry_path

    scan_dirs = args.scan or ["."]
    excludes = set(DEFAULT_EXCLUDES) | set(args.exclude)
    exts = {norm_ext(e) for e in DEFAULT_EXTS + args.ext}
    marker_re = re.compile(rf"{re.escape(args.marker)}\b[ \t]+(?P<body>.+?)\s*$")
    test_re = re.compile(args.test_regex)
    lockstep_groups = [
        frozenset(f.strip() for f in grp.split(",") if f.strip())
        for grp in args.lockstep
    ]

    errors: list[str] = []
    files = iter_source_files(root, scan_dirs, excludes, exts)
    feature_paths = parse_markers(files, root, marker_re, errors)
    registry = parse_registry(registry_path, errors)

    for slug in sorted(set(feature_paths) - set(registry)):
        where = ", ".join(sorted(feature_paths[slug]))
        errors.append(
            f"{slug}: marked in code ({where}) but not in {registry_path.name}"
        )

    for slug, start in sorted(registry.items()):
        paths = feature_paths.get(slug, set())
        if not paths:
            errors.append(
                f"{slug}: in {registry_path.name} but has no `{args.marker}` markers"
            )
            continue
        if args.require_test and not any(test_re.search(p) for p in paths):
            errors.append(
                f"{slug}: no test marker — at least one `{args.marker} {slug}` "
                "must sit in a test file (proof of the capability)"
            )
        if start and start not in paths:
            errors.append(
                f"{slug}: start file `{start}` carries no `{args.marker} {slug}` marker"
            )
        if slug in set(args.lockstep_exempt):
            continue
        for group in lockstep_groups:
            touched = paths & group
            missing = group - paths
            if touched and missing:
                errors.append(
                    f"{slug}: lock-step incomplete — present in {sorted(touched)} "
                    f"but missing {sorted(missing)}; these files must change together"
                )

    if errors:
        print("features check failed:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print(f"features ok: {len(registry)} feature(s), markers in sync.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
