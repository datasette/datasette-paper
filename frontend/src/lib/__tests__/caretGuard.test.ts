/**
 * guardChromeMousedown: chrome mousedowns are preventDefault-ed (a caret
 * no-op), while interactive controls and allow-listed content regions keep
 * their native default (focus, dropdown, text selection).
 */
import { describe, expect, it } from "vitest";
import { guardChromeMousedown } from "../caretGuard";

function press(el: Element): MouseEvent {
  const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

function build(): { root: HTMLElement } {
  const root = document.createElement("div");
  root.innerHTML = `
    <div class="head">
      <span class="label">vendors</span>
      <select class="db"><option>data</option></select>
      <button class="run">Run</button>
      <label class="pick"><input type="checkbox" />name</label>
      <a class="open" href="#">open</a>
    </div>
    <div class="scroll"><table><tbody><tr><td>cell</td></tr></tbody></table></div>
    <div class="footer"><span class="info">showing 10</span></div>
  `;
  document.body.appendChild(root);
  return { root };
}

describe("guardChromeMousedown", () => {
  it("preventDefaults mousedown on chrome (padding, labels, plain spans)", () => {
    const { root } = build();
    guardChromeMousedown(root, ".scroll");
    expect(press(root.querySelector(".label")!).defaultPrevented).toBe(true);
    expect(press(root.querySelector(".info")!).defaultPrevented).toBe(true);
    expect(press(root.querySelector(".head")!).defaultPrevented).toBe(true);
    root.remove();
  });

  it("leaves interactive controls alone (select, button, label, input, a)", () => {
    const { root } = build();
    guardChromeMousedown(root, ".scroll");
    expect(press(root.querySelector("select")!).defaultPrevented).toBe(false);
    expect(press(root.querySelector("button")!).defaultPrevented).toBe(false);
    expect(press(root.querySelector("label.pick")!).defaultPrevented).toBe(false);
    expect(press(root.querySelector("input")!).defaultPrevented).toBe(false);
    expect(press(root.querySelector("a")!).defaultPrevented).toBe(false);
    root.remove();
  });

  it("leaves the allow-listed content region alone (native text selection)", () => {
    const { root } = build();
    guardChromeMousedown(root, ".scroll");
    expect(press(root.querySelector("td")!).defaultPrevented).toBe(false);
    root.remove();
  });

  it("guards everything non-interactive when no allow selector is given", () => {
    const { root } = build();
    guardChromeMousedown(root);
    expect(press(root.querySelector("td")!).defaultPrevented).toBe(true);
    expect(press(root.querySelector("button")!).defaultPrevented).toBe(false);
    root.remove();
  });
});
