// defineShot turns a declarative descriptor into the `async (ctx, ids) => {…}`
// the runner calls, owning the per-shot boilerplate: open a fresh page →
// navigate → interact → freeze → capture → close.
//
// Descriptor fields:
//   name    (required) — output PNG base name; MUST equal the shot's file name
//                        (asserted by the runner).
//   order   (required) — run sequence (ascending). Matters only when two shots
//                        share a *mutable* doc: a shot that types into a doc
//                        must run AFTER any shot that screenshots that doc
//                        clean. Independent shots can use any value. The runner
//                        sorts by (order, name).
//   doc     — an ids key (e.g. "richId"); navigates via gotoEditor(ids[doc]).
//   goto    — async (page, {ids, ctx}) for full navigation control (e.g. a
//             non-editor URL, or a POST-then-navigate); overrides `doc`. With
//             neither `doc` nor `goto`, the page opens the index (PAPER).
//   prepare — async (page, {ids, ctx}) interaction + waits after navigation.
//   freeze  — default true; set false to skip freezeVolatile (a few dialogs
//             that capture no volatile text and historically didn't freeze).
//   capture — async (page, file, {ids, ctx}); default = full-page screenshot.
//             Use for element / dialog / shotUnion captures.
//
// ids keys available (from seed()): richId, mentionId, inlineTagId, slashId,
//   embedPickerId, inlineDbId, inlineTableId, inlineRowId, blockDbId,
//   blockTableId, blockRowId, blockColumnsId, sqlBlockId, sqlBlockHiddenId,
//   inlineValueId.
import { gotoEditor, freezeVolatile } from "./helpers.mjs";
import { PAPER, out } from "./config.mjs";

export function defineShot(desc) {
  const { name, order = 0, doc, goto, prepare, capture, freeze = true } = desc;
  if (!name) throw new Error("defineShot: missing `name`");
  const run = async (ctx, ids) => {
    const page = await ctx.newPage();
    try {
      if (goto) await goto(page, { ids, ctx });
      else if (doc) await gotoEditor(page, ids[doc]);
      else await page.goto(PAPER);
      if (prepare) await prepare(page, { ids, ctx });
      if (freeze) await freezeVolatile(page);
      if (capture) await capture(page, out(name), { ids, ctx });
      else await page.screenshot({ path: out(name) });
    } finally {
      await page.close();
    }
  };
  run.shotName = name;
  run.order = order;
  return run;
}
