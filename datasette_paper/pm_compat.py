"""Workarounds for prosemirror-py behaviours that bite a long-lived server.

prosemirror-py 0.6.1 keeps a module-global ``ResolvedPos`` cache in
``prosemirror.model.resolvedpos._resolve_cache``. It mirrors the JS
``resolveCache`` WeakMap, but the port keys a plain ``dict`` by ``id(doc)``
and relies on a ``weakref`` callback to evict entries. Every cached
``ResolvedPos`` holds a strong reference to its doc through ``path[0]``, so
the value pins its own key, the callback never fires, and the entry lives
until process exit. JS WeakMaps are ephemeron-safe, so the original never
had this problem.

Each ``Step.apply`` resolves positions on the doc it is applied to, so every
intermediate doc produced while replaying ``steps_tail`` is pinned: one
full-document node graph per tail step per write. With the default 100-step
snapshot threshold that leaked tens of MB per minute for a single typing
editor in production. ``install_bounded_resolve_cache`` swaps the dict for
one with an insertion-order cap; it is called once at ``pm_schema`` import so
every code path that applies steps goes through it.
"""

from prosemirror.model import resolvedpos as _resolvedpos

# The cache only pays off for repeated resolves against the *same* doc
# object. Replaying a step tail touches each intermediate doc once, so any
# cap below the tail length churns it anyway; keep enough for the handful of
# live docs the read routes and validator touch between writes.
RESOLVE_CACHE_MAX_DOCS = 16


class BoundedResolveCache(dict):
    """``dict`` that evicts its oldest entry once ``RESOLVE_CACHE_MAX_DOCS`` is hit.

    prosemirror-py only ever does ``cache[id(doc)] = entry``, ``cache.get``
    and ``cache.pop`` on it, so overriding ``__setitem__`` is sufficient.
    Evicting an entry drops the strong reference its ``ResolvedPos`` list
    holds on the doc; the weakref callback then pops nothing (already gone).
    """

    def __setitem__(self, key, value):
        if key not in self:
            while len(self) >= RESOLVE_CACHE_MAX_DOCS:
                del self[next(iter(self))]
        super().__setitem__(key, value)


def install_bounded_resolve_cache() -> None:
    """Replace prosemirror-py's unbounded resolve cache in place. Idempotent."""
    current = _resolvedpos._resolve_cache
    if isinstance(current, BoundedResolveCache):
        return
    bounded = BoundedResolveCache()
    for key, value in current.items():
        bounded[key] = value
    # ``resolve_cached`` and the ``_ResolveCache`` weakref callback both look
    # the global up by name at call time, so rebinding the attribute is enough.
    _resolvedpos._resolve_cache = bounded
