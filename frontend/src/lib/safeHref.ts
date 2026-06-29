/**
 * URL-scheme allowlists for anything that becomes a DOM `href`/`src`.
 *
 * Mirrors `datasette_paper/pm_schema.py` (`is_safe_href` / `is_safe_image_src`
 * / `safe_href` / `safe_image_src`) — keep the two in lock-step. The render
 * sink (the `link` mark and `image` node `toDOM` in `schema.ts`) routes every
 * href/src through these so a `javascript:` / `vbscript:` / `data:text/html`
 * URL planted on a link mark — by the Mod-K prompt, the `[t](href)` input
 * rule, or a hand-crafted collab step that bypasses the UI entirely — renders
 * inert instead of executing in the Datasette origin when a viewer clicks it.
 *
 * The allowlist is intentionally narrow: an attacker only needs ONE scheme
 * that runs script, so we enumerate the safe ones rather than blocklisting the
 * dangerous ones. ASCII control + space chars are stripped before the scheme
 * is read, matching how the URL parser ignores them — otherwise `java\tscript:`
 * (or an embedded newline) would smuggle a blocked scheme past a naive
 * `startsWith` check.
 */

const ALLOWED_HREF_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const ALLOWED_IMAGE_SCHEMES = new Set(["http", "https"]);
// scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
// Strip ASCII C0 controls + space (U+0000-U+0020) the URL parser ignores.
const CTRL_WS_RE = /[\u0000-\u0020]/g;

function schemeOf(cleaned: string): string | null {
  const m = SCHEME_RE.exec(cleaned);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Whether a link `href` is safe to emit: an allowlisted scheme
 * (http/https/mailto/tel), an in-page `#fragment`, or a same-document
 * relative path. A scheme-less reference (no `:` before the first `/`, `?`,
 * `#`) is treated as relative and allowed. Anything else (notably
 * `javascript:` / `vbscript:` / `data:`) is unsafe.
 */
export function isSafeHref(href: string | null | undefined): boolean {
  if (!href) return true; // nothing to exploit; `safeHref` renders it as "#"
  const cleaned = href.replace(CTRL_WS_RE, "");
  if (!cleaned) return true;
  if (cleaned.startsWith("#")) return true;
  if (cleaned.startsWith("/") && !cleaned.startsWith("//")) return true;
  const scheme = schemeOf(cleaned);
  if (scheme === null) return true; // scheme-less relative reference
  return ALLOWED_HREF_SCHEMES.has(scheme);
}

/**
 * Whether an image `src` is safe to emit. Same rules as {@link isSafeHref}
 * minus mailto/tel, plus inline `data:image/...` URIs — paper stores pasted
 * images inline as `data:image/png;base64,…` (see `image.ts`), so those must
 * pass while `data:text/html` / `javascript:` are still rejected.
 */
export function isSafeImageSrc(src: string | null | undefined): boolean {
  if (!src) return true;
  const cleaned = src.replace(CTRL_WS_RE, "");
  if (!cleaned) return true;
  if (/^data:image\//i.test(cleaned)) return true;
  if (cleaned.startsWith("/") && !cleaned.startsWith("//")) return true;
  const scheme = schemeOf(cleaned);
  if (scheme === null) return true;
  return ALLOWED_IMAGE_SCHEMES.has(scheme);
}

/** A link `href` if safe, else `"#"`. The render-sink sanitizer. */
export function safeHref(href: string | null | undefined): string {
  return href && isSafeHref(href) ? href : "#";
}

/** An image `src` if safe, else `"#"`. The render-sink sanitizer. */
export function safeImageSrc(src: string | null | undefined): string {
  return src && isSafeImageSrc(src) ? src : "#";
}
