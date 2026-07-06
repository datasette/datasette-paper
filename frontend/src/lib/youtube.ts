/**
 * YouTube URL grammar, shared by the paste handler (youtubePaste.ts) and the
 * block NodeView (videoEmbedView.ts). The backend mirror lives in
 * datasette_paper/youtube.py — keep the two in step (same accepted URL shapes,
 * same canonical `watch?v=` output) so a markdown round-trip is stable.
 *
 * A `video_embed` node stores an opaque `provider` ("youtube" today) plus the
 * provider id and an optional start offset in seconds. Keeping the grammar out
 * here means adding another provider (Vimeo, …) later is a matcher + a render
 * branch, never a schema change.
 */

export interface YouTubeRef {
  videoId: string;
  /** Start offset in whole seconds, or null. */
  start: number | null;
}

// A YouTube video id is 11 chars of [A-Za-z0-9_-].
const VIDEO_ID_RE = /^[\w-]{11}$/;

// Hostnames we accept (with or without a leading `www.`/`m.`/`music.`).
const HOSTS = new Set([
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
]);

/** Strip a leading `www.` / `m.` / `music.` subdomain for host matching. */
function bareHost(hostname: string): string {
  return hostname.replace(/^(www\.|m\.|music\.)/, "").toLowerCase();
}

/**
 * Parse a `t` / `start` timestamp param into whole seconds. Accepts a bare
 * number of seconds (`90`, `90s`) or the colon-free duration form YouTube uses
 * (`1h2m3s`, `1m30s`). Returns null for anything unparseable or ≤ 0.
 */
function parseStart(raw: string | null): number | null {
  if (!raw) return null;
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return n > 0 ? n : null;
  }
  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const secs = Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return secs > 0 ? secs : null;
}

/**
 * Parse pasted text into a YouTube video ref, or null if it isn't a single
 * YouTube video URL. Watch / short-link / embed / shorts / live / v forms are
 * all accepted; a channel, playlist-only, or search URL returns null.
 */
export function parseYouTubeUrl(text: string): YouTubeRef | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = bareHost(url.hostname);
  if (!HOSTS.has(host)) return null;

  const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  let videoId: string | null = null;
  if (host === "youtu.be") {
    // youtu.be/<id>
    videoId = segments[0] ?? null;
  } else if (segments.length === 0 || segments[0] === "watch") {
    // youtube.com/watch?v=<id>
    videoId = url.searchParams.get("v");
  } else if (["embed", "shorts", "live", "v"].includes(segments[0])) {
    // youtube.com/{embed,shorts,live,v}/<id>
    videoId = segments[1] ?? null;
  }
  if (!videoId || !VIDEO_ID_RE.test(videoId)) return null;

  const start = parseStart(url.searchParams.get("t") ?? url.searchParams.get("start"));
  return { videoId, start };
}

/** Canonical watch URL — the single form the markdown serializer emits. */
export function youtubeWatchUrl(videoId: string, start: number | null): string {
  const base = `https://www.youtube.com/watch?v=${videoId}`;
  return start && start > 0 ? `${base}&t=${start}s` : base;
}

/** Privacy-enhanced embed URL for the click-to-play iframe. */
export function youtubeEmbedUrl(videoId: string, start: number | null): string {
  const params = new URLSearchParams({ autoplay: "1", rel: "0" });
  if (start && start > 0) params.set("start", String(start));
  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

/** Facade thumbnail served by YouTube's static image host. */
export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}
