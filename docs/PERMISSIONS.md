# datasette-paper permissions

A reference for how datasette-paper does per-document access control. The intent
is that a sibling plugin (one that wants per-resource sharing on top of some
other domain object — places lists, sheets workbooks, …) can read this doc and
reproduce the model.

## The big picture

Per-document access is **owned by [datasette-acl](https://github.com/datasette/datasette-acl)**.
Paper declares a resource type and a set of roles; acl stores the grants and
answers the permission checks. Paper ships almost no permission SQL of its own —
the one exception is the read-only `locked` flag (see §5).

Three plugins collaborate:

| Plugin | Role |
|---|---|
| **datasette-acl** | stores grants, resolves `paper-view`/`-edit`/`-manage` against them, exposes the JSON API the share dialog drives |
| **datasette-acl-share** | the reusable `<datasette-acl-share-dialog>` web component — paper embeds it on the doc page; it grants/updates/revokes acl grants directly |
| **datasette-user-profiles** | (transitively, via the dialog) people search + avatars |

Paper itself only: declares the actions + roles + resource class, seeds an owner
grant on create, emits the `locked` deny, and runs an SSE revocation sweep when
the dialog mutates a grant.

## TL;DR — the four actions

| Action | Scope | Resolved by |
|---|---|---|
| `datasette-paper-create` | global | standard config-permissions (`permissions:` block) |
| `paper-view` | per-doc (`PaperDocResource`) | datasette-acl grants |
| `paper-edit` | per-doc (`PaperDocResource`) | datasette-acl grants; `also_requires=paper-view`; **plus** paper's `locked` deny |
| `paper-manage` | per-doc (`PaperDocResource`) | datasette-acl grants (the Manager role); `also_requires=paper-view` |

**Listing is not gated.** The index, list, search and template-param endpoints
are reachable by anyone and return only the docs acl says the actor can view
(`allowed_resources("paper-view")`), so a coarse `datasette-paper-list`
permission would be redundant — there is no such action.

`paper-manage` **is** a real action now (it was an inline owner check in the
pre-acl model). It is the Manager-only capability — managing sharing, locking,
archiving, templating. The document owner gets it via a Manager grant seeded at
create time (§4).

---

## 1. Declaring the actions

`datasette_paper/__init__.py` → `register_actions`:

```python
from datasette.permissions import Action

from .permissions import PAPER_VIEW, PAPER_EDIT, PAPER_MANAGE

@hookimpl
def register_actions(datasette):
    return [
        # Global — config-driven. (Listing is ungated; there is no list action.)
        Action(name="datasette-paper-create", description="Can create new papers"),
        # Per-doc — acl-backed.
        Action(name=PAPER_VIEW,   description="View a paper doc",
               resource_class=PaperDocResource),
        Action(name=PAPER_EDIT,   description="Edit a paper doc",
               resource_class=PaperDocResource, also_requires=PAPER_VIEW),
        Action(name=PAPER_MANAGE, description="Manage sharing for a paper doc",
               resource_class=PaperDocResource, also_requires=PAPER_VIEW),
    ]
```

(`PAPER_VIEW` / `PAPER_EDIT` / `PAPER_MANAGE` are the action-name constants
exported by `permissions.py` — import them rather than re-typing the strings.)

Things to know:

- `also_requires=` is honoured automatically by `datasette.ensure_permission`
  and `datasette.allowed` — no manual chaining in route handlers.
- `resource_class=PaperDocResource` marks the action per-resource. A check with a
  `resource=` argument consults datasette-acl's grants (and paper's
  `permission_resources_sql`); without one it falls back to global config rules.
- The **global** `datasette-paper-create` action stays config-driven (the
  `permissions:` block); the three **per-doc** actions are answered by acl
  grants, not by paper SQL.

---

## 2. The roles

datasette-acl resolves an action check by matching the actor's granted actions
against the **roles** a plugin registers for its resource type. Paper registers
the canonical cumulative triple via the `datasette_acl_roles` hook
(`datasette_paper/__init__.py`), using acl's `standard_roles()` factory rather
than hand-building each `AclRole`:

```python
from datasette_acl.roles import standard_roles

@hookimpl
def datasette_acl_roles(datasette):
    return standard_roles(
        "paper-doc",
        view=PAPER_VIEW, edit=PAPER_EDIT, manage=PAPER_MANAGE,
    )
```

`standard_roles()` returns Viewer (rank 1, `paper-view`), Editor (rank 2,
`paper-view`+`paper-edit`) and Manager (rank 3, `manage=True`, all three) — the
same cumulative bundles paper used to spell out by hand.

- `rank` orders the roles (used by the share dialog's role dropdown).
- `manage=True` flags Manager as the role that may *change* sharing — acl uses it
  to decide `can_manage` in its JSON API, which drives the dialog's read-only vs
  editable rendering.

The share dialog grants/revokes **roles** (Viewer/Editor/Manager) or, for
General access, a public-audience principal (`authenticated` / `everyone`).
Paper never writes these — datasette-acl-share does, against acl's JSON API.

---

## 3. The `Resource` subclass

Per-doc actions resolve against `PaperDocResource` (`datasette_paper/permissions.py`):

```python
from datasette.permissions import Resource

PAPER_DOC_RESOURCE_TYPE = "paper-doc"
PAPER_DOCS_PARENT = "_paper"   # fixed sentinel — all docs share one parent

class PaperDocsParent(Resource):
    name = "paper-docs-parent"
    parent_class = None

    @classmethod
    async def resources_sql(cls, datasette, actor=None) -> str:
        return f"SELECT '{PAPER_DOCS_PARENT}' AS parent, NULL AS child"

class PaperDocResource(Resource):
    """A single paper doc. Two-level: parent = sentinel, child = doc id."""
    name = PAPER_DOC_RESOURCE_TYPE
    parent_class = PaperDocsParent

    def __init__(self, parent=None, child=None):
        # Common path: PaperDocResource(doc_id) — the lone positional is the
        # doc id, parent falls back to the sentinel. Two-arg form
        # PaperDocResource(parent, child) is what acl.build_resource uses.
        if child is None and parent is not None:
            parent, child = PAPER_DOCS_PARENT, parent
        elif parent is None:
            parent = PAPER_DOCS_PARENT
        super().__init__(parent=str(parent),
                         child=str(child) if child is not None else None)

    @classmethod
    async def resources_sql(cls, datasette, actor=None) -> str:
        return (f"SELECT '{PAPER_DOCS_PARENT}' AS parent, "
                "CAST(id AS TEXT) AS child FROM _datasette_paper_doc")
```

Why **two levels** when every paper lives in one internal database?

- datasette-acl models resources as `(resource_type, parent, child)`. A real
  parent row lets a *general-access* grant target "all paper docs" via the
  parent if ever wanted, and keeps paper consistent with table-style two-level
  resources.
- The parent is a fixed sentinel string (`_paper`), **not** a database name. The
  doc id is the `child`. This is the inverse of the old single-level model,
  where the doc id lived in `parent` with `child=None`.
- `resources_sql` is the enumeration query used by
  `datasette.allowed_resources(...)`: columns `parent` + `child`, no `allow`, no
  rules — just the universe of docs the action can apply to.

The string wrapping (`str(...)`, `CAST(id AS TEXT)`) is deliberate: acl compares
the child as text, so both sides of the join must be text.

---

## 4. Seeding the owner grant

There is no "owner" permission rule. Ownership is an acl **Manager grant** seeded
when a doc is created (`datasette_paper/permissions.py`):

```python
async def seed_owner_manager_grant(datasette, doc_id, created_by) -> None:
    if not created_by:        # anonymous never owns
        return
    await _acl_grant(
        datasette, PAPER_DOC_RESOURCE_TYPE, PAPER_DOCS_PARENT, str(doc_id),
        principal=Principal.actor(str(created_by)),
        role="Manager", by_actor=str(created_by),
    )
```

The create route calls it right after the insert (`routes/docs.py`):

```python
doc = await db.insert_doc(..., created_by=actor_id(request))
# Owner gets the Manager role so they can view, edit, and manage sharing.
await seed_owner_manager_grant(datasette, doc.id, doc.created_by)
```

No-op for **anonymous** creates (`created_by` falsy) — an anonymous owner is not
representable as a grant. Such docs have *no* grants and are reachable only if a
deployment grants `paper-view`/`-edit` globally (see §8) or a later signed-in
actor is granted access.

> **`isOwner` ≠ `paper-manage`.** `isOwner` is still a plain
> `doc.created_by == actor_id` comparison, surfaced in response bodies for "by
> you" UI labels. `paper-manage` is the acl check. They usually coincide (the
> owner holds Manager) but are computed independently — don't gate writes on
> `isOwner`; gate on the action.

---

## 5. The one bespoke rule: `permission_resources_sql` and `locked`

Paper keeps exactly one piece of permission SQL — the read-only `locked` flag,
which has no acl equivalent (`datasette_paper/permissions.py`):

```python
@hookimpl
async def permission_resources_sql(datasette, actor, action):
    if action != "paper-edit":
        return None     # acl + config answer everything else

    # For every locked doc, emit a child-level DENY of paper-edit.
    return [PermissionSQL(sql=(
        f"SELECT '{PAPER_DOCS_PARENT}' AS parent, "
        "CAST(id AS TEXT) AS child, 0 AS allow, 'locked' AS reason "
        "FROM _datasette_paper_doc WHERE locked = 1"
    ))]
```

How it composes:

- acl grants land at the **child** depth (a specific doc). This deny is also at
  the child depth. **Deny beats allow at the same depth** in core's rule
  resolver, so a lock wins over *any* grant — owner, editor, or general access.
- Only `paper-edit` is touched. `paper-view` is untouched (locked docs are still
  readable) and so is `paper-manage`, which is why the owner can still unlock.
- The unlock route gates on **view + `paper-manage`**, never on edit — gating
  unlock on edit would trap the owner of their own locked doc (the lock denies
  *them* edit too). See `_ensure_owner` in §7.

Return `None` for any action you don't own: Datasette merges
`permission_resources_sql` across all plugins, so returning a list for an
unrelated action injects spurious rules into other plugins' decisions.

---

## 6. Calling the API from route handlers

| Call | Use when |
|---|---|
| `await datasette.ensure_permission(action, resource=, actor=)` | Gate a route. Raises `Forbidden` → 403. |
| `await datasette.allowed(action, resource=, actor=)` | Bool check. Capability flags in response bodies, raw-ASGI handlers, runtime sweeps. |
| `await datasette.allowed_resources(action, actor=, limit=)` | Enumerate every doc the actor can act on (the index listing). |

Helpers (`datasette_paper/permissions.py`) wrap these so handlers read cleanly:

```python
async def ensure_paper_view(datasette, request, doc_id):
    await datasette.ensure_permission(
        action="paper-view", resource=PaperDocResource(doc_id), actor=request.actor)

async def ensure_paper_edit(datasette, request, doc_id):
    await datasette.ensure_permission(
        action="paper-edit", resource=PaperDocResource(doc_id), actor=request.actor)

async def can_paper_view(datasette, actor, doc_id) -> bool:    # bool form
    return await datasette.allowed(
        action="paper-view", resource=PaperDocResource(doc_id), actor=actor)

async def can_paper_edit(datasette, actor, doc_id) -> bool: ...   # agent tools
async def can_paper_manage(datasette, actor, doc_id) -> bool:     # share/owner ops
    return await datasette.allowed(
        action="paper-manage", resource=PaperDocResource(doc_id), actor=actor)
```

Every route handler calls the matching helper as its first awaited line:

```python
@router.POST(r"^/-/paper/api/docs$")                 # create
async def create_doc(datasette, request):
    await ensure_paper_create(datasette, request)
    ...

@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/rename$")   # edit (→ view via also_requires)
async def rename_doc(datasette, request, doc_id: int):
    await ensure_paper_edit(datasette, request, doc_id)
    ...
```

### Listing — `allowed_resources`

```python
@router.GET(r"^/-/paper/api/docs$")
async def list_docs(datasette, request):
    # No global gate — results are acl-filtered, so a no-grant actor gets [].
    page = await datasette.allowed_resources(
        action=PAPER_VIEW, actor=request.actor, limit=1000)
    doc_ids = [int(r.child) for r in page.resources]   # NOTE: child, not parent
    ...
```

`.resources` is a list of `PaperDocResource`-shaped instances — the doc id is now
in `.child` (the parent is the sentinel). `limit` caps the page; the page object
carries a continuation cursor for full pagination.

### Capability flags in the bootstrap envelope

The open-doc envelope embeds capabilities so the frontend renders read-only UI
without extra round-trips (`routes/docs.py`):

```python
is_owner   = doc.created_by is not None and doc.created_by == me
can_edit   = await datasette.allowed(action="paper-edit",
                                     resource=PaperDocResource(doc_id), actor=request.actor)
can_manage = await can_paper_manage(datasette, request.actor, doc_id)
return Response.json({
    ...,
    "permissions": {
        "canView":   True,
        "canEdit":   can_edit,
        "canManage": can_manage,      # acl Manager check — gates nothing on its own,
                                       # the share dialog re-derives its own can_manage
        "isOwner":   is_owner,        # inline created_by equality (UI label only)
        "locked":    bool(doc.locked),
    },
})
```

### Raw ASGI handlers

Streaming handlers (SSE) can't use `ensure_permission` (the `Forbidden` would
fire after the response has started). Use the bool form and write a 403 manually
(`routes/events.py`):

```python
async def sse_events(datasette, request, send, receive):
    if not await can_paper_view(datasette, request.actor, doc_id):
        await _send_status(send, 403, b"Permission denied")
        return
    ...
```

---

## 7. Manage-only (owner) operations

Archive / trash / restore / lock / unlock / make_template all funnel through one
gate (`routes/docs.py`):

```python
async def _ensure_owner(datasette, request, doc_id: int):
    # View first (standardises the 403 surface + hides existence), then manage.
    await ensure_paper_view(datasette, request, doc_id)
    if not await can_paper_manage(datasette, request.actor, doc_id):
        raise Forbidden("paper-manage")
    doc = await paper_db(datasette).select_doc_by_id(doc_id)
    return doc        # None → caller 404s
```

The gate is **view, not edit**, on purpose: a locked doc denies edit to everyone
including the owner, so gating manage on edit would make a locked paper
un-unlockable. `paper-manage` (the owner's seeded Manager grant) is what actually
enforces ownership; the view pre-check just standardises the 403 and stops
doc-id probing from disclosing existence.

`Forbidden("paper-manage")`'s string is freeform — it shows in debug output;
the registered action is what's actually checked.

---

## 8. Configuration

### Static config — the one global action

```bash
datasette --internal papers.db \
    -s permissions.datasette-paper-create true
```

or in `datasette.yaml`:

```yaml
permissions:
  datasette-paper-create: true
```

The value can be `true` (everyone), an actor-id object (`{"id": "alice"}`), or
any standard Datasette permission expression. Listing is ungated, so it needs no
config.

**Per-doc access comes from acl grants, not config.** Owner access is the seeded
Manager grant (§4); everything else is granted through the share dialog. Do
**not** statically grant `paper-view` / `paper-edit` / `paper-manage` in
production — it bypasses the share model and lets every actor read/write/manage
every doc.

> The **e2e** suite is the deliberate exception: it runs anonymously with no
> seeded grants, so `frontend/playwright.config.ts` grants `paper-view` +
> `paper-edit` globally (but **not** `paper-manage`, so the share dialog stays
> read-only). That's a test convenience, not a production pattern.

### Per-doc grants — owned by datasette-acl

Grants live in acl's internal tables (`acl`, `acl_resources`, `acl_actions`,
`acl_groups`, `acl_audit`), keyed on `(resource_type="paper-doc", parent="_paper",
child=<doc id>)`. Paper does not read or write them directly — it calls
`datasette_acl.grants.grant(...)` (seeding) and `datasette.allowed(...)`
(checks); the share dialog calls acl's JSON API for everything else.

Paper's own `_datasette_paper_doc` table keeps only `created_by` (TEXT, nullable
— the owner identity, used to seed the grant and for `isOwner`) and `locked`
(the read-only flag). The legacy `visibility` column and `_datasette_paper_share`
table were **dropped** (migration `m004`) once their data was backfilled into acl
(§10).

---

## 9. Runtime revocation

When a grant shrinks mid-session (a Manager removes someone, or downgrades an
Editor to Viewer, in the dialog), already-connected SSE subscribers must be
re-checked. The dialog mutates acl directly and **can't** reach into paper's
in-memory `Instance`, so it fires a bubbling `share-changed` CustomEvent; paper's
`DocHeader` listens and POSTs to a sweep endpoint:

```python
@router.POST(r"^/-/paper/api/docs/(?P<doc_id>\d+)/sweep-subscribers$")
async def sweep_subscribers(datasette, request, doc_id: int):
    await ensure_paper_view(datasette, request, doc_id)          # standard 403 surface
    if not await can_paper_manage(datasette, request.actor, doc_id):
        raise Forbidden("paper-manage")                          # Manager-only
    instance = get_registry(datasette)._instances.get(doc_id)
    revoked = await instance.revoke_unauthorized(datasette) if instance else 0
    return Response.json({"revoked": revoked})
```

`Instance.revoke_unauthorized` (`instance.py`) re-runs `paper-view` per
subscriber and drops the ones that now fail:

```python
async def revoke_unauthorized(self, datasette) -> int:
    resource = PaperDocResource(self.doc_id)
    revoked = 0
    for q, (_client_id, actor_id) in list(self.subscribers.items()):
        actor = {"id": actor_id} if actor_id else None
        if not await datasette.allowed(action="paper-view", resource=resource, actor=actor):
            q.put_nowait({"kind": "closed"})        # SSE-loop sentinel → clean exit
            self.subscribers.pop(q, None)
            revoked += 1
    return revoked
```

Recording the actor at subscribe time — the subscriber value is
`(client_id, actor_id)` — is what makes this sweep possible; keying by
`client_id` alone would lose the actor context.

**Lock** is the related-but-distinct case: it changes only the *edit* grant, so
instead of disconnecting anyone, `Instance.broadcast_permissions_changed`
re-checks `paper-edit` per subscriber and pushes a `permissions-changed`
event — the editor flips to read-only with no reconnect.

---

## 10. The one-time data migration

Migrating an existing deployment from the old (owner/share/visibility) model is a
one-shot backfill into acl grants (`datasette_paper/migrations.py`, the
`shares_to_acl_grants` step — distinct from the append-only schema migrations):

| Legacy source | Becomes |
|---|---|
| `_datasette_paper_doc.created_by` | a **Manager** grant for that actor |
| `_datasette_paper_share (actor_id, role='viewer'/'editor')` | a **Viewer** / **Editor** grant |
| `_datasette_paper_doc.visibility = 'link-view'/'link-edit'` | a **Viewer**/**Editor** grant for the general-access audience — a `Principal.public(...)` named in acl's own vocabulary (`authenticated` by default; set `share-general-principal` to `everyone`/`anonymous` to widen it) |

It is **idempotent** (a marker table short-circuits repeat runs; acl's `grant`
only inserts actions a principal doesn't already hold) and **closed by default**:
anonymous-owned (`created_by` NULL) and `private` docs gain nothing — paper never
auto-opens a doc on upgrade. It bails gracefully once the legacy column/table
have been dropped.

---

## 11. Testing

The backend specs are the source of truth:

- `tests/test_permissions.py` — action wiring, ungated listing, the `locked`
  deny, owner/manager paths.
- `tests/test_paper_doc_resource.py` — the two-level `PaperDocResource` shape +
  `resources_sql`.
- `tests/test_share.py` — grant-backed view/edit/manage via the helpers.
- `tests/test_data_migration.py` — the one-time backfill.
- `tests/test_lock.py` — the lock deny + per-subscriber `permissions-changed`.

Pattern: build a `Datasette` with `datasette-paper-create` granted in config,
sign an actor cookie, then either drive HTTP or assert `datasette.allowed(...)`
directly:

```python
ds = Datasette(memory=True, config={"permissions": {"datasette-paper-create": True}})
await ds.invoke_startup()

from datasette_paper.permissions import PaperDocResource, seed_owner_manager_grant
await seed_owner_manager_grant(ds, doc_id, "alice")   # owner → Manager grant
assert await ds.allowed(action="paper-edit",
                        resource=PaperDocResource(doc_id), actor={"id": "alice"})
```

Per-doc access is set up by **seeding acl grants**, not by static config — that's
what exercises the real share path.

---

## 12. Gotchas to copy verbatim

1. **Doc id is the `child`.** `PaperDocResource` is two-level: parent = fixed
   sentinel `_paper`, child = doc id. (The pre-acl model put the id in `parent`;
   listing code that reads `r.parent` is stale — use `r.child`.)
2. **Manage is an action now.** `paper-manage` (the Manager role), not an inline
   `created_by` check. `isOwner` is a *separate*, UI-only signal — never gate a
   write on it.
3. **The owner grant is seeded, not implied.** Anonymous creates seed nothing, so
   an anonymous-owned doc has no grants at all.
4. **`locked` is the only paper-owned permission SQL.** A child-level deny of
   `paper-edit`; deny-beats-allow at equal depth makes it win over every grant.
   Gate unlock on **view + manage**, never edit, or you trap the owner.
5. **`permission_resources_sql` returns `None` for actions it doesn't own.**
   Returning a list short-circuits other plugins' contributions.
6. **`also_requires` is automatic.** Don't re-check the parent action by hand.
7. **Don't statically grant the per-doc actions in production.** They flow
   through acl grants; static grants mask the share model. (The e2e config is the
   sanctioned exception.)
8. **Capture the actor at subscribe time** for long-lived connections that may
   need revocation — keying by connection id alone loses the actor.
9. **Raw ASGI handlers use the bool form** (`datasette.allowed`) + a manual 403 —
   `ensure_permission` raises after headers are sent.
10. **acl + acl-share are hard dependencies.** They're declared in
    `dependencies` and imported unconditionally — no `try/except ImportError`
    guards, no `None` fallbacks. (datasette-agent stays optional: its tools hook
    self-registers only when installed.)

## 13. SQL in documents (SQL blocks & inline values) — Datasette's gate, not paper's

The `sql_block` node and the inline-value feature (`source` nodes +
`${{source.column}}` `value` atoms) run SQL against named Datasette databases.
**Paper does not gate or execute these queries.** Each is fetched **client-side,
per viewer**, from Datasette's native `/{db}/-/query.json` API with that viewer's
own cookie — so Datasette enforces *their* `execute-sql` permission on that
database (`frontend/src/lib/sqlQuery.ts`). Consequences:

- A viewer without `execute-sql` on the referenced database sees a leak-free
  "no access" state (a `denied` chip / placeholder), never rows or column names.
- Different readers of the same doc may therefore see a value, an error, or "no
  access" depending on their own database permissions — the rendered value is
  **not** part of the doc's shared state. Only the *reference* (db name, SQL,
  `source`/`column`) collaborates and round-trips; results are ephemeral and
  re-fetched on every mount.
- This deliberately sidesteps paper's per-doc ACL model: editing a doc
  (`paper-edit`) lets you *author* a query, but running it still requires the
  viewer's own Datasette `execute-sql`.
