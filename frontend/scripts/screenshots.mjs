// Programmatic doc screenshots of the paper app → docs/screenshots/*.png.
//
// Unlike datasette-acl-share's `shots` (which drives an already-running
// `just dev`), this is SELF-CONTAINED: it boots its own throwaway datasette
// on a fixed port with a fresh internal DB, seeds deterministic papers, drives
// Playwright, then tears the server down. One command, reproducible — so the
// committed PNGs only change when the UI actually changes (clean git diffs).
//
// Output is committed; the README embeds these, so re-run + commit when the
// editor / index / dialog look changes:  `just shots`  (or `just shots editor
// tables` for a subset).
//
// Determinism notes:
//   * Papers are owned by ACTOR (a signed ds_actor cookie), so every shot gets
//     the full owner UI (Share-as-manager, Lock menu, per-row action menus).
//     `seed_owner_manager_grant` (routes/docs.py) wires this on create.
//   * `freezeVolatile()` rewrites the moving text — relative timestamps, the
//     "N users online" count, "Deletes in N days" — to fixed strings so a
//     re-run with no UI change produces no binary diff.
//   * A stability stylesheet hides the blinking caret and disables transitions.
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";

const PORT = Number(process.env.SHOTS_PORT || 8486);
const BASE = `http://localhost:${PORT}`;
const PAPER = `${BASE}/-/paper`;
// Fixed signing secret — lets us mint a signed actor cookie so seeded papers
// are owned (mirrors the e2e harness's hard-coded secret). NOT a real secret.
const SECRET = "screenshots-secret-not-for-prod";
const DB = "/tmp/datasette-paper-shots-internal.db";
// A small user database attached so datasette_ref / datasette_embed have a
// real resource to resolve + render. The directory name makes the Datasette
// database name "data", so refs read `/data/vendors` (mirrors the e2e setup).
const DATA_DIR = "/tmp/datasette-paper-shots-data";
const DATA_DB = `${DATA_DIR}/data.db`;
// The browsing actor (owns the rich doc → full owner / manager UI).
const ACTOR = "alice";
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = resolve(HERE, "shot-plugins");
const OUT = resolve(HERE, "../../docs/screenshots");

const VIEWPORT = { width: 1200, height: 780 };

// ---------------------------------------------------------------------------
// Signed ds_actor cookie for an actor id. itsdangerous has no maintained Node
// port, so shell out to the same one-liner the e2e helpers use. Cached per id.
const _signed = new Map();
function signActorCookie(actorId) {
  let v = _signed.get(actorId);
  if (!v) {
    const out = execFileSync(
      "uv",
      [
        "run",
        "--prerelease=allow",
        "python",
        "-c",
        "import sys, json; from itsdangerous import URLSafeSerializer; " +
          'print(URLSafeSerializer(sys.argv[1]).dumps(json.loads(sys.argv[2]), salt="actor"))',
        SECRET,
        JSON.stringify({ a: { id: actorId } }),
      ],
      { encoding: "utf-8" },
    );
    v = out.trim();
    _signed.set(actorId, v);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Boot a throwaway datasette. Only `datasette-paper-create` is granted; view /
// edit / manage resolve per-doc from the owner grant the create endpoint seeds
// — exactly like `just dev`, which is the known-good owner-UI config.
async function reachable() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 500);
    const r = await fetch(PAPER, { redirect: "manual", signal: ac.signal });
    clearTimeout(t);
    return r.status < 500;
  } catch {
    return false;
  }
}

// Build the throwaway `data` database the embed shots resolve against: a
// `vendors` table (30 rows) plus a small `regions` table so the database-level
// embed/pill shots list more than one table. itsdangerous-style: shell out to
// python.
function setupDataDb() {
  const py = `
import os, sqlite3
os.makedirs(${JSON.stringify(DATA_DIR)}, exist_ok=True)
p = ${JSON.stringify(DATA_DB)}
if os.path.exists(p): os.remove(p)
db = sqlite3.connect(p)
db.execute("create table vendors (id integer primary key, name text, region text)")
regions = ["West", "East", "North", "South"]
rows = [(i, "Vendor %d" % i, regions[i % 4]) for i in range(1, 31)]
db.executemany("insert into vendors (id, name, region) values (?, ?, ?)", rows)
db.execute("create table regions (id integer primary key, name text)")
db.executemany("insert into regions (id, name) values (?, ?)", list(enumerate(regions, 1)))
db.commit(); db.close()
`;
  execFileSync("uv", ["run", "--prerelease=allow", "python3", "-c", py]);
}

async function startServer() {
  await rm(DB, { force: true });
  setupDataDb();
  // Refuse to start if something is already on the port rather than killing
  // it — that "something" might be a server the user cares about. The poll
  // below can't tell a stale server apart from ours, so bail loudly instead.
  if (await reachable()) {
    throw new Error(
      `something is already serving on ${BASE}. Stop it (or set SHOTS_PORT) and retry.`,
    );
  }
  // `detached: true` puts datasette in its own process group. We spawn via
  // `uv run`, so datasette is a *grandchild* — killing the `uv` pid alone
  // leaves datasette holding the port. Killing the whole group (negative pid
  // in stopServer) takes the grandchild down with it.
  const child = spawn(
    "uv",
    [
      "run",
      "--prerelease=allow",
      "datasette",
      "--internal",
      DB,
      // The attached user database (resolves as `data`).
      DATA_DB,
      "--secret",
      SECRET,
      // Throwaway plugin: friendly actor display names ("Alice Ada", …).
      "--plugins-dir",
      PLUGINS_DIR,
      "-s",
      "permissions.datasette-paper-create",
      "true",
      // Grant view globally (like the e2e harness) so the browsing actor sees
      // every seeded paper regardless of author — lets the index show a mix of
      // creators. Per-doc manage still comes from the owner grant, so the
      // share dialog renders its manager view on docs ACTOR created.
      "-s",
      "permissions.paper-view",
      "true",
      // Mentions resolve live display names via /api/actors/resolve, which
      // gates on datasette-user-profiles' `profile_access` action; without the
      // grant the resolver degrades to {} and the pills stay bare ids
      // (`@alice` instead of `@Alice Ada`), hanging the mentions shot.
      "-s",
      "permissions.profile_access",
      "true",
      "-p",
      String(PORT),
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`datasette exited early (code ${child.exitCode}):\n${log}`);
    }
    if (await reachable()) return child;
    await sleep(250);
  }
  stopServer(child);
  throw new Error(`datasette never came up on ${BASE}:\n${log}`);
}

// Kill the server's whole process group (datasette is uv's child). Idempotent.
function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Seed data. The create-from-markdown API (POST /api/docs with `content`)
// parses CommonMark + GFM tables + task lists, so one request gives us
// headings, prose, a table and a task list. Wiki links are inserted in the
// editor (the `[[` autocomplete), not markdown, so they're driven live.
const RICH = `# Q3 Planning

A shared space for the **product** team to plan the next quarter. Edits sync
live over SSE, and the header shows who's *currently* online.

## Goals

- Ship the collaborative editor
- Document the \`markdown\` import/export
- Link related papers together

> Tip: type \`[[\` anywhere to link to another paper.

## Budget

| Item | Owner | Cost |
| --- | --- | --- |
| Design sprint | alice | $4,000 |
| Infrastructure | bob | $2,500 |
| Documentation | carol | $1,000 |

## Launch checklist

- [x] Real-time collaboration over SSE
- [x] Tables and task lists
- [ ] Wiki-style links between papers
- [ ] Write the README
`;

// A short doc that shows `@`-mentions resolved to live display names. Kept
// separate from RICH so the other shots' framing is unaffected.
const MENTIONS = `# Standup — June 22

[@alice](paper:/actor/alice) shipped the collaborative editor. [@bob](paper:/actor/bob) is
writing the markdown docs, and [@carol](paper:/actor/carol) is reviewing the launch
checklist.

Type \`@\` anywhere to mention a teammate — the pill resolves to their live
display name and links straight to their profile.
`;

// A doc with inline \`#tags\` in the body — navigational anchors, a separate
// namespace from the document-level metadata tags.
const INLINE_TAGS = `# Release notes

This work spans [#roadmap](paper:/tag/roadmap) and [#q3-planning](paper:/tag/q3-planning),
with follow-ups filed under [#tech-debt](paper:/tag/tech-debt).

Type \`#\` anywhere in the body to drop an inline tag — an in-document anchor,
distinct from a paper's metadata tags shown on the index.
`;

// Extra docs that also carry the inline \`#roadmap\` tag in their body, so the
// tag results page (\`/-/paper/tag/roadmap\`) lists more than one row. Owned by
// ACTOR (like "Release notes") so they survive the refs endpoint's acl filter;
// the varied occurrence counts exercise the "N mention(s)" pluralization.
const TAG_PAGE_A = `# Q3 roadmap review

Sprint planning notes filed under [#roadmap](tag:roadmap). We revisit the
[#roadmap](tag:roadmap) priorities at the end of every cycle.
`;
const TAG_PAGE_B = `# Launch checklist

Ship-blocking work tracked against the [#roadmap](tag:roadmap).
`;

// Docs for the embed element shots. Each `inline_embed` pill is authored with
// the canonical \`paper:/embed/<provider-kind>/<ref>\` link scheme
// (`[label](paper:/embed/datasette/<path>)`); each `block_embed` is a fenced
// \`paper-embed\` block whose body is a JSON object `{config, mode, ref}`
// mirroring the node attrs (key order matches the serializer's sort_keys=True
// output in datasette_paper/markdown.py). One doc per resolved kind so the
// inline/block element shots stay single-purpose. (Block bodies use plain
// strings to avoid escaping the fence backticks inside a template literal.)
const INLINE_DB = `# Vendor database

The whole [vendors database](paper:/embed/datasette/data) is addressable as an inline
reference pill — it resolves to the database's name and links straight to it.
`;
const INLINE_TABLE = `# Vendor directory

Our canonical list lives in the [vendors table](paper:/embed/datasette/data/vendors).
Paste any Datasette URL into the editor to drop a reference pill like that one.
`;
const INLINE_ROW = `# Featured vendor

This week we're highlighting [vendor #5](paper:/embed/datasette/data/vendors/5) — an inline
reference pill that resolves to a single row.
`;
const BLOCK_DB =
  '# Vendors database\n\n```paper-embed\n{"config": {}, "mode": "table", "ref": "/data"}\n```\n';
const BLOCK_TABLE =
  '# Vendors table\n\n```paper-embed\n{"config": {}, "mode": "table", "ref": "/data/vendors"}\n```\n';
const BLOCK_ROW =
  '# Featured vendor\n\n```paper-embed\n{"config": {}, "mode": "table", "ref": "/data/vendors/5"}\n```\n';

// SQL query block: an editable query run against the `data` database, with the
// results rendered live. The `db=data` token marks it as a runnable SQL block
// (a plain ```sql fence stays a code block). One doc shows the editor + results
// expanded; the `_HIDDEN` variant ships with the query collapsed (the "report"
// look) via the trailing `hidden` token.
const SQL_BLOCK =
  "# Q2 vendor report\n\nLive numbers, straight from the warehouse — edit the " +
  "query and hit Run. Results page 10 at a time (configurable to 25/100).\n\n" +
  "```sql db=data\nselect id, name, region from vendors order by id\n```\n";
const SQL_BLOCK_HIDDEN =
  "# Q2 vendor report\n\nThe SQL is tucked away — readers see just the result " +
  "table, and can click Show SQL to reveal the query.\n\n```sql db=data hidden\n" +
  "select region, count(*) as vendors\nfrom vendors\ngroup by region\n" +
  "order by vendors desc\n```\n";

async function seed(ctx) {
  // Create as a specific author by sending that actor's signed cookie on the
  // request — varies the index "Created by" column across alice/bob/carol.
  const create = async (name, author, content) => {
    const data = content ? { name, content } : { name };
    const r = await ctx.request.post(`${PAPER}/api/docs`, {
      data,
      headers: { Cookie: `ds_actor=${signActorCookie(author)}` },
    });
    if (r.status() !== 201) {
      throw new Error(`create "${name}" failed: ${r.status()} ${await r.text()}`);
    }
    return (await r.json()).id;
  };
  // Set a doc's tags via the replace API. Mutations require manage, so send
  // the owner's signed cookie (the create endpoint seeds owner = author).
  const tagDoc = async (id, tags, owner) => {
    const r = await ctx.request.post(`${PAPER}/api/docs/${id}/tags/replace`, {
      data: { tags },
      headers: { Cookie: `ds_actor=${signActorCookie(owner)}` },
    });
    if (r.status() !== 200) {
      throw new Error(`tag "${id}" failed: ${r.status()} ${await r.text()}`);
    }
  };
  // List-page filler, created oldest-first so the rich doc sorts to the top.
  const roadmapId = await create("Product Roadmap", "bob");
  const designId = await create("Design Notes", "carol");
  const budgetId = await create("Budget 2026", "bob");
  // The rich doc is owned by ACTOR so its share dialog shows the manager view.
  const richId = await create("Q3 Planning", ACTOR, RICH);
  const mentionId = await create("Standup", ACTOR, MENTIONS);
  const inlineTagId = await create("Release notes", ACTOR, INLINE_TAGS);
  // Two more #roadmap-tagged docs so the tag results-page shot has a real list.
  await create("Q3 roadmap review", ACTOR, TAG_PAGE_A);
  await create("Launch checklist", ACTOR, TAG_PAGE_B);
  // Document-level tags: populate a vocabulary so the index shows per-row tag
  // chips + the filter bar, and the owner-only tag editor has content.
  await tagDoc(roadmapId, ["roadmap", "q3"], "bob");
  await tagDoc(designId, ["design"], "carol");
  await tagDoc(budgetId, ["budget", "q3"], "bob");
  await tagDoc(richId, ["roadmap", "q3"], ACTOR);
  // Empty docs for the slash-menu / embed-picker authoring shots (each mutates
  // its own doc so the shots don't contaminate one another).
  const slashId = await create("Slash menu demo", ACTOR);
  const embedPickerId = await create("Embed picker demo", ACTOR);
  // Pre-seeded docs, one per embed element × resolved kind (database/table/row).
  const inlineDbId = await create("Vendor database", ACTOR, INLINE_DB);
  const inlineTableId = await create("Vendor directory", ACTOR, INLINE_TABLE);
  const inlineRowId = await create("Featured vendor (inline)", ACTOR, INLINE_ROW);
  const blockDbId = await create("Vendors database", ACTOR, BLOCK_DB);
  const blockTableId = await create("Vendors table", ACTOR, BLOCK_TABLE);
  const blockRowId = await create("Featured vendor (block)", ACTOR, BLOCK_ROW);
  const sqlBlockId = await create("Q2 vendor report", ACTOR, SQL_BLOCK);
  const sqlBlockHiddenId = await create("Q2 vendor report (hidden)", ACTOR, SQL_BLOCK_HIDDEN);
  return {
    richId,
    mentionId,
    inlineTagId,
    slashId,
    embedPickerId,
    inlineDbId,
    inlineTableId,
    inlineRowId,
    blockDbId,
    blockTableId,
    blockRowId,
    sqlBlockId,
    sqlBlockHiddenId,
  };
}

// ---------------------------------------------------------------------------
// Per-page stabilization, applied right before each capture.
const STABILITY_CSS = `*, *::before, *::after {
  caret-color: transparent !important;
  transition: none !important;
  animation: none !important;
}`;

async function freezeVolatile(page) {
  await page.evaluate(() => {
    const set = (sel, text) =>
      document.querySelectorAll(sel).forEach((el) => (el.textContent = text));
    // Editor header.
    set(".updated-at", "edited just now");
    set(".users", "3 users online");
    // Index list: Updated column (3rd cell) + trash "Deletes in N days".
    document
      .querySelectorAll(".paper-index tbody tr td:nth-child(3)")
      .forEach((el) => (el.textContent = "2 hours ago"));
    set(".delete-at", "Deletes in 7 days");
  });
}

async function gotoEditor(page, id) {
  await page.goto(`${PAPER}/doc/${id}`);
  const pm = page.locator(".ProseMirror");
  await pm.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(
    () => document.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "true",
    { timeout: 10_000 },
  );
  // Header metadata loads via a follow-up fetch; wait for it so the freeze
  // has something to rewrite and the avatar/title aren't mid-render.
  await page.locator(".doc-header .meta").waitFor({ state: "visible", timeout: 10_000 });
}

// Screenshot the bounding-box union of several selectors, padded — used to
// frame a feature plus its detached floating UI (the table action bar lives in
// a body-appended root, so an element shot of the table alone would clip it).
async function shotUnion(page, selectors, file, pad = 16) {
  const boxes = [];
  for (const sel of selectors) {
    const box = await page.locator(sel).first().boundingBox();
    if (box) boxes.push(box);
  }
  if (!boxes.length) throw new Error(`no boxes for ${selectors.join(", ")}`);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const clip = {
    x: Math.max(0, x - pad),
    y: Math.max(0, y - pad),
    width: Math.min(VIEWPORT.width, right - x + pad * 2),
    height: bottom - y + pad * 2,
  };
  await page.screenshot({ path: file, clip });
}

// ---------------------------------------------------------------------------
// Shots. Each gets a fresh page from the shared (cookie-bearing) context.
function buildShots(ctx, ids) {
  const {
    richId,
    mentionId,
    inlineTagId,
    slashId,
    embedPickerId,
    inlineDbId,
    inlineTableId,
    inlineRowId,
    blockDbId,
    blockTableId,
    blockRowId,
    sqlBlockId,
    sqlBlockHiddenId,
  } = ids;
  // Stability CSS is injected on the context via addInitScript (see main), so
  // it survives every navigation — addStyleTag here would be discarded by the
  // subsequent page.goto().
  const newPage = () => ctx.newPage();
  const out = (n) => resolve(OUT, `${n}.png`);

  // Inline `inline_embed` pill shot: open a pre-seeded doc, wait for the pill's
  // resolver fetch to settle (it leaves `--loading`), then full-page capture.
  const inlineEmbedShot = (id, file) => async () => {
    const page = await newPage();
    await gotoEditor(page, id);
    await page.locator(".pm-inline-embed").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector(".pm-inline-embed");
        return !!el && !el.classList.contains("pm-inline-embed--loading");
      },
      { timeout: 10_000 },
    );
    await freezeVolatile(page);
    await page.screenshot({ path: out(file) });
    await page.close();
  };

  // Block `block_embed` shot: open a pre-seeded doc, wait for the NodeView's
  // per-viewer fetch to replace the loading skeleton with real content
  // (asserted via `needle`, a string the rendered payload must contain), then
  // full-page capture.
  const blockEmbedShot = (id, file, needle) => async () => {
    const page = await newPage();
    await gotoEditor(page, id);
    await page.locator(".pm-block-embed").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(
      (text) => {
        const el = document.querySelector(".pm-block-embed");
        if (!el || el.querySelector(".pm-block-embed-skeleton")) return false;
        return (el.innerText || "").includes(text);
      },
      needle,
      { timeout: 10_000 },
    );
    await freezeVolatile(page);
    await page.screenshot({ path: out(file) });
    await page.close();
  };

  // SQL query block shot: open a pre-seeded doc and wait for the NodeView's
  // auto-run (on mount) to render the results table, then full-page capture.
  const sqlBlockShot = (id, file) => async () => {
    const page = await newPage();
    await gotoEditor(page, id);
    await page.locator(".pm-sql-block").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator(".pm-sql-block table").waitFor({ state: "visible", timeout: 10_000 });
    await freezeVolatile(page);
    await page.screenshot({ path: out(file) });
    await page.close();
  };

  return {
    index: async () => {
      const page = await newPage();
      await page.goto(PAPER);
      await page.locator(".paper-index table tbody tr").first().waitFor({ timeout: 15_000 });
      await freezeVolatile(page);
      await page.screenshot({ path: out("index") });
      await page.close();
    },

    editor: async () => {
      const page = await newPage();
      await gotoEditor(page, richId);
      await freezeVolatile(page);
      await page.screenshot({ path: out("editor") });
      await page.close();
    },

    // The owner-only tag editor modal, opened from a doc's row action menu.
    "tag-editor": async () => {
      const page = await newPage();
      await page.goto(PAPER);
      await page.locator(".paper-index table tbody tr").first().waitFor({ timeout: 15_000 });
      const row = page.locator(".paper-index tbody tr", { hasText: "Q3 Planning" }).first();
      await row.locator('[aria-label="Actions"]').click();
      await page.locator("button", { hasText: "Edit tags" }).first().click();
      const dialog = page.locator(".tag-editor");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      await freezeVolatile(page);
      await dialog.screenshot({ path: out("tag-editor") });
      await page.close();
    },

    mentions: async () => {
      const page = await newPage();
      await gotoEditor(page, mentionId);
      // Wait for the mention pills to resolve their live display names (the
      // NodeView fetches through the ActorResolver after mount).
      await page.locator(".pm-mention").first().waitFor({ state: "visible", timeout: 10_000 });
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".pm-mention")].filter((el) =>
            /\bAda\b|\bBabbage\b|\bShaw\b/.test(el.textContent || ""),
          ).length >= 3,
        { timeout: 10_000 },
      );
      await freezeVolatile(page);
      await page.screenshot({ path: out("mentions") });
      await page.close();
    },

    "inline-tags": async () => {
      const page = await newPage();
      await gotoEditor(page, inlineTagId);
      // Wait for the inline #tag pills to render.
      await page.waitForFunction(
        () => document.querySelectorAll(".pm-tag").length >= 3,
        { timeout: 10_000 },
      );
      await freezeVolatile(page);
      await page.screenshot({ path: out("inline-tags") });
      await page.close();
    },

    "inline-tag-popup": async () => {
      const page = await newPage();
      await gotoEditor(page, inlineTagId);
      // Land the cursor at the end of the intro paragraph, then trigger the
      // `#` suggest popup with a partial query.
      await page.locator(".ProseMirror p").first().click();
      await page.keyboard.press("End");
      await page.keyboard.type(" #road");
      await page.locator(".pm-tag-popup").waitFor({ state: "visible", timeout: 10_000 });
      await freezeVolatile(page);
      await page.screenshot({ path: out("inline-tag-popup") });
      await page.close();
    },

    // The standalone results page reached by clicking an inline #tag — lists
    // every viewable doc whose body contains that tag (here `#roadmap`, seeded
    // into three ACTOR-owned docs above). Fetched client-side, so wait for the
    // rows to render before capturing the framed `.tag-page` column.
    "tag-page": async () => {
      const page = await newPage();
      await page.goto(`${PAPER}/tag/roadmap`);
      await page.locator(".tag-page-list").waitFor({ state: "visible", timeout: 10_000 });
      await page.waitForFunction(
        () => document.querySelectorAll(".tag-page-row").length >= 3,
        { timeout: 10_000 },
      );
      await freezeVolatile(page);
      await page.locator(".tag-page").screenshot({ path: out("tag-page") });
      await page.close();
    },

    // The Notion-style `/` slash command menu, open in an empty block.
    "slash-menu": async () => {
      const page = await newPage();
      await gotoEditor(page, slashId);
      await page.locator(".ProseMirror").click();
      await page.keyboard.type("/");
      await page.locator(".pm-slash-menu").waitFor({ state: "visible", timeout: 10_000 });
      await freezeVolatile(page);
      await page.screenshot({ path: out("slash-menu") });
      await page.close();
    },

    // The Datasette embed picker dialog (slash command → search → result).
    "embed-picker": async () => {
      const page = await newPage();
      await gotoEditor(page, embedPickerId);
      await page.locator(".ProseMirror").click();
      await page.keyboard.type("/datasette");
      await page.locator(".pm-slash-menu").waitFor({ state: "visible", timeout: 10_000 });
      await page.keyboard.press("Enter");
      const dialog = page.locator(".ds-embed-dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      await dialog.locator(".ds-embed-search").fill("vendors");
      await dialog
        .locator(".ds-embed-result", { hasText: "vendors" })
        .first()
        .waitFor({ state: "visible", timeout: 10_000 });
      await freezeVolatile(page);
      await dialog.screenshot({ path: out("embed-picker") });
      await page.close();
    },

    // Inline `inline_embed` pills, one per resolved kind (database/table/row).
    "inline-embed-database": inlineEmbedShot(inlineDbId, "inline-embed-database"),
    "inline-embed-table": inlineEmbedShot(inlineTableId, "inline-embed-table"),
    "inline-embed-row": inlineEmbedShot(inlineRowId, "inline-embed-row"),

    // Block `block_embed` renders, one per resolved kind: a database's table
    // listing, a read-only row-capped table, and a single row's field card.
    "block-embed-database": blockEmbedShot(blockDbId, "block-embed-database", "vendors"),
    "block-embed-table": blockEmbedShot(blockTableId, "block-embed-table", "Vendor 1"),
    "block-embed-row": blockEmbedShot(blockRowId, "block-embed-row", "Vendor 5"),

    // SQL query block: editable query + Run + live results, and the collapsed
    // ("Show SQL") report view.
    "sql-block": sqlBlockShot(sqlBlockId, "sql-block"),
    "sql-block-hidden": sqlBlockShot(sqlBlockHiddenId, "sql-block-hidden"),

    tables: async () => {
      const page = await newPage();
      await gotoEditor(page, richId);
      // Click a data cell to summon the floating in-table action bar.
      const table = page.locator(".ProseMirror table");
      await table.scrollIntoViewIfNeeded();
      await page.locator(".ProseMirror table td").first().click();
      await page.locator(".pm-tt-bar").waitFor({ state: "visible", timeout: 10_000 });
      await freezeVolatile(page);
      await shotUnion(page, [".pm-table-tooltip-root", ".ProseMirror table"], out("tables"));
      await page.close();
    },

    tasks: async () => {
      const page = await newPage();
      await gotoEditor(page, richId);
      // Element screenshot auto-scrolls and captures the whole list — the
      // task list sits below the fold, so a viewport clip would cut it off.
      const list = page.locator("ul[data-task-list]").first();
      await list.waitFor({ timeout: 10_000 });
      await freezeVolatile(page);
      await list.screenshot({ path: out("tasks") });
      await page.close();
    },

    "wiki-links": async () => {
      const page = await newPage();
      await gotoEditor(page, richId);
      // Land the cursor at the end of the intro paragraph so the `[[` popup
      // opens in clean space (clicking the editor root drops it at doc start,
      // on top of the H1).
      await page.locator(".ProseMirror p").first().click();
      await page.keyboard.press("End");
      await page.keyboard.type(" [[Des");
      await page.locator(".pm-wikilink-popup").waitFor({ state: "visible", timeout: 10_000 });
      await page
        .locator(".pm-wikilink-item", { hasText: "Design Notes" })
        .first()
        .waitFor({ timeout: 10_000 });
      await freezeVolatile(page);
      await page.screenshot({ path: out("wiki-links") });
      await page.close();
    },

    share: async () => {
      const page = await newPage();
      await gotoEditor(page, richId);
      await page.locator(".datasette-acl-share__trigger").click();
      const dialog = page.locator("dialog.datasette-acl-share-dialog[open]");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      // Let the role rows render before capturing.
      await page.locator(".datasette-acl-share-dialog__list").waitFor({ timeout: 10_000 });
      await dialog.screenshot({ path: out("share") });
      await page.close();
    },

    "image-dialog-empty": async () => {
      const page = await newPage();
      await gotoEditor(page, richId);
      await page.locator('.paper-toolbar [aria-label="Insert image"]').click();
      const dialog = page.locator("dialog.image-dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      await dialog.screenshot({ path: out("image-dialog-empty") });
      await page.close();
    },

    "image-dialog-chosen": async () => {
      const page = await newPage();
      await gotoEditor(page, richId);
      await page.locator('.paper-toolbar [aria-label="Insert image"]').click();
      const dialog = page.locator("dialog.image-dialog");
      await dialog.waitFor({ state: "visible", timeout: 10_000 });
      await dialog.locator(".img-tab", { hasText: "Upload from computer" }).click();
      // A real SVG so the preview + Insert (enabled) state is exercised.
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">' +
        '<rect width="320" height="180" fill="#0b5cad"/>' +
        '<text x="160" y="103" font-family="sans-serif" font-size="22" fill="#fff" text-anchor="middle">diagram.svg</text></svg>';
      await page.setInputFiles(".image-upload-input", {
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(svg),
      });
      await dialog.locator(".image-preview").waitFor({ state: "visible", timeout: 10_000 });
      await dialog.screenshot({ path: out("image-dialog-chosen") });
      await page.close();
    },
  };
}

// ---------------------------------------------------------------------------
async function main() {
  const shotsByName = {}; // filled after context exists
  const requested = new Set(process.argv.slice(2));

  await mkdir(OUT, { recursive: true });
  console.log(`booting datasette on ${BASE} …`);
  const server = await startServer();
  // Make sure the server dies even on Ctrl-C / a thrown error mid-run.
  const onSignal = () => {
    stopServer(server);
    process.exit(130);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    // Re-inject the stability stylesheet on every navigation (addStyleTag on a
    // single page wouldn't survive page.goto). This is what hides the
    // installed debug bar and the blinking caret in every shot.
    await ctx.addInitScript((css) => {
      const inject = () => {
        if (document.getElementById("__shots_stability")) return;
        const s = document.createElement("style");
        s.id = "__shots_stability";
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
      };
      inject();
      document.addEventListener("DOMContentLoaded", inject);
    }, STABILITY_CSS);
    await ctx.addCookies([
      { name: "ds_actor", value: signActorCookie(ACTOR), domain: "localhost", path: "/" },
    ]);

    console.log("seeding papers …");
    const ids = await seed(ctx);

    Object.assign(shotsByName, buildShots(ctx, ids));
    const names = Object.keys(shotsByName);
    const unknown = [...requested].filter((n) => !names.includes(n));
    if (unknown.length) throw new Error(`unknown shot(s): ${unknown.join(", ")} (have: ${names.join(", ")})`);
    const todo = requested.size ? names.filter((n) => requested.has(n)) : names;

    for (const name of todo) {
      await shotsByName[name]();
      console.log(`✓ ${name} → ${resolve(OUT, name + ".png")}`);
    }
    await ctx.close();
  } finally {
    await browser.close();
    stopServer(server);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
