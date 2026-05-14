"""Server-side resolver for template placeholder nodes.

A template doc can contain inline ``placeholder`` nodes (see
:mod:`datasette_paper.pm_schema`). When the create-from-template route
runs, :func:`substitute_placeholders` walks the materialized template
JSON and rewrites every ``placeholder`` node to a text node whose
content is the resolved value for its ``key`` attr.

The resolver registry is currently built-in only — user-supplied
parameter definitions are a v2 concern (see slice 5 in the plan).

Built-in keys (all derived from request context, never from user
input — built-ins always win over user params with the same name):

* ``today``       — current UTC date as ``YYYY-MM-DD``
* ``now``         — current UTC time as ISO-8601 to seconds
* ``weekday``     — full weekday name (e.g. ``Monday``)
* ``iso_week``    — ISO-8601 week stamp ``YYYY-Www``
* ``year``        — four-digit year
* ``month``       — full month name (e.g. ``April``)
* ``actor``       — actor id of the user creating the doc; empty
                    string for anonymous

Unknown keys are left as a literal ``{key}`` text node so the doc
visibly flags broken substitutions instead of silently dropping them.
"""

from __future__ import annotations

import datetime
from typing import Callable, Optional


# Type alias kept loose so future user-supplied params can be wired in
# without touching every signature.
ResolverContext = dict
Resolver = Callable[[ResolverContext], str]


def _today(ctx: ResolverContext) -> str:
    return ctx["now"].strftime("%Y-%m-%d")


def _now(ctx: ResolverContext) -> str:
    return ctx["now"].strftime("%Y-%m-%dT%H:%M:%SZ")


def _weekday(ctx: ResolverContext) -> str:
    return ctx["now"].strftime("%A")


def _iso_week(ctx: ResolverContext) -> str:
    iso = ctx["now"].isocalendar()
    # isocalendar() returns (year, week, weekday). Pad week to two
    # digits so the string sorts.
    return f"{iso[0]:04d}-W{iso[1]:02d}"


def _year(ctx: ResolverContext) -> str:
    return ctx["now"].strftime("%Y")


def _month(ctx: ResolverContext) -> str:
    return ctx["now"].strftime("%B")


def _actor(ctx: ResolverContext) -> str:
    return ctx.get("actor_id") or ""


BUILTIN_RESOLVERS: dict[str, Resolver] = {
    "today": _today,
    "now": _now,
    "weekday": _weekday,
    "iso_week": _iso_week,
    "year": _year,
    "month": _month,
    "actor": _actor,
}


def builtin_keys() -> list[str]:
    """Return the set of built-in placeholder keys.

    Used by the editor toolbar to populate the Insert-placeholder
    dropdown without round-tripping a discovery endpoint.
    """
    return list(BUILTIN_RESOLVERS)


def build_context(actor_id: Optional[str]) -> ResolverContext:
    """Construct the resolver context shared by every key in one pass.

    ``now`` is computed once so all time-based built-ins agree (e.g.
    ``today`` and ``weekday`` resolve from the same instant even if
    the substitution walks a large doc).
    """
    return {
        "now": datetime.datetime.now(datetime.timezone.utc),
        "actor_id": actor_id,
    }


def resolve_key(key: str, ctx: ResolverContext) -> str:
    """Return the substitution value for *key*.

    Unknown keys fall back to ``{key}`` so the doc visibly flags
    misconfigured templates rather than silently dropping the node.
    """
    resolver = BUILTIN_RESOLVERS.get(key)
    if resolver is None:
        return "{" + key + "}"
    return resolver(ctx)


def substitute_placeholders(doc_json: dict, ctx: ResolverContext) -> dict:
    """Walk *doc_json* and replace every placeholder node with text.

    Returns a new JSON tree; the input is not mutated. Placeholders
    are inline atoms — they only appear inside inline content arrays,
    so the walk treats every node's ``content`` list as the place to
    look for them and substitutes in-place.

    Empty resolved values produce an empty text node, which
    ProseMirror's schema validates *out* — text nodes must have
    non-empty content. To stay safe we drop the placeholder when its
    resolved value is empty (e.g. ``actor`` with no signed-in user)
    rather than emit an invalid text node.
    """
    if not isinstance(doc_json, dict):
        return doc_json

    def walk(node):
        if not isinstance(node, dict):
            return node
        out = dict(node)
        content = out.get("content")
        if isinstance(content, list):
            new_content = []
            for child in content:
                if isinstance(child, dict) and child.get("type") == "placeholder":
                    key = child.get("attrs", {}).get("key", "")
                    value = resolve_key(key, ctx)
                    if value == "":
                        # Drop the node entirely — see docstring.
                        continue
                    new_content.append({"type": "text", "text": value})
                else:
                    new_content.append(walk(child))
            out["content"] = new_content
        return out

    return walk(doc_json)
