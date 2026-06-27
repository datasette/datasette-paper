import { describe, it, expect } from "vitest";
import { EditorState } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { Slice, Fragment } from "prosemirror-model";
import { schema } from "../schema";
import {
  readImageFile,
  imageFilesFromDataTransfer,
  insertImage,
  isOversizedDataUrl,
  stripOversizedPastedImages,
  MAX_IMAGE_BYTES,
  ImageTooLargeError,
} from "../image";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function pngFile(name = "shot.png"): File {
  // Bytes don't matter for readAsDataURL beyond MIME; use a 1-byte payload.
  return new File([new Uint8Array([0])], name, { type: "image/png" });
}

// Minimal DataTransfer-shaped stub — jsdom's DataTransfer doesn't let you stage
// files, so we hand-roll the two shapes the helper reads (.items / .files).
function dataTransferWithItems(files: File[]): DataTransfer {
  return {
    items: files.map((f) => ({
      kind: "file",
      type: f.type,
      getAsFile: () => f,
    })),
    files: [],
  } as unknown as DataTransfer;
}

function dataTransferWithFiles(files: File[]): DataTransfer {
  return { items: [], files } as unknown as DataTransfer;
}

describe("imageFilesFromDataTransfer", () => {
  it("returns nothing for a null transfer or non-image content", () => {
    expect(imageFilesFromDataTransfer(null)).toEqual([]);
    const textOnly = {
      items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      files: [],
    } as unknown as DataTransfer;
    expect(imageFilesFromDataTransfer(textOnly)).toEqual([]);
  });

  it("reads image files from .items (the Safari clipboard path)", () => {
    const f = pngFile();
    expect(imageFilesFromDataTransfer(dataTransferWithItems([f]))).toEqual([f]);
  });

  it("falls back to .files when .items has none", () => {
    const f = pngFile();
    expect(imageFilesFromDataTransfer(dataTransferWithFiles([f]))).toEqual([f]);
  });

  it("ignores non-image items", () => {
    const mixed = {
      items: [
        { kind: "file", type: "application/pdf", getAsFile: () => pngFile("x.pdf") },
        { kind: "file", type: "image/png", getAsFile: () => pngFile() },
      ],
      files: [],
    } as unknown as DataTransfer;
    expect(imageFilesFromDataTransfer(mixed).map((f) => f.type)).toEqual(["image/png"]);
  });
});

describe("readImageFile", () => {
  it("reads an image File into a data: URL", async () => {
    const url = await readImageFile(pngFile());
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects non-image files", async () => {
    const txt = new File(["hi"], "a.txt", { type: "text/plain" });
    await expect(readImageFile(txt)).rejects.toThrow(/not an image/i);
  });

  it("rejects files over the size cap", async () => {
    const big = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "big.png", {
      type: "image/png",
    });
    await expect(readImageFile(big)).rejects.toBeInstanceOf(ImageTooLargeError);
  });
});

describe("isOversizedDataUrl", () => {
  it("flags an oversized data: URL", () => {
    const big = "data:image/png;base64," + "A".repeat(MAX_IMAGE_BYTES + 1);
    expect(isOversizedDataUrl(big)).toBe(true);
  });

  it("passes a small data: URL", () => {
    expect(isOversizedDataUrl(PNG_DATA_URL)).toBe(false);
  });

  it("never flags an http(s) ref regardless of length", () => {
    const longRef = "https://example.com/" + "x".repeat(MAX_IMAGE_BYTES);
    expect(isOversizedDataUrl(longRef)).toBe(false);
  });

  it("handles null/undefined", () => {
    expect(isOversizedDataUrl(null)).toBe(false);
    expect(isOversizedDataUrl(undefined)).toBe(false);
  });
});

describe("stripOversizedPastedImages", () => {
  const bigSrc = "data:image/png;base64," + "A".repeat(MAX_IMAGE_BYTES + 1);

  function sliceWith(...srcs: string[]): Slice {
    const nodes = srcs.map((src) => schema.nodes.image.create({ src }));
    // Wrap in a paragraph so the slice is a realistic pasted block.
    const para = schema.nodes.paragraph.create(null, Fragment.fromArray(nodes));
    return new Slice(Fragment.fromArray([para]), 0, 0);
  }

  function imageSrcs(slice: Slice): string[] {
    const out: string[] = [];
    slice.content.descendants((node) => {
      if (node.type === schema.nodes.image) out.push(node.attrs.src as string);
    });
    return out;
  }

  it("drops an oversized data: image and notifies once", () => {
    let notified = 0;
    let count = 0;
    const result = stripOversizedPastedImages(sliceWith(bigSrc), (n) => {
      notified += 1;
      count = n;
    });
    expect(imageSrcs(result)).toEqual([]);
    expect(notified).toBe(1);
    expect(count).toBe(1);
  });

  it("keeps small inline images and http(s) refs", () => {
    const result = stripOversizedPastedImages(
      sliceWith(bigSrc, PNG_DATA_URL, "https://example.com/y.png"),
    );
    expect(imageSrcs(result)).toEqual([PNG_DATA_URL, "https://example.com/y.png"]);
  });

  it("returns the same slice (and no notice) when nothing is oversized", () => {
    let notified = false;
    const slice = sliceWith(PNG_DATA_URL);
    const result = stripOversizedPastedImages(slice, () => (notified = true));
    expect(result).toBe(slice);
    expect(notified).toBe(false);
  });

  it("passes an empty slice through untouched", () => {
    expect(stripOversizedPastedImages(Slice.empty)).toBe(Slice.empty);
  });
});

describe("insertImage", () => {
  it("returns true and dispatches a transaction", () => {
    const state = EditorState.create({
      doc: schema.node("doc", null, [schema.nodes.paragraph.create()]),
      schema,
    });
    let dispatched: Transaction | null = null;
    const ok = insertImage(PNG_DATA_URL, "a cat")(state, (tr) => (dispatched = tr));
    expect(ok).toBe(true);
    expect(dispatched).not.toBeNull();
  });

  it("produces a valid image node when applied", () => {
    const state = EditorState.create({
      doc: schema.node("doc", null, [schema.nodes.paragraph.create()]),
      schema,
    });
    let next = state;
    insertImage(PNG_DATA_URL, "a cat")(state, (tr) => (next = state.apply(tr)));
    let img: import("prosemirror-model").Node | null = null;
    next.doc.descendants((node) => {
      if (node.type.name === "image") img = node;
    });
    expect(img).not.toBeNull();
    expect(img!.attrs.src).toBe(PNG_DATA_URL);
    expect(img!.attrs.alt).toBe("a cat");
  });

  it("stores null alt when none is given", () => {
    const state = EditorState.create({
      doc: schema.node("doc", null, [schema.nodes.paragraph.create()]),
      schema,
    });
    let next = state;
    insertImage(PNG_DATA_URL)(state, (tr) => (next = state.apply(tr)));
    let img: import("prosemirror-model").Node | null = null;
    next.doc.descendants((node) => {
      if (node.type.name === "image") img = node;
    });
    expect(img!.attrs.alt).toBeNull();
  });
});
