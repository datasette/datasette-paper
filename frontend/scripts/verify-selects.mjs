import { chromium } from "@playwright/test";
import { VIEWPORT, ACTOR } from "./shots/config.mjs";
import { startServer, stopServer } from "./shots/server.mjs";
import { signActorCookie } from "./shots/cookie.mjs";
import { seed } from "./shots/seed.mjs";
import { gotoEditor } from "./shots/helpers.mjs";

const server = await startServer();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
await ctx.addCookies([
  { name: "ds_actor", value: signActorCookie(ACTOR), domain: "localhost", path: "/" },
]);
await ctx.addInitScript(() =>
  localStorage.setItem("datasette-debug-bar", JSON.stringify({ expanded: false })),
);
const ids = await seed(ctx);
const page = await ctx.newPage();

function anchorInfo(rootSel) {
  return page.evaluate((rs) => {
    const s = window.getSelection();
    const node = s && s.rangeCount ? s.anchorNode : null;
    const root = document.querySelector(rs);
    const el = node && node.nodeType === 3 ? node.parentElement : node;
    const active = document.activeElement;
    return {
      caretInNode: !!(node && root && root.contains(node)),
      anchorClass: el ? String(el.className || el.tagName) : null,
      // A visible blinking caret in code requires the CM/textbox to be focused.
      activeClass: active ? String(active.className || active.tagName) : null,
      activeInNode: !!(active && root && root.contains(active)),
    };
  }, rootSel);
}

async function clickAndReport(docId, rootSel, targetSel, waitSel) {
  await gotoEditor(page, ids[docId]);
  const root = page.locator(rootSel).first();
  await root.waitFor({ state: "visible", timeout: 10000 });
  if (waitSel) await root.locator(waitSel).first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  const t = root.locator(targetSel).first();
  if ((await t.count()) === 0) return { docId, targetSel, present: false };
  await t.click({ force: true });
  await page.keyboard.press("Escape").catch(() => {});
  return { docId, targetSel, present: true, ...(await anchorInfo(rootSel)) };
}

const out = [];
// The literal complaint: clicking a <select> in the chrome.
out.push(await clickAndReport("sqlBlockId", ".pm-sql-block", ".pm-sql-block-db"));
out.push(await clickAndReport("sqlBlockId", ".pm-sql-block", ".pm-sql-block-rows", ".pm-sql-block-footer"));
out.push(await clickAndReport("sqlBlockId", ".pm-sql-block", ".pm-sql-block-footer", ".pm-sql-block-footer"));
out.push(await clickAndReport("blockTableId", ".pm-block-embed", ".pm-block-embed-rows", ".pm-block-embed-footer"));

console.log(JSON.stringify(out, null, 2));
await browser.close();
stopServer(server);
