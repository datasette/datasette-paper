/**
 * Tests for the curated language registry: alias resolution,
 * case-insensitivity, disjointness from RESERVED_FENCE_TOKENS, and loader
 * memoization (one in-flight promise per language).
 */
import { describe, it, expect, vi } from "vitest";
import {
  resolveLanguage,
  allLanguages,
  RESERVED_FENCE_TOKENS,
} from "../languages";

vi.mock("@lezer/python", () => ({ parser: { configure: vi.fn() } }));
vi.mock("@codemirror/lang-python", () => ({
  python: vi.fn(() => ({ support: "fake" })),
}));

describe("registry shape", () => {
  it("has every id and alias lowercase and unique across the registry", () => {
    const seen = new Set<string>();
    for (const lang of allLanguages()) {
      for (const token of [lang.id, ...lang.aliases]) {
        expect(token).toBe(token.toLowerCase());
        expect(seen.has(token)).toBe(false);
        seen.add(token);
      }
    }
  });

  it("has no id or alias colliding with RESERVED_FENCE_TOKENS", () => {
    for (const lang of allLanguages()) {
      for (const token of [lang.id, ...lang.aliases]) {
        expect(RESERVED_FENCE_TOKENS.has(token)).toBe(false);
      }
    }
  });

  it("includes the v1 preset ids", () => {
    const ids = allLanguages().map((lang) => lang.id);
    expect(ids).toEqual(["python", "javascript", "sql", "json", "yaml", "bash"]);
  });
});

describe("resolveLanguage", () => {
  it("resolves an id case-insensitively", () => {
    expect(resolveLanguage("python")?.id).toBe("python");
    expect(resolveLanguage("Python")?.id).toBe("python");
    expect(resolveLanguage("PYTHON")?.id).toBe("python");
  });

  it("resolves an alias case-insensitively", () => {
    expect(resolveLanguage("py")?.id).toBe("python");
    expect(resolveLanguage("PY")?.id).toBe("python");
  });

  it("resolves the multi-alias bash entry", () => {
    expect(resolveLanguage("sh")?.id).toBe("bash");
    expect(resolveLanguage("shell")?.id).toBe("bash");
    expect(resolveLanguage("ZSH")?.id).toBe("bash");
  });

  it("returns undefined for an unknown token", () => {
    expect(resolveLanguage("brainfuck")).toBeUndefined();
    expect(resolveLanguage("foolang")).toBeUndefined();
  });

  it("returns undefined for null or empty input", () => {
    expect(resolveLanguage(null)).toBeUndefined();
    expect(resolveLanguage("")).toBeUndefined();
  });

  it("returns undefined for a reserved fence token", () => {
    for (const token of RESERVED_FENCE_TOKENS) {
      expect(resolveLanguage(token)).toBeUndefined();
    }
  });
});

describe("loader memoization", () => {
  it("shares one in-flight promise across concurrent highlight() calls", () => {
    const python = resolveLanguage("python")!;
    const first = python.highlight();
    const second = python.highlight();
    expect(first).toBe(second);
  });

  it("shares one in-flight promise across concurrent cm() calls", () => {
    const python = resolveLanguage("python")!;
    const first = python.cm();
    const second = python.cm();
    expect(first).toBe(second);
  });

  it("resolves to the same cached value on repeated calls after resolution", async () => {
    const python = resolveLanguage("python")!;
    const first = await python.highlight();
    const second = await python.highlight();
    expect(second).toBe(first);
  });
});
