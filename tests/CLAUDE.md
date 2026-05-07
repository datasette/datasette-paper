# tests/ — pytest

Backend unit + route tests. Conventional pytest + `pytest-asyncio`. Each
test file's docstring describes its coverage; this doc only flags
cross-cutting fixtures and patterns.

## Shared fixtures (`conftest.py`)

- `ds` — `Datasette(memory=True, ...)` with the four paper permissions
  granted, `invoke_startup()` awaited (migrations run), and
  `ds.client.get/post` monkey-patched to inject a default `alice`
  actor cookie. Without the cookie, anonymous actors hit the per-paper
  permission gate and get denied.
- `ds_paper` — `ds` + a freshly-created paper. Returns `(ds, doc_id)`.

A handful of tests bypass the fixtures and build `Datasette` directly
to exercise denial paths (`test_permissions.py`, the anonymous-creation
case in `test_actor.py`).

## Patterns

**Permissions: drop `list`/`create` to test denial.** View/edit are
*not* statically granted in the fixtures — they're resolved by the
`permission_resources_sql` hook, and granting them globally would mask
share-model bugs.

**Actor cookie injection** (when bypassing the fixtures):

```python
cookie = ds.sign({"a": {"id": "alice"}}, "actor")
resp = await ds.client.post(url, json=body, cookies={"ds_actor": cookie})
```

**Force a registry re-hydrate** when a test mutates the DB directly
and needs the in-memory `Instance` to pick up the change:

```python
registry = get_registry(ds)
registry._instances.pop(doc_id, None)
```

**Plant a synthetic snapshot** for `/document` + `/tasks` tests that
need rich content:

```python
db = paper_db(datasette)
await db.insert_snapshot(doc_id=doc_id, version=0,
                         doc_json=json.dumps({...}), actor_id=None)
get_registry(datasette)._instances.pop(doc_id, None)  # force re-hydrate
```

**Monkeypatch knobs** for edge cases:

- `instance.MAX_TAIL = 2` → trigger `GoneError`
- `instance.MAX_INSTANCES = 2` → exercise LRU eviction
- `sse.HEARTBEAT_SECONDS = 0.05` → SSE heartbeat path

**Broadcast assertions:** `await asyncio.wait_for(q.get(), timeout=1)`
on a queue from `Instance.subscribe()`.

## Don't

- Don't reach for module-level fixtures unless tests truly share state
  — per-test in-memory Datasette keeps tests isolated and avoids
  cross-test registry leaks.
- Don't assert on raw step JSON strings in broadcast payloads — they
  ship as parsed objects (see `test_subscribe_receives_broadcast`).
- Don't pass `headers={"content-type": ...}` to `Response()` expecting
  it to override the content type — Datasette's `Response` uses
  `content_type=` kwarg; the headers dict is appended, not merged.
- Don't statically grant `datasette-paper-view`/`-edit` in fixture
  configs — masks the SQL resource hook.
