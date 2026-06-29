// Entry for the published read-only page (`/-/paper/doc/<id>/publish`).
//
// Deliberately tiny: it imports the published stylesheet and the live-block
// hydrator and nothing else — no ProseMirror, no collab, no Svelte editor. The
// server only injects this bundle when the published page has live data blocks
// (an all-frozen page ships zero JS).
import "../../lib/published.css";
import { hydratePublished } from "../../lib/publishHydrate";

function start(): void {
  void hydratePublished(document);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}
