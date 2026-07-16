// Seed data. The create-from-markdown API (POST /api/docs with `content`)
// parses CommonMark + GFM tables + task lists, so one request gives us
// headings, prose, a table and a task list. Wiki links are inserted in the
// editor (the `[[` autocomplete), not markdown, so they're driven live.
//
// `seed(ctx)` returns an `ids` object whose keys are referenced by shots via
// the `doc:` field (or by name inside a `goto`/`prepare`). Keep that object's
// shape stable — adding keys is fine, renaming/removing breaks shots.
import { PAPER, ACTOR } from "./config.mjs";
import { signActorCookie } from "./cookie.mjs";

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

// A short doc with a normal external link, for the link hover/Edit shot. Kept
// separate so its framing isn't perturbed by the other shots.
const LINK = `# Project links

The [Datasette](https://datasette.io) project powers this collaborative editor.
Hover a link while editing to reveal its Edit · Open · Copy actions.
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

Sprint planning notes filed under [#roadmap](paper:/tag/roadmap). We revisit the
[#roadmap](paper:/tag/roadmap) priorities at the end of every cycle.
`;
const TAG_PAGE_B = `# Launch checklist

Ship-blocking work tracked against the [#roadmap](paper:/tag/roadmap).
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
// A table embed with a column selection: `config.columns` hides the PK `id`
// and renders just name + region, in that order (the "Columns…" picker writes
// exactly this). Demonstrates the column-filter feature for the README.
const BLOCK_COLUMNS =
  "# Vendors (selected columns)\n\n```paper-embed\n" +
  '{"config": {"columns": ["name", "region"]}, "mode": "table", "ref": "/data/vendors"}\n```\n';
// A table embed with a shared filter + sort: `config.filters`/`config.sort`
// (the "Filter & sort…" panel writes exactly this) render the funnel badge,
// the "7 rows where region = West sorted by name descending" summary line,
// and the ▼ indicator on the sorted column. Demonstrates the embed-filters
// feature for the README.
const BLOCK_FILTERS =
  "# Vendors (filtered)\n\n```paper-embed\n" +
  '{"config": {"filters": [{"column": "region", "op": "exact", "value": "West"}], ' +
  '"sort": {"column": "name", "desc": true}}, "mode": "table", "ref": "/data/vendors"}\n```\n';

// Ugly-data doc for the result-rendering shots: a wide table embed (13
// columns incl. multi-line/long text, an unbroken URL and a blob) plus a SQL
// block over the same rows. Long values collapse to one clamped line, blobs
// render as their byte size, and the table h-scrolls with edge fades.
const RESULT_RENDERING =
  "# Support tickets\n\nReal-world messy data: long values collapse to one " +
  "line and expand on demand, binary cells show their size, and wide tables " +
  "scroll sideways.\n\n```paper-embed\n" +
  '{"config": {}, "mode": "table", "ref": "/data/tickets"}\n```\n\n' +
  "```sql db=data\nselect id, customer, subject, description, attachment " +
  "from tickets order by id\n```\n";

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

// Inline SQL values: a `source` (named query) feeds `${{name.column}}` chips
// spliced straight into prose. The chips fetch live per-viewer from `data`.
const INLINE_VALUE =
  "# Vendor snapshot\n\n" +
  "```source name=vendors db=data\n" +
  "select count(*) as n, count(distinct region) as regions from vendors\n```\n\n" +
  "We currently track ${{vendors.n}} vendors across ${{vendors.regions}} " +
  "regions — and the numbers update themselves whenever the warehouse changes.\n";

// Table-of-contents block: a ```paper-toc fence (empty body = default config)
// followed by a multi-level heading outline, so the rendered card shows the
// nested H1/H2/H3 list it auto-generates. Plain string concatenation avoids
// escaping the fence backticks inside a template literal (like the BLOCK_*
// fixtures above).
const TOC =
  "# Engineering handbook\n\n" +
  "```paper-toc\n```\n\n" +
  "A living guide for the team. The contents above are generated from this " +
  "document's headings and refresh themselves as sections come and go.\n\n" +
  "## Getting started\n\n" +
  "How to get a local environment running and make your first change.\n\n" +
  "### Prerequisites\n\nThe tools to install before you begin.\n\n" +
  "### Local setup\n\nClone, install dependencies, and boot the dev server.\n\n" +
  "## Architecture\n\nHow the pieces fit together.\n\n" +
  "### Services\n\nThe long-running processes and what each one owns.\n\n" +
  "### Data model\n\nThe core tables and how they relate.\n\n" +
  "## Deployment\n\nShipping changes safely to production.\n";

// Code block with the static-highlight + language-picker + CM-on-focus
// shots (code-block, code-lang-picker, code-block-focused). Own doc, distinct
// from every other fixture, so none of the three shots' interactions (hover,
// filter-typing, focusing the block) can mutate a doc another shot depends on
// being clean.
const CODE_BLOCK = `# Language support

Code blocks get real syntax highlighting, and clicking in upgrades the plain
text surface to a full CodeMirror editor — bracket matching, indentation, and
(for SQL) keyword completion.

\`\`\`py
def fibonacci(n):
    # classic recursive definition
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)
\`\`\`
`;

// Callout (GitHub-style admonition) fixture — a "Deploy runbook" with one of
// each of the five kinds, each carrying a title + a short body; the WARNING
// one gets a multi-block body (a paragraph + a list) so the shot also proves
// a callout's body isn't limited to a single paragraph. Own doc so the
// picker shot's click-to-open interaction can't perturb any other fixture.
const CALLOUTS = `# Deploy runbook

Steps for shipping a production release, plus the gotchas the on-call
rotation keeps rediscovering the hard way.

> [!NOTE] Staging first
> Every release goes to staging before production — the health check must
> stay green for at least five minutes.

> [!TIP] Rollback is one command
> \`deploy rollback <version>\` reverts instantly, no rebuild needed — don't
> hesitate to use it.

> [!IMPORTANT] Notify #deploys before you start
> Post the version and a one-line summary in #deploys before kicking off a
> production rollout.

> [!WARNING] Migrations run automatically on boot
> Schema migrations execute the moment the new version starts — never
> during a rolling restart.
>
> - Confirm the migration is backward compatible with the old code
> - Confirm a rollback plan exists if it isn't
> - Watch the migration log for the first minute after deploy

> [!CAUTION] Don't skip the smoke test
> Skipping the smoke test caused two outages this quarter — always click
> through the five critical flows before declaring victory.
`;

// Inline `date` atom fixture (the date / date-format-picker shots): a compact
// calendar chip authored as a `[label](paper:/date/<iso>)` markdown link (the
// label is ignored on parse — the URI is the source of truth). A date in prose
// stays neutral; a date inside an UNCHECKED task tints overdue (red) / today
// (amber), and a checked task's date goes neutral again. The shots freeze the
// clock to 2026-07-15 (page.clock.setFixedTime), so the seeded dates around
// that day give a deterministic overdue / today / done trio. Date-only (zone-
// less) chips only — a timed chip converts to the viewer's timezone, which
// would vary per machine and churn the committed PNG.
const DATES = `# Sprint schedule

The kickoff is on [Jul 20, 2026](paper:/date/2026-07-20). Type \`/date\` (or
press Cmd-;) to drop a date anywhere — a compact chip that round-trips through
markdown and reads in every collaborator's own calendar.

## Deadlines

- [ ] Book the venue [Jul 10, 2026](paper:/date/2026-07-10)
- [ ] Send the invites [Jul 15, 2026](paper:/date/2026-07-15)
- [x] Reserve the catering [Jul 5, 2026](paper:/date/2026-07-05)
`;

// task-assign fixture (the todos / profile-todos shots): a launch checklist
// whose task items carry @mention assignees and `date` due dates. Assignment is
// pure interpretation of doc content, and the create-from-markdown path
// reindexes it, so `/-/paper/todos` and the `<profile-todos>` profile section
// see it with no edit. Dates are chosen relative to the clock the shots FREEZE
// to 2026-07-15 (page.clock.setFixedTime), so the five buckets — Overdue /
// Today / This week / Later / No due date — are deterministic across runs. Most
// tasks are alice's (her /todos page shows all five buckets); two name bob (the
// profile-todos shot visits bob's profile), and one names both (a multi-
// assignee chip row). The date-atom labels are ignored on parse — the
// `paper:/date/<iso>` URI is the source of truth.
const TODOS = `## Backend

- [ ] [@alice](paper:/actor/alice) Fix the login redirect [due](paper:/date/2026-07-11)
- [ ] [@alice](paper:/actor/alice) [@bob](paper:/actor/bob) Ship the CSV importer [due](paper:/date/2026-07-15)

## Frontend

- [ ] [@alice](paper:/actor/alice) Polish the empty states [due](paper:/date/2026-07-19)
- [ ] [@bob](paper:/actor/bob) Migrate the settings page [due](paper:/date/2026-07-16)
- [ ] [@alice](paper:/actor/alice) Write the changelog [due](paper:/date/2026-08-06)
- [ ] [@alice](paper:/actor/alice) Triage the launch backlog
`;

// Link-graph cluster (the link-graph / link-graph-ego shots): three docs whose
// bodies carry `[[<id>]]` wiki links to the seeded docs above. The markdown
// parser splits those into real `paper_link` atoms and the create API reindexes
// links synchronously, so the graph endpoint sees the edges without driving the
// editor. Built inside `seed()` — the templates need the target docs' ids.
const teamWiki = (richId, roadmapId, designId, budgetId) => `# Team wiki

The hub for everything the product team ships. Start with [[${richId}]] for
this quarter's plan, then dig into [[${roadmapId}]] and [[${designId}]].

Budgets and vendor spend live in [[${budgetId}]].
`;
const onboarding = (teamWikiId, designId) => `# Onboarding guide

New teammates start at [[${teamWikiId}]]. Skim [[${designId}]] before your
first review.
`;
const retro = (richId, roadmapId) => `# Retro — June

What went well: [[${richId}]] landed on time. Carry-overs move to
[[${roadmapId}]]; see [[${richId}]] for the revised checklist.
`;

export async function seed(ctx) {
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
  // Append markdown to a doc as `author`, recording an edit attributed to them
  // (the step's actor_id populates the `_datasette_paper_doc_activity` rollup
  // the profile-papers endpoint reads). Requires edit perm → send the owner's
  // cookie (create seeds owner = author, so the owner can edit their own doc).
  const append = async (id, content, author) => {
    const r = await ctx.request.post(`${PAPER}/api/docs/${id}/append`, {
      data: { content, content_type: "markdown" },
      headers: { Cookie: `ds_actor=${signActorCookie(author)}` },
    });
    if (r.status() !== 200) {
      throw new Error(`append "${id}" failed: ${r.status()} ${await r.text()}`);
    }
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
  const linkId = await create("Project links", ACTOR, LINK);
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
  // profile-papers shot: bob owns "Product Roadmap" + "Budget 2026" (both show a
  // "Created" badge on his profile). One authenticated append attributes an edit
  // to bob so "Product Roadmap" also rolls up activity → "Created · edited". The
  // two docs are the profile's whole Papers list; no new docs are added (that
  // would perturb the index shot).
  await append(roadmapId, "Reviewed the Q3 milestones and confirmed owners.", "bob");
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
  const blockColumnsId = await create("Vendors (columns)", ACTOR, BLOCK_COLUMNS);
  const blockFiltersId = await create("Vendors (filtered)", ACTOR, BLOCK_FILTERS);
  const resultRenderingId = await create("Support tickets", ACTOR, RESULT_RENDERING);
  const sqlBlockId = await create("Q2 vendor report", ACTOR, SQL_BLOCK);
  const sqlBlockHiddenId = await create("Q2 vendor report (hidden)", ACTOR, SQL_BLOCK_HIDDEN);
  const inlineValueId = await create("Vendor snapshot", ACTOR, INLINE_VALUE);
  const tocId = await create("Engineering handbook", ACTOR, TOC);
  const codeBlockId = await create("Language support", ACTOR, CODE_BLOCK);
  const calloutsId = await create("Deploy runbook", ACTOR, CALLOUTS);
  // Inline `date` atom fixture for the date / date-format-picker shots.
  const dateId = await create("Sprint schedule", ACTOR, DATES);
  // Assigned/dated task fixture for the todos + profile-todos shots. Owned by
  // ACTOR (alice) so the browsing viewer can see it; the create-path reindex
  // fills the m009 assignment index synchronously.
  const todosId = await create("Launch checklist", ACTOR, TODOS);
  // Link-graph cluster: docs whose `[[<id>]]` links give the graph shots real
  // edges (double-linking richId in the retro gives one thicker ×2 edge).
  // Owned by ACTOR (not bob — the profile-papers shot lists bob's docs) and
  // tagged from the EXISTING vocabulary only, so the index filter bar gains no
  // new chips; the tags feed the graph's "Color by: Tag" legend.
  const teamWikiId = await create(
    "Team wiki",
    ACTOR,
    teamWiki(richId, roadmapId, designId, budgetId),
  );
  await create("Onboarding guide", ACTOR, onboarding(teamWikiId, designId));
  const retroId = await create("Retro — June", ACTOR, retro(richId, roadmapId));
  await tagDoc(teamWikiId, ["q3"], ACTOR);
  await tagDoc(retroId, ["roadmap"], ACTOR);
  return {
    // The actor whose user-profiles profile the profile-papers shot visits.
    profileActor: "bob",
    richId,
    linkId,
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
    blockColumnsId,
    blockFiltersId,
    resultRenderingId,
    sqlBlockId,
    sqlBlockHiddenId,
    inlineValueId,
    tocId,
    codeBlockId,
    calloutsId,
    teamWikiId,
    dateId,
    todosId,
  };
}
