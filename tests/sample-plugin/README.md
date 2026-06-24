# Sample embed providers (demo + test fixture)

A runnable example of a third-party plugin that adds **custom embeds** to the
datasette-paper editor — exercising both halves of the contract:

- **backend** — the `paper_embed_provider` hook (`sample_embeds.py`): declares
  two providers (`playlist`, `widget`) with `kind` / `label` / `ref_prefixes` /
  `sources` / `frontend_assets`, and serves their JS bundles + per-viewer JSON
  from its own routes.
- **frontend** — vanilla JS bundles (`playlists.js`, `widgets.js`) that
  `window.datasettePaperEmbeds.register({...})` with `resolve` (inline pill),
  `mount` (rich block card), `matchRef` / `matchUrl`, and `picker` / `search`.

See `../../docs/EMBED_PROVIDERS.md` for the full contract.

## What it demonstrates

- **Inline + block** rendering from one provider (a playlist pill vs a track
  list with play-count bars; a widget badge vs a gauge).
- **Per-viewer permissions**, enforced by the provider's *own* routes against
  the viewer's `request.actor` (paper is never in that path):
  - `summer-mix` / `gotham-nights` — visible to the owner or their newsroom.
  - `front-page-hits` / `newsstand` — public to any signed-in actor.
  - `press-pass` — known-but-forbidden → **403 denied** for other newsrooms.
  - `bat-signal` — **secret** → **404 not-found** for anyone but `bruce`
    (leak discipline: never reveal it exists).
- **Lazy loading** — these bundles load only when a doc uses one of their embeds
  or the author picks the source from `/`.

## Try it (dev)

```
just dev          # loads this plugin (--plugins-dir) + datasette-debug-gotham
```

Then in a paper doc:

1. Type `/` → pick **Playlists** or **Widgets** → search → insert. Or paste a
   ref like `/-/sample-embeds/playlists/summer-mix`.
2. Use the debug-bar **"act as"** switch (datasette-debug-gotham) to change the
   viewer — e.g. `clark` (daily-planet) vs `bruce` (gotham-gazette) — and watch
   the same embeds resolve, deny, or vanish per the permissions above.

## Test it

`../test_sample_embeds.py` registers this plugin and asserts the manifest, JS
serving, the permission matrix (allowed / 403 / secret-404), search filtering,
and the manifest landing on a real doc page.
