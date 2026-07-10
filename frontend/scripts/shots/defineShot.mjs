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
//   themes  — default ["light"]; the runner re-runs this shot once per theme.
//             Opt a shot into a dark twin with themes: ["light", "dark"] — the
//             dark run writes `<name>.dark.png`.
//
// Theme isolation: localStorage is shared across every page in the context
// (same origin), so a dark leg's `paperTheme` write would persist onto the next
// light page and silently theme it dark. To stay hermetic, EACH leg seeds the
// key for its own theme via a page-scoped addInitScript — "dark" for dark,
// removed for light. Paper defaults to light regardless of OS, so a light leg
// resolves with the key absent to "light" — identical to the theme-unaware
// baseline, so its PNG is byte-identical. The dark leg sets an explicit "dark",
// which the resolver honors independent of the OS. emulateMedia is already
// per-page (a fresh page inherits the context default, light), so it's only set
// dark on the dark leg to match the explicit dark choice's OS chrome.
//
// ids keys available (from seed()): richId, linkId, mentionId, inlineTagId, slashId,
//   embedPickerId, inlineDbId, inlineTableId, inlineRowId, blockDbId,
//   blockTableId, blockRowId, blockColumnsId, sqlBlockId, sqlBlockHiddenId,
//   inlineValueId, codeBlockId.
import { gotoEditor, freezeVolatile } from "./helpers.mjs";
import { PAPER, out } from "./config.mjs";

export function defineShot(desc) {
  const {
    name,
    order = 0,
    doc,
    goto,
    prepare,
    capture,
    freeze = true,
    themes = ["light"],
  } = desc;
  if (!name) throw new Error("defineShot: missing `name`");
  const run = async (ctx, ids, theme = "light") => {
    const page = await ctx.newPage();
    try {
      // Seed the real resolver path per-leg: the head script in paper_base.html
      // reads localStorage.paperTheme and stamps <html data-theme> before first
      // paint. Set it on BOTH themes (see the isolation note above) so a dark
      // leg's persisted write can't bleed onto the next light page.
      await page.addInitScript((t) => {
        try {
          if (t === "dark") localStorage.setItem("paperTheme", "dark");
          else localStorage.removeItem("paperTheme");
        } catch {
          // localStorage not available on this document — skip.
        }
      }, theme);
      if (theme === "dark") {
        // Match the explicit dark choice's OS-level chrome (belt-and-braces —
        // the explicit "dark" already renders dark regardless of OS).
        await page.emulateMedia({ colorScheme: "dark" });
      }
      const suffix = theme === "dark" ? ".dark" : "";
      if (goto) await goto(page, { ids, ctx });
      else if (doc) await gotoEditor(page, ids[doc]);
      else await page.goto(PAPER);
      if (prepare) await prepare(page, { ids, ctx });
      if (freeze) await freezeVolatile(page);
      if (capture) await capture(page, out(name, suffix), { ids, ctx });
      else await page.screenshot({ path: out(name, suffix) });
    } finally {
      await page.close();
    }
  };
  run.shotName = name;
  run.order = order;
  run.themes = themes;
  return run;
}
