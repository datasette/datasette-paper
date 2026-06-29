/**
 * URL-scheme allowlist + render-sink neutralization (stored-XSS fix).
 *
 * The unit cases pin the allowlist in `safeHref.ts`; the schema cases prove
 * the `link` mark and `image` node `toDOM` — the actual DOM a viewer clicks —
 * route their `href`/`src` through it, so a `javascript:` URL planted on a
 * mark (by the Mod-K prompt, the `[t](href)` input rule, or a crafted collab
 * step) renders inert. Mirrors tests/test_pm_schema.py — keep the allowlist in
 * lock-step with datasette_paper/pm_schema.py.
 */
import { describe, it, expect } from "vitest";
import { schema } from "../schema";
import { isSafeHref, isSafeImageSrc, safeHref, safeImageSrc } from "../safeHref";

const DANGEROUS_HREFS = [
  "javascript:alert(1)",
  "JavaScript:alert(1)", // case-insensitive
  "  javascript:alert(1)", // leading whitespace stripped
  "java\tscript:alert(1)", // embedded control char stripped
  "vbscript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
];

const ALLOWED_HREFS = [
  "https://example.com/x",
  "http://example.com",
  "mailto:a@b.com",
  "tel:+15551234",
  "#section",
  "/relative/path",
  "//example.com",
];

describe("safeHref / isSafeHref", () => {
  it.each(DANGEROUS_HREFS)("neutralizes %s", (href) => {
    expect(isSafeHref(href)).toBe(false);
    expect(safeHref(href)).toBe("#");
  });

  it.each(ALLOWED_HREFS)("passes through %s", (href) => {
    expect(isSafeHref(href)).toBe(true);
    expect(safeHref(href)).toBe(href);
  });

  it("treats empty / nullish as inert (#)", () => {
    expect(safeHref(undefined)).toBe("#");
    expect(safeHref("")).toBe("#");
  });
});

describe("safeImageSrc / isSafeImageSrc", () => {
  it("allows inline data:image URIs", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(isSafeImageSrc(png)).toBe(true);
    expect(safeImageSrc(png)).toBe(png);
  });

  it("blocks scriptable data: / javascript: srcs", () => {
    expect(isSafeImageSrc("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeImageSrc("javascript:alert(1)")).toBe(false);
    expect(safeImageSrc("javascript:alert(1)")).toBe("#");
  });

  it("allows http(s) and relative srcs", () => {
    expect(safeImageSrc("https://example.com/y.png")).toBe("https://example.com/y.png");
    expect(safeImageSrc("/static/y.png")).toBe("/static/y.png");
  });
});

describe("link mark render sink (toDOM)", () => {
  function linkHref(href: string): string {
    const mark = schema.marks.link.create({ href });
    const dom = schema.marks.link.spec.toDOM!(mark, true) as [
      string,
      Record<string, string>,
      number,
    ];
    return dom[1].href;
  }

  it("neutralizes a javascript: href", () => {
    expect(linkHref("javascript:alert(1)")).toBe("#");
  });

  it("neutralizes JavaScript: (case) and data:text/html", () => {
    expect(linkHref("JavaScript:alert(1)")).toBe("#");
    expect(linkHref("data:text/html,<script>alert(1)</script>")).toBe("#");
  });

  it("passes through mailto: and https:", () => {
    expect(linkHref("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(linkHref("https://example.com/ok")).toBe("https://example.com/ok");
  });
});

describe("image node render sink (toDOM)", () => {
  function imgSrc(src: string): string {
    const node = schema.nodes.image.create({ src });
    const dom = schema.nodes.image.spec.toDOM!(node) as [
      string,
      Record<string, string>,
    ];
    return dom[1].src;
  }

  it("neutralizes a javascript: src", () => {
    expect(imgSrc("javascript:alert(1)")).toBe("#");
  });

  it("keeps an inline data:image src", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(imgSrc(png)).toBe(png);
  });
});
