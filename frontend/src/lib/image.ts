/**
 * Image helpers shared by the paste/drop handlers (collab.ts) and the
 * toolbar insert-image dialog (ImageDialog.svelte).
 *
 * Images are stored inline as `data:` URIs in the `image` node's `src` attr —
 * there is no upload/blob backend. The schema's `image` node (inherited from
 * prosemirror-schema-basic) accepts any string src, and the markdown
 * serializer/parser already round-trip `![alt](src)`, so no schema change is
 * needed. CSS in editor.css (`.ProseMirror img { max-width: 100% }`) keeps a
 * large image from overflowing the document.
 */
import { schema } from "./schema";
import { Fragment, Slice } from "prosemirror-model";
import type { Node as PMNode } from "prosemirror-model";
import type { Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

// Guard against pasting/uploading something enormous — a multi-megabyte data
// URI rides the collab step log and SSE broadcast, so cap it. base64 inflates
// bytes ~33%, so the on-the-wire string is a bit larger than this.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Whether an image `src` is an inline `data:` URL whose encoded length exceeds
 * the limit. Ordinary `http(s)` refs are cheap pointers and always pass —
 * the cap is specifically about bytes inlined into the doc. The string length
 * is the on-the-wire cost (what actually rides the step log / SSE), so we
 * compare it directly against the byte budget.
 */
export function isOversizedDataUrl(src: string | null | undefined): boolean {
  if (!src || !src.startsWith("data:")) return false;
  return src.length > MAX_IMAGE_BYTES;
}

/**
 * Walk a pasted `Fragment`, dropping any `image` node whose `data:` src is over
 * the limit. A truncated base64 string is a corrupt image, so we drop the node
 * outright rather than trim it. Returns the (possibly rewritten) fragment and a
 * count of how many images were removed so the caller can surface a notice.
 */
function stripOversizedImagesFromFragment(fragment: Fragment): {
  fragment: Fragment;
  removed: number;
} {
  const children: PMNode[] = [];
  let removed = 0;
  fragment.forEach((node) => {
    if (node.type === schema.nodes.image && isOversizedDataUrl(node.attrs.src)) {
      removed += 1;
      return;
    }
    if (node.childCount === 0) {
      children.push(node);
      return;
    }
    const result = stripOversizedImagesFromFragment(node.content);
    removed += result.removed;
    children.push(node.copy(result.fragment));
  });
  return { fragment: Fragment.fromArray(children), removed };
}

/**
 * `transformPasted` guard: strip oversized inline-`data:` images from a pasted
 * `Slice`. `onRemoved` fires (once, with the count) when anything was dropped,
 * for surfacing a brief "image too large" notice.
 */
export function stripOversizedPastedImages(
  slice: Slice,
  onRemoved?: (count: number) => void,
): Slice {
  if (slice.size === 0) return slice;
  const { fragment, removed } = stripOversizedImagesFromFragment(slice.content);
  if (!removed) return slice;
  if (onRemoved) onRemoved(removed);
  return new Slice(fragment, slice.openStart, slice.openEnd);
}

export class ImageTooLargeError extends Error {
  constructor() {
    super("Image is too large (maximum 8 MB).");
    this.name = "ImageTooLargeError";
  }
}

/** Read an image File into a `data:` URL. Rejects non-images and oversized files. */
export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Not an image file."));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new ImageTooLargeError());
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}

/**
 * Pull image files out of a clipboard/drop `DataTransfer`.
 *
 * Prefers `.items` (`getAsFile`) because that's where Safari exposes a pasted
 * image — Safari often puts only the image *file* on the clipboard with no
 * `text/html`, so the browser's default HTML-paste parsing (which is what made
 * image paste "work in Firefox only") finds nothing. Reading the file here is
 * what makes paste work cross-browser.
 */
export function imageFilesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items && dt.items.length) {
    for (const item of dt.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (!out.length && dt.files && dt.files.length) {
    for (const f of Array.from(dt.files)) {
      if (f.type.startsWith("image/")) out.push(f);
    }
  }
  return out;
}

/** A ProseMirror command that inserts an `image` node at the current selection. */
export function insertImage(src: string, alt = ""): Command {
  return (state, dispatch) => {
    const node = schema.nodes.image.create({ src, alt: alt || null });
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

/**
 * EditorView `handlePaste` hook: if the clipboard carries image file(s), read
 * them into data URIs and insert. Returns true to claim the paste (suppressing
 * the default), false to let text/HTML paste fall through unchanged.
 */
export function handleImagePaste(view: EditorView, event: ClipboardEvent): boolean {
  const files = imageFilesFromDataTransfer(event.clipboardData);
  if (!files.length) return false;
  void insertImageFiles(view, files);
  return true;
}

/** EditorView `handleDrop` hook for dropped image files. */
export function handleImageDrop(view: EditorView, event: DragEvent): boolean {
  const files = imageFilesFromDataTransfer(event.dataTransfer);
  if (!files.length) return false;
  event.preventDefault();
  const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
  void insertImageFiles(view, files, coords?.pos);
  return true;
}

/**
 * Read files → data URIs and dispatch the inserts. Async (FileReader), so it
 * reads `view.state` fresh at dispatch time. `at` is an optional explicit
 * position (drop point); otherwise images replace the current selection.
 */
async function insertImageFiles(
  view: EditorView,
  files: File[],
  at?: number,
): Promise<void> {
  let srcs: string[];
  try {
    srcs = await Promise.all(files.map(readImageFile));
  } catch (err) {
    window.alert(err instanceof Error ? err.message : "Could not read the image.");
    return;
  }
  if (at === undefined) {
    for (const src of srcs) insertImage(src)(view.state, view.dispatch);
    return;
  }
  let tr = view.state.tr;
  let pos = Math.min(at, view.state.doc.content.size);
  for (const src of srcs) {
    const node = schema.nodes.image.create({ src, alt: null });
    tr = tr.insert(pos, node);
    pos += node.nodeSize;
  }
  view.dispatch(tr.scrollIntoView());
}
