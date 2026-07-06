"""YouTube URL grammar for the ``video_embed`` node's markdown round-trip.

Mirror of ``frontend/src/lib/youtube.ts`` — keep the accepted URL shapes and
the canonical ``watch?v=`` output in step so a paste on the client and a
markdown import on the server produce the same node. Used by
``markdown_parser.py`` (bare URL paragraph -> ``video_embed``) and
``markdown.py`` (``video_embed`` -> bare canonical URL).
"""

import re
from typing import Optional, Tuple
from urllib.parse import parse_qs, urlsplit

# An 11-char YouTube video id.
_VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")

_HOSTS = {"youtube.com", "youtu.be", "youtube-nocookie.com"}

_DURATION_RE = re.compile(r"^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$", re.IGNORECASE)


def _bare_host(hostname: str) -> str:
    return re.sub(r"^(www\.|m\.|music\.)", "", hostname.lower())


def _parse_start(raw: Optional[str]) -> Optional[int]:
    """Parse a ``t`` / ``start`` param into whole seconds (``90``, ``90s``,
    ``1m30s``, ``1h2m3s``), or None when unparseable or non-positive."""
    if not raw:
        return None
    value = raw.strip()
    if value.isdigit():
        n = int(value)
        return n if n > 0 else None
    m = _DURATION_RE.match(value)
    if not m or not any(m.groups()):
        return None
    secs = (
        int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)
    )
    return secs if secs > 0 else None


def parse_youtube_url(text: str) -> Optional[Tuple[str, Optional[int]]]:
    """Parse text into ``(video_id, start_seconds)``, or None if it isn't a
    single YouTube video URL. Accepts watch / youtu.be / embed / shorts / live /
    v forms; a channel / playlist / search URL yields None."""
    trimmed = (text or "").strip()
    if not trimmed or re.search(r"\s", trimmed):
        return None
    parts = urlsplit(trimmed)
    if parts.scheme not in ("http", "https"):
        return None
    host = _bare_host(parts.hostname or "")
    if host not in _HOSTS:
        return None

    segments = [s for s in parts.path.strip("/").split("/") if s]
    query = parse_qs(parts.query)
    video_id: Optional[str] = None
    if host == "youtu.be":
        video_id = segments[0] if segments else None
    elif not segments or segments[0] == "watch":
        video_id = (query.get("v") or [None])[0]
    elif segments[0] in ("embed", "shorts", "live", "v"):
        video_id = segments[1] if len(segments) > 1 else None
    if not video_id or not _VIDEO_ID_RE.match(video_id):
        return None

    start_raw = (query.get("t") or query.get("start") or [None])[0]
    return video_id, _parse_start(start_raw)


def youtube_watch_url(video_id: str, start: Optional[int]) -> str:
    """Canonical watch URL — the single form the markdown serializer emits."""
    base = f"https://www.youtube.com/watch?v={video_id}"
    return f"{base}&t={start}s" if start and start > 0 else base
