/**
 * Platform detection shared by app keyboard labels and app-owned mac-only
 * bindings.
 */

/** Same sniff prosemirror-keymap / -commands / -example-setup use to resolve
 *  `Mod` (evaluated at their import, `prosemirror-keymap/dist/index.js:4`).
 *  App labels and app-owned mac-only bindings MUST use this, not a better
 *  detector (userAgent, `navigator.userAgentData`): a hint is only correct if
 *  it agrees with what PM bound. navigator is absent under SSR → non-mac;
 *  under vitest's jsdom `navigator.platform === ""` → non-mac. */
export const IS_MAC: boolean =
  typeof navigator !== "undefined" &&
  /Mac|iP(hone|[oa]d)/.test(navigator.platform);
