# e2e/ — Playwright

Full-stack specs against a real Datasette + bundle subprocess, ~3-4s
per run. `playwright.config.ts` sits next to this directory in
`frontend/`; run via `just test-e2e` (which `cd`s into `frontend`).

## Setup quirks

- `webServer.command` runs `rm -f /tmp/datasette-paper-e2e-internal.db`
  then datasette with all four paper permissions granted globally.
  Tests within a run share state; the DB resets per `npx playwright
  test` invocation.
- `workers: 1`, `fullyParallel: false` — keeps SSE multi-client
  scenarios deterministic.
- The webServer creates papers anonymously (no signed actor cookie at
  the playwright layer), so `canManage` is always false. Owner-flow
  coverage lives in `tests/test_share.py`; e2e exercises only the
  read-only share-dialog path.
- **`webServer` does NOT run `just frontend`.** Build the bundle first
  (CI does this; locally you'll see a blank page if you skip it).

## Helpers (`helpers.ts`)

- `BASE = "/-/paper"` (no per-database segment).
- `createPaper(page, name?)` → `{id, url, name}`.
- `gotoPaper(page, url)` — navigates and awaits `.ProseMirror`.
- `typeInEditor(page, text)`, `expectEditorContains(page, sub)`.
- `waitForServerVersion(page, docId, minVersion)` — **use this
  before `page.reload()`.** Reload aborts in-flight POST batches;
  without the wait, only the first keystroke's batch is persisted.
  **Don't use it as a generic "wait for the API to be ready" helper.**
  When the action you're verifying is the *last* dispatch in a batch
  (e.g. `setNodeMarkup` for a table name after typing 20+ keystrokes
  into cells), `minVersion` clears well before that final step lands.
  Poll the API endpoint directly with `expect.poll(...).toBe(200)` —
  see `tables.spec.ts` for the pattern.

## Stubbing the clipboard

Headless chromium needs OS permissions for real
`navigator.clipboard`. The Copy-md spec installs a stub via
`page.addInitScript` (sets `window.__lastCopy`); the test reads it
back via `page.evaluate`.

## Stability check

For changes that touch routing, SSE, or the editor, run the suite
three times locally:

```
cd frontend
for i in 1 2 3; do timeout 90 npx playwright test e2e/collab.spec.ts \
    --reporter=line | tail -2; done
```

The two-context spec was flaky before the 409 deferred-retry fix and
the broadcast clientID-skip filter. If it starts flaking again,
suspect changes to `collab.ts`'s `_send` 409 path or
`Instance.add_events`'s broadcast loop.

## Don't

- Don't rely on server state from a *previous* spec — `createPaper` per
  spec.
- Don't `page.reload()` immediately after typing without
  `waitForServerVersion(...)` — see helper.
- Don't enable parallel workers without rethinking the shared DB and
  the subscriber-filter assumptions.
