/**
 * Open a plain `<a>` link mark in a new tab when it's clicked in edit mode.
 *
 * The stock `link` mark renders a class-less `<a href title>` (`schema.ts`).
 * Inside ProseMirror's contenteditable a bare click on it is non-deterministic
 * across browsers (sometimes navigates same-tab, sometimes nothing), so we make
 * it explicit: in edit mode a click opens the URL in a new tab and nothing
 * else. Editing the link text is done by selecting around it / the keyboard.
 *
 * Scope is deliberately narrow — only the stock link mark. Every NodeView /
 * embed anchor (`pm-tag`, `pm-paper-link`, `pm-inline-embed`, the
 * `pm-block-embed` title/footer links, …) carries a `pm-*` class and owns its
 * own click behaviour, so a classed anchor is skipped untouched.
 *
 * View mode short-circuits: `view.editable` is false there, so the browser
 * follows the link natively (same-tab, like any published page).
 */

import { Plugin } from "prosemirror-state";

export function linkOpenPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        click(view, event) {
          if (!view.editable) return false; // view mode → native navigation
          const target = event.target as Element | null;
          const link = target?.closest?.("a[href]") as HTMLAnchorElement | null;
          if (!link || !view.dom.contains(link)) return false;
          // Plain link marks render class-less; any `pm-*` class means it's a
          // NodeView/embed anchor that owns its own click behaviour. Leave it.
          if (link.className.trim() !== "") return false;
          const href = link.getAttribute("href");
          if (!href) return false;
          // Open in a new tab, deterministically. preventDefault stops any
          // same-tab navigation / caret placement the browser would otherwise
          // do; return true so PM also treats the click as handled.
          event.preventDefault();
          window.open(href, "_blank", "noopener");
          return true;
        },
      },
    },
  });
}
