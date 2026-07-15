"""Display-only prettification of a block's serialized markdown.

The reader renders each top-level block through a textual ``Markdown`` widget.
Inline atoms arrive in the block markdown as their canonical serialized forms
(see ``datasette_paper/markdown.py``): a ``paper_link`` as ``[[id]]``, a
``mention`` as ``[@id](paper:/actor/<id>)``, a ``tag`` as
``[#slug](paper:/tag/<slug>)``, an ``inline_embed`` as
``[ref](paper:/embed/<kind>/<ref>)``, and a ``value`` as ``${{source.column}}``.
(The block serializer runs resolver-less, so refs come as the *bare*
``[label](paper:/...)`` form rather than the ``[label](url "paper:/...")`` title
form — this function tolerates both.)

``prettify_markdown`` swaps those canonical forms for reader-friendly text —
wikilink ids for their resolved doc titles, mention ids for actor names — using
two batch-resolved maps. It is a pure string transform: the underlying doc
model and the canonical ``block_markdown`` output are never touched, so ticket
04's editing always starts from the unprettified serializer output.

@feat tui: display-only inline-atom prettify pass (reader Markdown widgets)
"""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import unquote

# `[[123]]` wikilink — a paper_link atom.
_WIKILINK_RE = re.compile(r"\[\[(\d+)\]\]")

# A markdown link `[label](dest)` or `[label](dest "title")`. Either the dest or
# the title may carry the canonical `paper:/...` ref (bare vs resolver form).
_LINK_RE = re.compile(r"(?<!\!)\[([^\]]*)\]\(([^)\s]+)(?:\s+\"([^\"]*)\")?\)")


def _canonical(dest: str, title: Optional[str]) -> Optional[str]:
    """The `paper:/...` canonical ref for a link, from title (resolver form)
    or dest (bare form), or ``None`` for an ordinary link."""
    if title and title.startswith("paper:/"):
        return title
    if dest.startswith("paper:/"):
        return dest
    return None


def prettify_markdown(md: str, links_map: dict, actors_map: dict) -> str:
    """Return ``md`` with canonical inline-atom forms replaced by readable text.

    ``links_map`` maps doc id (str or int) to a ``resolve_links`` entry
    (``{"status": "ok", "title": ...}``); ``actors_map`` maps actor id to a
    ``resolve_actors`` entry (``{"name": ...}``). Unresolved / denied ids keep
    their canonical form. ``value`` atoms (``${{...}}``) are left literal.
    """

    def _wikilink(m: re.Match) -> str:
        doc_id = m.group(1)
        entry = links_map.get(doc_id) or links_map.get(int(doc_id)) or {}
        if entry.get("status") == "ok" and entry.get("title"):
            return entry["title"]
        return m.group(0)

    def _link(m: re.Match) -> str:
        label, dest, title = m.group(1), m.group(2), m.group(3)
        canonical = _canonical(dest, title)
        if canonical is None:
            return m.group(0)  # ordinary markdown link — leave untouched
        if canonical.startswith("paper:/actor/"):
            actor_id = unquote(canonical[len("paper:/actor/") :])
            name = (actors_map.get(actor_id) or {}).get("name") or actor_id
            return "@" + name
        # tag / embed / date (and any future paper:/ kind): the label already
        # reads well (`#slug`, the ref, the human date) — drop the link syntax.
        return label

    md = _WIKILINK_RE.sub(_wikilink, md)
    md = _LINK_RE.sub(_link, md)
    return md


def collect_ref_ids(md: str) -> tuple[list, list]:
    """Scan a markdown string for the ids the prettify pass will need.

    Returns ``(doc_ids, actor_ids)`` — wikilink doc ids (as ints) and mention
    actor ids (decoded) — so a doc render can batch-resolve every ref once.
    """
    doc_ids = [int(m.group(1)) for m in _WIKILINK_RE.finditer(md)]
    actor_ids = []
    for m in _LINK_RE.finditer(md):
        canonical = _canonical(m.group(2), m.group(3))
        if canonical and canonical.startswith("paper:/actor/"):
            actor_ids.append(unquote(canonical[len("paper:/actor/") :]))
    return doc_ids, actor_ids
