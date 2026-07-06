/**
 * "Drop a YouTube link" paste handling: a lone YouTube video URL pasted into
 * its own empty top-level paragraph becomes a `video_embed` block (rendered by
 * videoEmbedView.ts as a lite facade). Anywhere else — mid-text, a nested
 * context, or text that isn't a bare YouTube URL — it returns false so the
 * default paste runs and the URL becomes an ordinary link. This mirrors the
 * "empty top paragraph → block" surface rule the Datasette paste handler uses
 * (datasettePaste.ts), reusing its `isEmptyTopParagraph` predicate.
 *
 * @feat video-embed: paste of a lone YouTube URL in its own paragraph -> video_embed block
 */
import type { EditorView } from "prosemirror-view";
import { schema } from "./schema";
import { parseYouTubeUrl } from "./youtube";
import { isEmptyTopParagraph } from "./datasettePaste";

/**
 * EditorView `handlePaste` hook. Returns true to claim the paste (insert a
 * video_embed block), false to let the default paste run.
 */
export function handleYouTubePaste(view: EditorView, event: ClipboardEvent): boolean {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  const ref = parseYouTubeUrl(text);
  if (ref == null) return false;
  // Block embed only when the URL is alone in its own paragraph; otherwise let
  // it fall through to the normal link paste.
  if (!isEmptyTopParagraph(view.state)) return false;

  const node = schema.nodes.video_embed.create({
    provider: "youtube",
    videoId: ref.videoId,
    start: ref.start,
  });
  const $from = view.state.selection.$from;
  const from = $from.before($from.depth);
  const to = $from.after($from.depth);
  view.dispatch(view.state.tr.replaceRangeWith(from, to, node).scrollIntoView());
  return true;
}
