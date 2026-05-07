# frontend/ — Vite + Svelte 5 + ProseMirror

Per-page Vite entries. Each page has a `pages/<name>/main.ts` that
mounts a Svelte component into `#app-root`. The single `paper_base.html`
template injects the matching JS+CSS via `datasette_vite.vite_entry`.

## Where things live

- `vite.config.ts` — `outDir: ../datasette_paper`, `assetsDir: static/gen`,
  `manifest: manifest.json`, `base: /-/static-plugins/datasette_paper/`.
- `src/pages/index/main.ts` / `pages/doc/main.ts` — page entries. Add
  a new page by adding another and registering it in
  `vite.config.ts`'s `rollupOptions.input`.
- `src/lib/collab.ts` — the brain. `EditorConnection` class has the
  state machine in its docstring. The 409 deferred-retry and the
  broadcast clientID-skip are inline-commented at the relevant lines.
- `src/lib/cursors.ts` — presence in/out plugins; filters self by
  clientID **and** actorID (multi-tab same user produces ghost otherwise).
- `src/lib/schema.ts` / `lib/taskItemView.ts` — schema (mirror
  `pm_schema.py`) + checkbox NodeView.
- `src/lib/PaperApp.svelte` / `lib/PaperIndex.svelte` — page wrappers.
- `src/lib/icons.ts` — bootstrap-icons inner-path data, indexed by name.
- `src/lib/client.ts` — openapi-fetch with default
  `Content-Type: application/json` (Datasette's `skip_csrf` requires it).
- `src/lib/pageData.ts` — `loadPageData<T>()` reads the
  `<script id="pageData">` JSON blob the base template emits.
- `api.d.ts` — generated. Run `just types-routes` to regenerate.

## Conventions that bite

- **All API calls go through `client.ts`** or a `fetch` with
  `Content-Type: application/json` — bare POSTs hit `skip_csrf`.
- **PM transactions don't trigger Svelte rerenders.** Components that
  need selection state (Toolbar) RAF-poll a `tick` `$state`.
- **No `$from`-style identifiers in `<script lang="ts">`.** Svelte 5
  reserves `$x`. Destructure to a non-`$` local — `const sel =
  state.selection; sel.$from` works.
- **Don't reach into PM plugins from outside.** `cursors.ts` exposes
  `setRemoteUsers(...)`; dispatch via `setMeta`.
- **`prosemirror-markdown` is dynamically imported** in
  `PaperApp.copyMarkdown()` — eager import drags markdown-it (~50k) in.

## Tests (`vitest` + `jsdom`)

- `EditorConnection` tests stub `fetch` + `EventSource`. **Always call
  `conn.close()`** at the end of each test — the cursor reporter has a
  150ms debounce and a leaked timer fires across later tests.
- Drive input rules with the 5-arg `view.someProp("handleTextInput",
  fn => fn(view, from, to, text, () => view.state.tr))` — svelte-check
  rejects the 4-arg form.

## Don't

- Don't reintroduce mount-root sniffing — each page is a separate Vite
  entry.
- Don't hand-edit `api.d.ts`.
- Don't import `prosemirror-markdown` at the top level.
- Don't add prettier yet — eslint-only. The Svelte 5 parser config in
  `eslint.config.js` (svelte-eslint-parser + tseslint.parser) is
  load-bearing; if you upgrade eslint or eslint-plugin-svelte, re-test
  with `just lint-frontend`.
