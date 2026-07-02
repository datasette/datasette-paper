// Boot/teardown for the throwaway datasette the shots drive. Only
// `datasette-paper-create` is granted; view / edit / manage resolve per-doc
// from the owner grant the create endpoint seeds — exactly like `just dev`,
// which is the known-good owner-UI config.
import { rm } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { BASE, PAPER, DB, DATA_DIR, DATA_DB, SECRET, PLUGINS_DIR, PORT } from "./config.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function reachable() {
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
export function setupDataDb() {
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
# Ugly, real-world-shaped data for the result-rendering shots: many columns,
# multi-line + very long text, an unbroken-token URL, and a binary blob.
# Everything is deterministic (the screenshot contract).
db.execute("""create table tickets (
  id integer primary key, opened text, customer text, email text,
  region text, priority text, status text, subject text, description text,
  stack_trace text, page_url text, attachment blob, resolution text)""")
description = (
  "Customer reports the checkout button does nothing on Safari 17.\\n\\n"
  "Steps to reproduce:\\n"
  "1. Add any item to the cart\\n"
  "2. Navigate to /checkout\\n"
  "3. Click 'Place order'\\n\\n"
  "Expected: order confirmation page.\\n"
  "Actual: silent failure; the browser console shows a Content-Security-Policy "
  "violation for the payments iframe, followed by an unhandled promise "
  "rejection in checkout.bundle.js. The customer retried on two machines "
  "and sees the same behaviour on both."
)
stack = "Traceback (most recent call last):\\n" + "".join(
  '  File "/srv/app/handlers/checkout.py", line %d, in place_order\\n'
  "    total = compute_total(cart, promotions, region_tax_table)\\n" % (40 + i)
  for i in range(20)
) + "ValueError: unsupported currency pair (USD, XAG)"
url = "https://shop.example.com/checkout/session/" + "a1b2c3d4e5f6" * 12
blob = bytes(range(256)) * 41  # ~10.2 KB
statuses = ["open", "triaged", "in progress", "resolved"]
tickets = [
  (i, "2026-06-%02d 09:%02d:00" % (i, 13 + i), "Customer %d" % i,
   "customer%d@example.com" % i, regions[i % 4], ["low", "normal", "high"][i % 3],
   statuses[i % 4], "Checkout button unresponsive on Safari (case %d)" % i,
   description, stack, url, blob,
   None if i % 2 else "Rolled back the payments iframe CSP change.")
  for i in range(1, 9)
]
db.executemany("insert into tickets values (%s)" % ",".join("?" * 13), tickets)
db.commit(); db.close()
`;
  execFileSync("uv", ["run", "--prerelease=allow", "python3", "-c", py]);
}

export async function startServer() {
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
export function stopServer(child) {
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
