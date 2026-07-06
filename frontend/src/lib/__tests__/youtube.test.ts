/**
 * Tests for YouTube URL parsing, the canonical URL builders, and the
 * "lone YouTube URL in its own paragraph → video_embed block" paste handler.
 *
 * @feat video-embed: proves paste of a lone YouTube URL becomes a video_embed block
 */
import { describe, it, expect } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import {
  parseYouTubeUrl,
  youtubeWatchUrl,
  youtubeEmbedUrl,
  youtubeThumbnailUrl,
} from "../youtube";
import { handleYouTubePaste } from "../youtubePaste";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeUrl", () => {
  it("parses the watch, youtu.be, embed, shorts, live and v forms", () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/live/${ID}`,
      `https://www.youtube.com/v/${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
    ]) {
      expect(parseYouTubeUrl(url), url).toEqual({ videoId: ID, start: null });
    }
  });

  it("keeps other query params from breaking the watch form", () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&list=PL123`)).toEqual({
      videoId: ID,
      start: null,
    });
  });

  it("reads the start offset from t (seconds, s-suffixed, and duration form)", () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=90`)?.start).toBe(90);
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=90s`)?.start).toBe(90);
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=1m30s`)?.start).toBe(90);
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&start=45`)?.start).toBe(
      45,
    );
  });

  it("rejects non-video, non-youtube, and malformed URLs", () => {
    expect(parseYouTubeUrl("")).toBeNull();
    expect(parseYouTubeUrl("just some text")).toBeNull();
    expect(parseYouTubeUrl("https://vimeo.com/12345")).toBeNull();
    expect(parseYouTubeUrl("https://www.youtube.com/channel/UC123")).toBeNull();
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=tooshort`)).toBeNull();
    // A URL with surrounding text is not a bare paste.
    expect(parseYouTubeUrl(`watch https://youtu.be/${ID}`)).toBeNull();
  });
});

describe("URL builders", () => {
  it("emits a canonical watch URL, with an s-suffixed start", () => {
    expect(youtubeWatchUrl(ID, null)).toBe(`https://www.youtube.com/watch?v=${ID}`);
    expect(youtubeWatchUrl(ID, 90)).toBe(`https://www.youtube.com/watch?v=${ID}&t=90s`);
  });
  it("emits a privacy-enhanced embed URL and a thumbnail URL", () => {
    expect(youtubeEmbedUrl(ID, null)).toContain(
      `youtube-nocookie.com/embed/${ID}`,
    );
    expect(youtubeEmbedUrl(ID, 90)).toContain("start=90");
    expect(youtubeThumbnailUrl(ID)).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
  });
});

// --- paste handler --------------------------------------------------------

function emptyParaState(): EditorState {
  const doc = schema.node("doc", null, [schema.node("paragraph")]);
  const s = EditorState.create({ doc });
  return s.apply(s.tr.setSelection(TextSelection.atStart(s.doc)));
}

function midTextState(): EditorState {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("hello world")]),
  ]);
  const s = EditorState.create({ doc });
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, 4)));
}

function fakeView(state: EditorState): { view: EditorView; getDoc: () => EditorState } {
  let current = state;
  const view = {
    get state() {
      return current;
    },
    dispatch(tr: import("prosemirror-state").Transaction) {
      current = current.apply(tr);
    },
  } as unknown as EditorView;
  return { view, getDoc: () => current };
}

function pasteEvent(text: string): ClipboardEvent {
  return { clipboardData: { getData: () => text } } as unknown as ClipboardEvent;
}

describe("handleYouTubePaste", () => {
  it("replaces an empty top paragraph with a video_embed block", () => {
    const { view, getDoc } = fakeView(emptyParaState());
    const claimed = handleYouTubePaste(view, pasteEvent(`https://youtu.be/${ID}?t=42`));
    expect(claimed).toBe(true);
    const node = getDoc().doc.firstChild!;
    expect(node.type.name).toBe("video_embed");
    expect(node.attrs).toMatchObject({ provider: "youtube", videoId: ID, start: 42 });
  });

  it("leaves a mid-paragraph paste for the default (link) handler", () => {
    const { view, getDoc } = fakeView(midTextState());
    const claimed = handleYouTubePaste(view, pasteEvent(`https://youtu.be/${ID}`));
    expect(claimed).toBe(false);
    expect(getDoc().doc.firstChild!.type.name).toBe("paragraph");
  });

  it("ignores a non-YouTube paste", () => {
    const { view } = fakeView(emptyParaState());
    expect(handleYouTubePaste(view, pasteEvent("https://example.com"))).toBe(false);
  });
});
