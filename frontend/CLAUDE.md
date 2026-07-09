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
- `src/lib/tables.ts` — table commands (`insertTable`, `tabOrAddRow`,
  `setTableName`, `findTable`, `canInsertTable`,
  `countOtherTablesWithName`).
- `src/lib/tableInsertTooltip.ts` — `Plugin.view` that owns *all*
  in-table UI (add/delete row/col, delete table, name input + live
  duplicate warning, API link). Anchored centered above the enclosing
  table; not a Svelte component.
- `src/lib/linkTooltip.ts` — `Plugin.view` showing a hover tooltip on
  plain `<a>` link marks in edit mode (URL display + Open / Copy). Scoped
  to class-less link marks, so embed/NodeView anchors are skipped.
- `src/lib/linkOpen.ts` — `Plugin` whose `handleDOMEvents.click` opens a
  plain `<a>` link mark in a new tab when clicked in edit mode (same
  class-less scoping). View mode navigates natively.
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
- **Debug editor bugs via the document model, not the DOM.** The live
  `EditorView` is exposed at `window.__pmView` (`PaperApp.svelte`,
  un-gated so it survives the prod build). The rendered DOM hides where
  the caret actually landed and pollutes `innerText` with widget
  decorations; read `window.__pmView.state` (or `readEditorState()` in
  e2e). See `e2e/CLAUDE.md` — headless Chromium masks invalid model
  selections, so cursor bugs need model assertions or a unit test.
- **No `$from`-style identifiers in `<script lang="ts">`.** Svelte 5
  reserves `$x`. Destructure to a non-`$` local — `const sel =
  state.selection; sel.$from` works.
- **Don't reach into PM plugins from outside.** `cursors.ts` exposes
  `setRemoteUsers(...)`; dispatch via `setMeta`.
- **`prosemirror-markdown` is dynamically imported** in
  `PaperApp.copyMarkdown()` — eager import drags markdown-it (~50k) in.
- **Table UI is split between `Toolbar.svelte` and
  `tableInsertTooltipPlugin`.** Toolbar holds *only* the disabled-when-
  not-empty Insert-table button (gated by `canInsertTable(state)`).
  All in-table actions live in the floating tooltip; don't add new
  table-mode controls to the toolbar.
- **Tooltip z-index must stay above `.paper-toolbar` (sticky, z:10).**
  `.pm-table-tooltip-root` is z:11 — without that, the toolbar
  intercepts pointer events on tables that scroll near the top.
- **Name input commits on blur/Enter, never per-keystroke.** The
  pattern (`tableInsertTooltip.ts`) keeps a local draft synced from the
  doc only when entering a *different* table; calling `view.focus()`
  from the input handlers steals focus on every keystroke and will
  re-break it.
- **`tabOrAddRow` does two consecutive dispatches** — first
  `addRowAfter` (so the view applies + re-renders), then
  `goToNextCell(1)` against the resulting state. Single-transaction
  chaining doesn't work because `goToNextCell` needs to read the new
  row's cell positions.

## Tests (`vitest` + `jsdom`)

- `EditorConnection` tests stub `fetch` + `EventSource`. **Always call
  `conn.close()`** at the end of each test — the cursor reporter has a
  150ms debounce and a leaked timer fires across later tests.
- Drive input rules with the 5-arg `view.someProp("handleTextInput",
  fn => fn(view, from, to, text, () => view.state.tr))` — svelte-check
  rejects the 4-arg form.

## Screenshots (`scripts/screenshots.mjs` → `docs/screenshots/*.png`)

Self-contained Playwright harness: boots its own throwaway datasette, seeds
deterministic papers, captures the committed PNGs the README embeds. Run with
`just shots` (all) or `just shots editor tables` (subset). Output is committed
— only re-commit PNGs when the UI actually changed.

`screenshots.mjs` is a **thin runner**. The harness is a package under
`scripts/shots/`: `config.mjs` (constants + `out()`), `server.mjs`
(boot/teardown), `cookie.mjs` (signed `ds_actor`), `seed.mjs` (`seed()` + the
markdown fixtures), `helpers.mjs` (`freezeVolatile` / `gotoEditor` /
`shotUnion` + content waiters), and `defineShot.mjs`.

**To add or change a screenshot, edit ONE file** — `scripts/shots/defs/<name>.mjs`
(the file name *is* the shot id; the runner asserts they match). The runner
globs `defs/` so no registration is needed. Each file default-exports a
`defineShot({…})` descriptor:

```js
// defs/editor.mjs — simplest case: open a seeded doc, full-page capture
import { defineShot } from "../defineShot.mjs";
export default defineShot({ name: "editor", order: 2, doc: "richId" });
```

```js
// defs/slash-menu.mjs — interaction before capture
import { defineShot } from "../defineShot.mjs";
export default defineShot({
  name: "slash-menu",
  order: 8,
  doc: "slashId",
  prepare: async (page) => {
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("/");
    await page.locator(".pm-slash-menu").waitFor({ state: "visible", timeout: 10_000 });
  },
});
```

Descriptor fields: `name` (required, == file name); `order` (run sequence);
`doc` (an `ids` key → `gotoEditor`) or `goto` (full nav control, e.g. a
non-editor URL or a POST-then-navigate); `prepare` (interaction + waits);
`capture` (default = full-page `page.screenshot`; override for
element/dialog/`shotUnion` — `capture: (page, file) => page.locator(SEL).screenshot({ path: file })`);
`freeze` (default true; set false only for dialogs with no volatile text).

- **`doc:` references a seeded doc by an `ids` key.** Need a new fixture? Add
  the markdown + a `create(...)` in `shots/seed.mjs` and return its id from
  `seed()` — that key is what `doc:` accepts.
- **`order` is load-bearing only where shots share a *mutable* doc.** A shot
  that types into a doc (`wiki-links`, `inline-tag-popup`, `inline-value-popup`)
  must run *after* any shot that screenshots that same doc clean — give it a
  higher `order`. Independent shots can use any value. The runner sorts by
  `(order, name)`.
- **Determinism is the contract.** `freezeVolatile()` rewrites moving text
  (timestamps, "N users online") and a stability stylesheet hides the caret +
  disables animations, so an unchanged UI yields no binary diff. After editing,
  run `just shots <name>` and confirm `git diff docs/screenshots/` only moves
  the PNGs you meant to. New volatile text → extend `freezeVolatile` in
  `shots/helpers.mjs`. Build the bundle first (`just frontend`) — shots load the
  built page, not a dev server.

## Don't

- Don't reintroduce mount-root sniffing — each page is a separate Vite
  entry.
- Don't hand-edit `api.d.ts`.
- Don't import `prosemirror-markdown` at the top level.
- Don't add prettier yet — eslint-only. The Svelte 5 parser config in
  `eslint.config.js` (svelte-eslint-parser + tseslint.parser) is
  load-bearing; if you upgrade eslint or eslint-plugin-svelte, re-test
  with `just lint-frontend`.
