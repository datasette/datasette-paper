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
// This file is a THIN RUNNER. The harness lives in shots/:
//   * shots/config.mjs   — constants + out(name)
//   * shots/server.mjs   — boot/teardown of the throwaway datasette
//   * shots/cookie.mjs   — signed ds_actor cookie (itsdangerous via uv)
//   * shots/seed.mjs     — seed() + the markdown fixtures
//   * shots/helpers.mjs  — freezeVolatile / gotoEditor / shotUnion / waiters
//   * shots/defineShot.mjs — the per-shot new-page → freeze → capture → close
//                            boilerplate
//   * shots/defs/<name>.mjs — ONE FILE PER SHOT, auto-discovered below. Adding
//                            a screenshot is a single new file here.
//
// Determinism notes:
//   * Papers are owned by ACTOR (a signed ds_actor cookie), so every shot gets
//     the full owner UI. `seed_owner_manager_grant` (routes/docs.py) wires this.
//   * `freezeVolatile()` rewrites moving text to fixed strings so a re-run with
//     no UI change produces no binary diff.
//   * A stability stylesheet hides the blinking caret and disables transitions.
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { OUT, VIEWPORT, ACTOR, BASE, out } from "./shots/config.mjs";
import { startServer, stopServer } from "./shots/server.mjs";
import { signActorCookie } from "./shots/cookie.mjs";
import { seed } from "./shots/seed.mjs";
import { STABILITY_CSS } from "./shots/helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Auto-discover the shots: every shots/defs/<name>.mjs default-exports a
// defineShot() descriptor. The file name IS the shot id — asserted below so a
// typo can't silently mis-name an output PNG. No central registry to edit.
async function discoverShots() {
  const dir = resolve(HERE, "shots/defs");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".mjs"));
  const shots = [];
  for (const f of files) {
    const name = f.replace(/\.mjs$/, "");
    const mod = await import(resolve(dir, f));
    const run = mod.default;
    if (typeof run !== "function") {
      throw new Error(`shots/defs/${f} must default-export a defineShot() descriptor`);
    }
    if (run.shotName !== name) {
      throw new Error(
        `shots/defs/${f}: declared name "${run.shotName}" != file name "${name}"`,
      );
    }
    shots.push({ name, run, order: run.order ?? 0 });
  }
  // Run sequence: by declared order, then name. Order is load-bearing only for
  // shots that share a mutable doc (see defineShot.mjs).
  shots.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return shots;
}

async function main() {
  const requested = new Set(process.argv.slice(2));

  const shots = await discoverShots();
  const names = shots.map((s) => s.name);
  const unknown = [...requested].filter((n) => !names.includes(n));
  if (unknown.length) {
    throw new Error(`unknown shot(s): ${unknown.join(", ")} (have: ${names.join(", ")})`);
  }
  const todo = requested.size ? shots.filter((s) => requested.has(s.name)) : shots;

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
    // single page wouldn't survive page.goto). This is what hides the installed
    // debug bar and the blinking caret in every shot.
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

    for (const { name, run } of todo) {
      await run(ctx, ids);
      console.log(`✓ ${name} → ${out(name)}`);
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
