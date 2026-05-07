# datasette-paper permissions

A reference for how datasette-paper layers per-resource permissions on top of
Datasette's permissions API. The intent is that a sibling plugin (e.g. one
that wants per-resource sharing on top of some other domain object) can read
this doc and reproduce the model.

## TL;DR

Four actions, two global and two per-paper:

| Action | Scope | Notes |
|---|---|---|
| `datasette-paper-list` | global | gate the index + list endpoint; also gates whether visibility-based grants apply |
| `datasette-paper-create` | global | `also_requires=datasette-paper-list` |
| `datasette-paper-view` | per-paper (`PaperResource`) | resolved by the SQL hook against owner / share / visibility |
| `datasette-paper-edit` | per-paper (`PaperResource`) | `also_requires=datasette-paper-view`; only owner + `editor` shares + `link-edit` visibility allow |

`manage` (visibility flips, share mutations) is **not** an action. It's
owner-only, enforced inline by comparing `_datasette_paper_doc.created_by`
to the actor id in the route handler.

Wire-up touches three Datasette hooks:

1. `register_actions` — declares the four actions and their `resource_class` /
   `also_requires` chain.
2. `permission_resources_sql` — emits SQL that grants `view`/`edit` to owners,
   share-row recipients, and (when the actor passes `list`) link-visibility
   readers.
3. `register_routes` — handlers call `ensure_paper_*` helpers that wrap
   `datasette.ensure_permission(...)`.

The two non-hook calls are `datasette.allowed(...)` (ad-hoc checks: SSE raw
ASGI, capability flags in the bootstrap envelope, runtime revocation
sweep) and `datasette.allowed_resources(...)` (listing papers the actor can
view).

---

## 1. Declaring the actions

`datasette_paper/__init__.py:159`:

```python
from datasette.permissions import Action

@hookimpl
def register_actions(datasette):
    return [
        Action(
            name="datasette-paper-list",
            description="Can list papers (see the index page + list endpoint)",
        ),
        Action(
            name="datasette-paper-create",
            description="Can create new papers",
            also_requires="datasette-paper-list",
        ),
        Action(
            name="datasette-paper-view",
            description="Can view a specific paper",
            resource_class=PaperResource,
        ),
        Action(
            name="datasette-paper-edit",
            description="Can edit a specific paper",
            resource_class=PaperResource,
            also_requires="datasette-paper-view",
        ),
    ]
```

Things to know:

- `also_requires=` is honored automatically by `datasette.ensure_permission`
  and `datasette.allowed`. We don't need to chain manually in route handlers.
- `resource_class=PaperResource` tells Datasette this action is per-resource.
  Calls without a `resource=` argument will fall back to global rules
  (config-only); calls with a `resource=` argument will additionally consult
  `permission_resources_sql` rules.
- Actions can still be granted statically through the standard
  `permissions:` config block — see `datasette_paper/permissions.py:108`,
  where the visibility-grant branch checks `datasette.allowed(action="datasette-paper-list", actor=actor)`.

---

## 2. The `Resource` subclass

`datasette_paper/permissions.py:42`:

```python
from datasette.permissions import Resource

class PaperResource(Resource):
    """A single paper. Single-level resource: doc_id lives in `parent`."""

    name = "paper"
    parent_class = None

    def __init__(self, doc_id):
        super().__init__(parent=str(doc_id), child=None)

    @classmethod
    async def resources_sql(cls, datasette, actor=None) -> str:
        return (
            "SELECT CAST(id AS TEXT) AS parent, NULL AS child "
            "FROM _datasette_paper_doc"
        )
```

Two things that aren't obvious from the Datasette docs:

1. **Single-level resources go in `parent`, not `child`.** Datasette's
   resource hierarchy is two levels (`parent` + `child`), e.g. for a
   table inside a database. A single-level resource (like a paper, or
   `DatabaseResource`) puts its id in `parent` and leaves `child=None`.
   Putting the id in `child` breaks the SQL join in
   `permission_resources_sql` because SQLite's `NULL = NULL` is `NULL`
   (not true), so the rule never matches.
2. **`resources_sql` is the enumeration query.** Used by
   `datasette.allowed_resources(...)` to list all candidate resources.
   Must return columns named `parent` and `child` — no `allow` column,
   no rules — just the universe of resources the action can apply to.
   For `PaperResource`, that's every row in `_datasette_paper_doc`.

The string id wrapping (`str(doc_id)` in `__init__`, `CAST(id AS TEXT)`
in the SQL) is deliberate: Datasette's permission lookup compares
`parent` as text, so all sides of the join need to be text.

---

## 3. The `permission_resources_sql` hook

This is the core of per-resource gating. The hook is called by
Datasette's permission machinery whenever a resource-scoped check runs;
its return value is a list of `PermissionSQL` rules whose `SELECT` rows
become per-resource allow/deny decisions.

`datasette_paper/permissions.py:67`:

```python
from datasette import hookimpl
from datasette.permissions import PermissionSQL

@hookimpl
async def permission_resources_sql(datasette, actor, action):
    if action not in ("datasette-paper-view", "datasette-paper-edit"):
        return None  # let other plugins / config handle non-paper actions

    actor_id = actor.get("id") if actor else None
    role_filter = "" if action == "datasette-paper-view" else "AND s.role = 'editor'"

    rules = [
        # Owner row — anonymous actors never own (NULL guard).
        PermissionSQL(
            sql=(
                "SELECT CAST(id AS TEXT) AS parent, NULL AS child, "
                "1 AS allow, 'owner' AS reason "
                "FROM _datasette_paper_doc "
                "WHERE :_paper_aid IS NOT NULL AND created_by = :_paper_aid"
            ),
            params={"_paper_aid": actor_id},
        ),
        # Explicit per-actor shares.
        PermissionSQL(
            sql=(
                "SELECT CAST(s.doc_id AS TEXT) AS parent, NULL AS child, "
                "1 AS allow, 'shared' AS reason "
                "FROM _datasette_paper_share s "
                f"WHERE :_paper_aid IS NOT NULL AND s.actor_id = :_paper_aid {role_filter}"
            ),
            params={"_paper_aid": actor_id},
        ),
    ]

    if await datasette.allowed(action="datasette-paper-list", actor=actor):
        if action == "datasette-paper-view":
            visibilities = "('link-view','link-edit')"
        else:
            visibilities = "('link-edit')"
        rules.append(
            PermissionSQL(
                sql=(
                    "SELECT CAST(id AS TEXT) AS parent, NULL AS child, "
                    "1 AS allow, 'visibility' AS reason "
                    f"FROM _datasette_paper_doc WHERE visibility IN {visibilities}"
                ),
            )
        )

    return rules
```

Output contract for each `PermissionSQL.sql`:

| Column | Meaning |
|---|---|
| `parent` | resource parent id (TEXT) |
| `child` | resource child id (TEXT or NULL) |
| `allow` | `1` for grant, `0` for deny |
| `reason` | optional, for tracing — surfaced in Datasette's permission inspector |

Key patterns to copy:

- **Return `None`** for actions you don't own. Datasette merges results from
  every plugin's hook implementation, so returning a list for an unrelated
  action would inject spurious rules into other plugins' decisions.
- **Anonymous-actor NULL guard.** Without `:_paper_aid IS NOT NULL`, an
  anonymous actor (`actor=None` → `actor_id=None`) would match rows whose
  `created_by` is `NULL` because of SQLite's three-valued logic — `NULL =
  NULL` evaluates to `NULL` (falsy), but `created_by = :_paper_aid` with both
  bound to `NULL` becomes `NULL = NULL` and triggers the same trap if you
  ever switch dialects or short-circuit the check. Make the guard explicit.
- **Read other actions inside the hook.** The visibility branch calls
  `datasette.allowed(action="datasette-paper-list", actor=actor)` so that
  publishing a paper as `link-view` doesn't override an admin keeping papers
  off the list page. This composition (action-gates-action) is fine; just
  remember the hook is `async`.
- **Role-based filtering.** The share table has a `role` column (`viewer`
  or `editor`). For `view` we accept any role; for `edit` we add
  `AND s.role = 'editor'`. Two rules over the same table is also valid;
  either approach works.
- **`PermissionSQL.params=`** uses dict-bind syntax (`:name`). It's the
  same dict for every emit of that rule.

Datasette caches resource-rule lookups within a request; no need to
optimize the SQL beyond reasonable indexes on `created_by`, `actor_id`,
and `visibility`.

---

## 4. Calling the API from route handlers

Three functions cover the day-to-day cases:

| Call | Use when |
|---|---|
| `await datasette.ensure_permission(action, resource=, actor=)` | Gate a route. Raises `Forbidden` (mapped to 403). |
| `await datasette.allowed(action, resource=, actor=)` | Bool check. Use for capability flags in response bodies, raw-ASGI handlers, runtime sweeps. |
| `await datasette.allowed_resources(action, actor=, limit=)` | Enumerate every resource the actor can act on. Page object has `.resources` (`Resource` instances). |

### Helpers (`datasette_paper/permissions.py:131`)

```python
async def ensure_paper_list(datasette, request) -> None:
    await datasette.ensure_permission(
        action="datasette-paper-list", actor=request.actor
    )

async def ensure_paper_create(datasette, request) -> None:
    await datasette.ensure_permission(
        action="datasette-paper-create", actor=request.actor
    )

async def ensure_paper_view(datasette, request, doc_id) -> None:
    await datasette.ensure_permission(
        action="datasette-paper-view",
        resource=PaperResource(doc_id),
        actor=request.actor,
    )

async def ensure_paper_edit(datasette, request, doc_id) -> None:
    await datasette.ensure_permission(
        action="datasette-paper-edit",
        resource=PaperResource(doc_id),
        actor=request.actor,
    )

async def can_paper_view(datasette, actor, doc_id) -> bool:
    return await datasette.allowed(
        action="datasette-paper-view",
        resource=PaperResource(doc_id),
        actor=actor,
    )
```

Every route handler calls the matching helper as its first awaited line.
Examples:

`datasette_paper/routes/docs.py:55` (create):
```python
@router.POST(r"^/-/paper/api/docs$")
async def create_doc(datasette, request):
    await ensure_paper_create(datasette, request)
    ...
```

`datasette_paper/routes/docs.py:212` (rename — edit gates view via `also_requires`):
```python
@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/rename$")
async def rename_doc(datasette, request, doc_id: int):
    await ensure_paper_edit(datasette, request, doc_id)
    ...
```

### Listing — `allowed_resources`

`datasette_paper/routes/docs.py:25`:

```python
@router.GET(r"^/-/paper/api/docs$")
async def list_docs(datasette, request):
    await ensure_paper_list(datasette, request)
    page = await datasette.allowed_resources(
        action="datasette-paper-view", actor=request.actor, limit=1000,
    )
    doc_ids = [int(r.parent) for r in page.resources]
    ...
```

`allowed_resources` returns a page object; `.resources` is a list of
`Resource` instances (in our case `PaperResource`-shaped — `parent` is the
doc id, `child` is None). The `limit` argument caps the page size; if
you need full pagination, the page object has a continuation cursor.

### Capability flags in response bodies

The bootstrap envelope embeds `canEdit` so the frontend can render a
read-only UI without round-tripping. `datasette_paper/routes/docs.py:91`:

```python
is_owner = doc.created_by is not None and doc.created_by == me
can_edit = await datasette.allowed(
    action="datasette-paper-edit",
    resource=PaperResource(doc_id),
    actor=request.actor,
)
return Response.json({
    ...
    "permissions": {
        "canView": True,
        "canEdit": can_edit,
        "canManage": is_owner,
        "isOwner": is_owner,
        "visibility": doc.visibility,
    },
})
```

`canManage` is **not** a permission action — it's an inline owner check.
Stay consistent: anything that needs to flip global state for the doc
(visibility, share rows) is owner-only and not in the actions list.

### Raw ASGI handlers

Streaming handlers (SSE) can't use `ensure_permission` because the
`Forbidden` exception fires after the streaming response has started.
Use the bool form and write a 403 manually.

`datasette_paper/routes/events.py:42`:

```python
async def sse_events(datasette, request, send, receive):
    ...
    if not await can_paper_view(datasette, request.actor, doc_id):
        await _send_status(send, 403, b"Permission denied")
        return
    ...
```

### Owner-only mutations (manage)

`datasette_paper/routes/docs.py:266`:

```python
@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/share$")
async def post_share(datasette, request, doc_id: int):
    await ensure_paper_edit(datasette, request, doc_id)  # 403 for non-editors
    ...
    me = actor_id(request)
    if doc.created_by is None or doc.created_by != me:
        raise Forbidden("datasette-paper-manage")  # owner-only beyond edit
    ...
```

Note we still pass `ensure_paper_edit` first so that non-editors fail with
the same 403 surface as every other write endpoint, then escalate to the
owner check. The `Forbidden` reason string is freeform — it shows up in
debug output but isn't a registered action.

---

## 5. Runtime revocation

When an owner shrinks access (flips visibility to `private`, removes a
share row), already-connected SSE subscribers need to be kicked. The
plugin re-runs `datasette.allowed(...)` per subscriber and signals the
SSE loop to exit.

`datasette_paper/instance.py:299`:

```python
async def revoke_unauthorized(self, datasette) -> int:
    from .permissions import PaperResource

    revoked = 0
    resource = PaperResource(self.doc_id)
    for q, (_client_id, actor_id) in list(self.subscribers.items()):
        actor = {"id": actor_id} if actor_id else None
        allowed = await datasette.allowed(
            action="datasette-paper-view", resource=resource, actor=actor
        )
        if not allowed:
            q.put_nowait({"kind": "closed"})  # SSE loop sentinel
            self.subscribers.pop(q, None)
            revoked += 1
    return revoked
```

Triggered from the share endpoint immediately after the DB write
commits (`datasette_paper/routes/docs.py:333`). The subscriber tuple is
`(client_id, actor_id)` — recording the actor at subscribe time is what
makes this sweep possible. Keying just by `client_id` would lose the
context.

---

## 6. Configuration

Two grant surfaces:

### Static config (`-s permissions.<name> <value>` or `permissions:` block)

Used for the global actions:

```bash
datasette --internal papers.db \
    -s permissions.datasette-paper-list true \
    -s permissions.datasette-paper-create true
```

Or `datasette.yaml`:

```yaml
permissions:
  datasette-paper-list: true
  datasette-paper-create: true
```

The value can be `true` (everyone), an actor-id object (`{"id": "alice"}`
— only that actor), or any of Datasette's standard permission expressions.

**Don't** statically grant `datasette-paper-view` or `datasette-paper-edit`
in production — those are designed to be resolved per-paper through the
SQL hook. Granting them globally bypasses the share model and lets every
authenticated actor read and write every paper.

### Per-paper config (the data tables)

| Table | Column | What it controls |
|---|---|---|
| `_datasette_paper_doc` | `created_by` (TEXT, nullable) | owner — full access (view + edit + manage) |
| `_datasette_paper_doc` | `visibility` (`private`\|`link-view`\|`link-edit`) | grants to actors with `datasette-paper-list` |
| `_datasette_paper_share` | `(doc_id, actor_id, role)` with `role IN ('viewer','editor')` | explicit per-actor grants |

`datasette_paper/migrations.py:34` is the canonical schema. Note the CHECK
constraints on `visibility` and `role` — keep these in lock-step with
the SQL hook (the hook hardcodes the visibility and role string set).

---

## 7. Testing

`tests/test_permissions.py` is the spec. The patterns worth lifting:

```python
# Build a Datasette with specific grants. Empty config = anonymous-only.
ds = Datasette(memory=True, config={"permissions": {"datasette-paper-list": True}})
await ds.invoke_startup()

# Sign an actor cookie for the test client.
cookie = ds.sign({"a": {"id": "alice"}}, "actor")
resp = await ds.client.get("/-/paper/api/docs", cookies={"ds_actor": cookie})

# Direct check against allowed() — useful for asserting hook output
# without going through HTTP.
from datasette_paper.permissions import PaperResource
assert await ds.allowed(
    action="datasette-paper-view", resource=PaperResource(doc_id), actor={"id": "alice"}
)
```

Coverage to mirror in a sibling plugin:

- Anonymous denied on every public route (`test_anonymous_denied_*`).
- `also_requires` chain enforcement (`test_create_requires_create_permission`,
  `test_also_requires_chain_blocks_edit_when_view_denied`).
- Owner positive path (`test_owner_can_view_and_edit_own_paper`).
- Stranger denied on a private resource (`test_stranger_denied_on_private_paper`).
- Each share role grants the right subset (`test_shared_viewer_can_view_not_edit`,
  `test_shared_editor_can_view_and_edit`).
- Each visibility level grants what it claims, gated on the global list
  permission (`test_visibility_link_*`).
- Anonymous-creator edge case — a row with `created_by IS NULL` must not
  match an `actor=None` request (`test_anonymous_never_owns_even_with_null_created_by`).

---

## 8. Gotchas to copy verbatim

1. **`Resource` parent vs child.** Single-level → id in `parent`, `child=None`.
2. **NULL guard on actor id.** `:_aid IS NOT NULL AND created_by = :_aid` —
   never trust SQLite's `NULL = NULL`.
3. **Don't statically grant per-resource actions.** They're meant to flow
   through the SQL hook; static grants short-circuit the share/visibility
   logic.
4. **Hook returns `None` for actions it doesn't own.** Returning a list
   short-circuits other plugins' contributions.
5. **`also_requires` is honored automatically.** Don't manually re-check the
   parent action.
6. **Manage is not an action.** It's an owner-only inline check
   (`doc.created_by == actor_id`). Putting it in the action list would
   force every reader of the action enum to special-case it.
7. **Capture actor at subscribe time** if you have long-lived connections
   that may need revocation. Keying by client/connection id alone loses
   the actor context.
8. **Raw ASGI handlers use the bool form** (`datasette.allowed`) plus a
   manual 403 — `ensure_permission` raises after headers are sent.
