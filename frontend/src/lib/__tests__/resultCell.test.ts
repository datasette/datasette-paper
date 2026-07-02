// @feat result-cells: tests — truncation, blob size, expand toggle, XSS, fades
/**
 * Tests for the shared result-cell renderer: collapsed one-line display,
 * blob-as-size, the expand/collapse toggle, the CSS-overflow pass, and the
 * scroll-fade class sync. All values must land as text nodes (XSS rule).
 */
import { describe, it, expect } from "vitest";

import {
  CELL_DISPLAY_CAP,
  CELL_EXPAND_CAP,
  blobSize,
  cellDisplay,
  formatBytes,
  attachScrollFades,
  markOverflowingCells,
  renderResultValue,
} from "../resultCell";

const raf = () => new Promise((r) => requestAnimationFrame(r));

describe("cellDisplay", () => {
  it("passes short values through untouched", () => {
    expect(cellDisplay("hello")).toEqual({
      text: "hello",
      truncated: false,
      kind: "text",
    });
    expect(cellDisplay(42)).toEqual({ text: "42", truncated: false, kind: "text" });
    expect(cellDisplay(true)).toEqual({
      text: "true",
      truncated: false,
      kind: "text",
    });
  });

  it("caps long values with an ellipsis", () => {
    const d = cellDisplay("x".repeat(CELL_DISPLAY_CAP + 1));
    expect(d.truncated).toBe(true);
    expect(d.text).toBe("x".repeat(CELL_DISPLAY_CAP) + "…");
  });

  it("a value exactly at the cap is not truncated", () => {
    const d = cellDisplay("x".repeat(CELL_DISPLAY_CAP));
    expect(d.truncated).toBe(false);
    expect(d.text.endsWith("…")).toBe(false);
  });

  it("shows only the first line of a multi-line value", () => {
    expect(cellDisplay("first\nsecond\nthird")).toEqual({
      text: "first…",
      truncated: true,
      kind: "text",
    });
    // \r counts as a line break too (CRLF data).
    expect(cellDisplay("a\r\nb").text).toBe("a…");
  });

  it("null renders empty", () => {
    expect(cellDisplay(null)).toEqual({ text: "", truncated: false, kind: "null" });
  });

  it("blob envelopes render as their byte size, never the payload", () => {
    const d = cellDisplay({ $base64: true, encoded: "aGVsbG8=" }); // "hello"
    expect(d).toEqual({ text: "<binary — 5 B>", truncated: false, kind: "binary" });
  });
});

describe("formatBytes / blobSize", () => {
  it("formats byte counts deterministically", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(12_600)).toBe("12.3 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("derives decoded size from base64 length incl. padding", () => {
    expect(blobSize("")).toBe(0);
    expect(blobSize("aGVsbG8=")).toBe(5); // "hello"
    expect(blobSize("aGk=")).toBe(2); // "hi"
    expect(blobSize("aGV5YQ==")).toBe(4); // "heya"
  });
});

describe("renderResultValue", () => {
  const host = (value: Parameters<typeof renderResultValue>[1]) => {
    const td = document.createElement("td");
    renderResultValue(td, value);
    return td;
  };

  it("renders the value as a text node — markup stays inert", () => {
    const td = host('<img src=x onerror=alert(1)> & "quotes"');
    expect(td.querySelector("img")).toBeNull();
    expect(td.innerHTML).toContain("&lt;img");
    expect(td.textContent).toContain("<img src=x");
  });

  it("short values get no expand button and no title", () => {
    const td = host("short");
    expect(td.querySelector(".pm-result-cell-expand")).toBeNull();
    expect(td.title).toBe("");
  });

  it("truncated values get the toggle; expanding shows the full value", () => {
    const full = "line one\n" + "y".repeat(300);
    const td = host(full);
    const span = td.querySelector(".pm-result-cell")!;
    const btn = td.querySelector<HTMLButtonElement>(".pm-result-cell-expand")!;
    expect(span.textContent).toBe("line one…");
    expect(td.title).toBe(full); // small enough for the hover peek
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    btn.click();
    expect(td.classList.contains("is-expanded")).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(span.textContent).toBe(full);

    btn.click();
    expect(td.classList.contains("is-expanded")).toBe(false);
    expect(span.textContent).toBe("line one…");
  });

  it("expanded content is still a text node", () => {
    const td = host("safe\n<script>alert(1)</script>");
    td.querySelector<HTMLButtonElement>(".pm-result-cell-expand")!.click();
    expect(td.querySelector("script")).toBeNull();
    expect(td.textContent).toContain("<script>");
  });

  it("a value beyond the expand cap is cut with a note", () => {
    const full = "z".repeat(CELL_EXPAND_CAP + 10);
    const td = host(full);
    expect(td.title).toBe(""); // too big for a title tooltip
    td.querySelector<HTMLButtonElement>(".pm-result-cell-expand")!.click();
    const span = td.querySelector(".pm-result-cell")!;
    expect(span.textContent).toContain("value truncated — use export");
    expect(span.textContent!.length).toBeLessThan(CELL_EXPAND_CAP + 100);
  });

  it("blob cells show size only — no payload, no expand button", () => {
    const td = host({ $base64: true, encoded: "c2VjcmV0cGF5bG9hZA==" }); // "secretpayload"
    expect(td.textContent).toBe("<binary — 13 B>");
    expect(td.textContent).not.toContain("c2VjcmV0");
    expect(td.querySelector(".pm-result-cell-expand")).toBeNull();
    expect(td.querySelector<HTMLElement>(".pm-result-cell")!.dataset.kind).toBe(
      "binary",
    );
  });
});

describe("markOverflowingCells", () => {
  it("adds a class-only toggle to cells ellipsized purely by CSS", async () => {
    const table = document.createElement("table");
    const td = document.createElement("td");
    renderResultValue(td, "short but rendered wide");
    table.appendChild(td);
    const span = td.querySelector<HTMLElement>(".pm-result-cell")!;
    // jsdom has no layout — stub the metrics to fake a CSS ellipsis.
    Object.defineProperty(span, "scrollWidth", { value: 400 });
    Object.defineProperty(span, "clientWidth", { value: 260 });

    markOverflowingCells(table);
    await raf();

    const btn = td.querySelector<HTMLButtonElement>(".pm-result-cell-expand")!;
    expect(btn).not.toBeNull();
    expect(td.title).toBe("short but rendered wide");
    btn.click();
    expect(td.classList.contains("is-expanded")).toBe(true);
    expect(span.textContent).toBe("short but rendered wide");
  });

  it("leaves fitting cells and binary cells alone", async () => {
    const table = document.createElement("table");
    const fits = document.createElement("td");
    renderResultValue(fits, "fits");
    const blob = document.createElement("td");
    renderResultValue(blob, { $base64: true, encoded: "aGk=" });
    table.append(fits, blob);
    // Widths default to 0 == 0 in jsdom → "fits".

    markOverflowingCells(table);
    await raf();

    expect(table.querySelector(".pm-result-cell-expand")).toBeNull();
  });
});

describe("attachScrollFades", () => {
  const box = (scrollLeft: number) => {
    const wrap = document.createElement("div");
    const scroll = document.createElement("div");
    Object.defineProperty(scroll, "scrollWidth", { value: 1000 });
    Object.defineProperty(scroll, "clientWidth", { value: 400 });
    scroll.scrollLeft = scrollLeft;
    wrap.appendChild(scroll);
    return { wrap, scroll };
  };

  it("flags right overflow at rest, both mid-scroll, left at the end", async () => {
    const { wrap, scroll } = box(0);
    attachScrollFades(wrap, scroll);
    await raf();
    expect(wrap.classList.contains("has-overflow-right")).toBe(true);
    expect(wrap.classList.contains("has-overflow-left")).toBe(false);

    scroll.scrollLeft = 300;
    scroll.dispatchEvent(new Event("scroll"));
    expect(wrap.classList.contains("has-overflow-right")).toBe(true);
    expect(wrap.classList.contains("has-overflow-left")).toBe(true);

    scroll.scrollLeft = 600; // scrollWidth - clientWidth
    scroll.dispatchEvent(new Event("scroll"));
    expect(wrap.classList.contains("has-overflow-right")).toBe(false);
    expect(wrap.classList.contains("has-overflow-left")).toBe(true);
  });

  it("stays quiet when nothing overflows", async () => {
    const wrap = document.createElement("div");
    const scroll = document.createElement("div"); // all metrics 0
    wrap.appendChild(scroll);
    attachScrollFades(wrap, scroll);
    await raf();
    expect(wrap.classList.contains("has-overflow-right")).toBe(false);
    expect(wrap.classList.contains("has-overflow-left")).toBe(false);
  });
});
