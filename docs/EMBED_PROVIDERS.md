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

The plugin's backend has exactly **one** job: get the provider's JS/CSS bundle
onto the editor page. That is the `paper_embed_provider` hook.

## Backend: the `paper_embed_provider` hook

```python
from datasette import hookimpl

class PlacesEmbedProvider:
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
- `frontend_assets(datasette) -> {"js": [...], "css": [...]}` is the only
  method. Both keys are optional. URLs are injected into the paper doc page
  (`/-/paper/doc/<id>`) **only**, de-duplicated across providers.
- A provider that raises in `frontend_assets` is logged and skipped — it can't
  break the editor page.

## Frontend: register a renderer

Your bundle registers a provider on the shared `window.datasettePaperEmbeds`
registry:

```js
window.datasettePaperEmbeds ||= /* the same makeEmbedRegistry shim paper ships */;

window.datasettePaperEmbeds.register({
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
});
```

### Interface reference

| Field | Required | Purpose |
| --- | --- | --- |
| `kind` | yes | Stable registry key. Re-registering the same kind replaces the prior provider. |
| `matchRef(ref)` | for embeds | Does this provider own this stored ref path? Core refs are left unclaimed. |
| `matchUrl(url)` | optional | Claim a pasted **same-origin** URL → ref to store. |
| `resolve(ref)` | recommended | Inline-pill identity + denied/not_found. Omit → a generic ref-labelled pill. |
| `mount(host, ctx)` | yes | Render the block body. `ctx = { ref, mode }`. Return a cleanup fn. |

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
delegation cases in `datasetteResolver.test.ts` / `datasetteEmbedView.test.ts`.
