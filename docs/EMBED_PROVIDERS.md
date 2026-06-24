# Third-party embed providers

datasette-paper lets other Datasette plugins render their own resources as rich
embeds inside a paper document — an inline pill (`inline_embed`) or a block card
(`block_embed`). A plugin can, for example, turn a pasted
`/-/places/list/5` link into a live map, or a sheet link into a grid.

## Architecture (read this first)

Paper resolves and renders embeds **entirely in the browser**, against
Datasette's native JSON API, using the *viewer's* `ds_actor` cookie. There is
no paper backend resolve/render endpoint. A provider therefore lives almost
entirely in **frontend JavaScript**: it claims a ref namespace and supplies the
inline-pill identity and the block-card body, fetching its own data from its own
endpoints.

Because the provider fetches with the viewer's cookie, **per-viewer permissions
and leak discipline are the provider's own responsibility** — exactly as for
core db/table/row refs. Never reveal a label or data for a resource the viewer
can't see; return `denied` / `not_found` instead.

The plugin's backend has exactly **one** job: *describe* the provider so paper
can fetch its JS/CSS bundle **on demand**. That is the `paper_embed_provider`
hook. Paper does **not** load every provider on every doc page — it injects a
bundle only when the doc actually uses it (an embed under the provider's
`ref_prefixes`) or when the author picks it from the `/` menu.

## Backend: the `paper_embed_provider` hook

```python
from datasette import hookimpl

class PlacesEmbedProvider:
    kind = "place-list"               # MUST equal the bundle's exported `kind`
    label = "Place list"              # shown in the / menu (optional)
    ref_prefixes = ["/-/places/"]     # stored-ref namespaces this provider owns
    sources = [                       # browsable / menu insert sources (optional)
        {"id": "place-list", "label": "Places", "icon": "geo-alt"},
    ]

    def frontend_assets(self, datasette):
        return {
            "js": ["/-/static-plugins/datasette_places/paper-embed.js"],
            "css": ["/-/static-plugins/datasette_places/paper-embed.css"],
        }

@hookimpl
def paper_embed_provider(datasette):
    return PlacesEmbedProvider()
```

- Return a single provider or a list. The hook is registered on Datasette's own
  plugin manager, so any installed plugin can implement it.
- `kind` (**required**) ties the manifest entry to your bundle's
  exported provider's `kind`. A provider without it is skipped.
- `ref_prefixes` (optional, but needed for lazy-loading) lists the stored-ref
  namespaces you own, e.g. `["/-/places/"]`. When a doc contains an embed whose
  ref starts with one of them, paper injects your bundle and lets it render.
  **For paste-to-embed to work before your bundle loads, your stored ref must be
  the URL's path under one of these prefixes** (paper can't run your in-bundle
  `matchUrl` until the bundle is loaded).
- `label` (optional) is the `/`-menu label; defaults to `kind`.
- `sources` (optional) mirrors your JS `picker()` sources (`id` / `label` /
  `icon` / `mode`) so the `/` menu can list them **before** your bundle loads.
  Each needs an `id`; picking one injects your bundle, then runs its `search()`.
- `frontend_assets(datasette) -> {"js": [...], "css": [...]}` supplies the
  bundle URLs. Both keys optional. They are folded into the doc page's
  `page_data` manifest and lazy-injected — **never** added to every page.
- A provider that raises in `frontend_assets` is logged and skipped — it can't
  break the editor page.

## Frontend: register a renderer

Your bundle is an **ES module**. Its `export default` is the provider object —
paper `import()`s the bundle on demand and registers it for you. 

```js
export default {
  kind: "place-list",

  // Claim a stored ref (checked before paper's native .json resolution).
  matchRef: (ref) => /^\/-\/places\/list\/\d+$/.test(ref),

  // Optional: claim a pasted same-origin URL → the ref to store.
  matchUrl: (url) => {
    const m = url.pathname.match(/^\/-\/places\/list\/(\d+)$/);
    return m ? `/-/places/list/${m[1]}` : null;
  },

  // Inline pill identity. Fetch with the viewer's cookie; apply leak
  // discipline. Return ok | {status:"denied"} | {status:"not_found"} | null.
  async resolve(ref) {
    const res = await fetch(`/-/places/api/lists/${idFrom(ref)}.json`);
    if (res.status === 403) return { status: "denied" };   // NEVER a label here
    if (!res.ok) return { status: "not_found" };
    const j = await res.json();
    return { status: "ok", kind: "place-list", label: j.name, href: ref };
  },

  // Block card body. Paper owns the header (icon + label link + refresh + ⋮);
  // you fill `host`. Return an optional cleanup fn.
  mount(host, ctx) {
    const el = document.createElement("places-map");
    el.setAttribute("ref", ctx.ref);
    host.appendChild(el);
    return () => el.remove();
  },
};
```

### Interface reference

| Field | Required | Purpose |
| --- | --- | --- |
| `kind` | yes | Stable registry key. Re-registering the same kind replaces the prior provider. |
| `matchRef(ref)` | for embeds | Does this provider own this stored ref path? Core refs are left unclaimed. |
| `matchUrl(url)` | optional | Claim a pasted **same-origin** URL → ref to store. |
| `resolve(ref)` | recommended | Inline-pill identity + denied/not_found. Omit → a generic ref-labelled pill. |
| `mount(host, ctx)` | yes | Render the block body. `ctx = { ref, mode }`. Return a cleanup fn. |
| `picker()` | optional | Browsable `/`-menu source spec `{ id, label, icon?, mode? }`. Mirror it in the backend `sources` so it shows before the bundle loads. |
| `search(q, limit)` | with `picker` | Viewer-filtered hits `{ ref, label, kind?, detail? }` for the picker dialog. |

## Rules

- **Leak discipline.** `denied` and `not_found` must carry no label or data.
- **XSS.** Paper renders all labels as text nodes. Inside `mount` you own the
  DOM — never inject untrusted strings as HTML; prefer `textContent` and
  attributes. Paper sanitizes the header `href` (`safeHref`: relative paths and
  `http(s)` only), but anything you build inside `host` is on you.
- **Same-origin only (v1).** `matchUrl` sees same-origin URLs. Rendering
  arbitrary external-web URLs (GitHub, etc.) needs a server-side fetch layer and
  is a separate, future feature.

## Testing

Drive `resolve` with a stubbed `fetch` and assert the denied/not_found mapping;
mount into a detached `host` div and assert the DOM + that the cleanup fn runs.
See `frontend/src/lib/__tests__/embedRegistry.test.ts` and the provider
delegation cases in `datasetteResolver.test.ts` / `blockEmbedView.test.ts`.
