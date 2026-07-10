// @feat code-lang-picker: tests corner-button edit gating, filter, keyboard selection, plain-text, unknown label, teardown
/**
 * NodeView tests for code_block's language-picker chrome: edit-mode gating
 * (view.editable flips live via setProps), corner-button label resolution
 * (known/unknown/null), the type-to-filter popup (filterLanguages plus
 * Arrow/Enter selection and the "Plain text" row writing null), and
 * outside-click/Escape teardown across repeated open/close cycles.
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import { CodeBlockView, filterLanguages, languageLabel } from "../codeBlockView";

const mounted: EditorView[] = [];

function mount(language: string | null, text = "print(1)") {
  let editable = true;
  const doc = schema.node("doc", null, [
    schema.nodes.code_block.create({ language }, text ? schema.text(text) : []),
  ]);
  const place = document.createElement("div");
  place.className = "editor-host";
  document.body.appendChild(place);
  const view = new EditorView(place, {
    state: EditorState.create({ doc }),
    editable: () => editable,
    nodeViews: {
      code_block: (node, v, getPos) =>
        new CodeBlockView(node, v, getPos as () => number | undefined),
    },
  });
  mounted.push(view);
  const setEditable = (next: boolean) => {
    editable = next;
    view.setProps({ editable: () => editable });
  };
  return { view, setEditable };
}

describe("filterLanguages", () => {
  it("returns every language plus a leading Plain text row on an empty query", () => {
    const rows = filterLanguages("");
    expect(rows[0]).toEqual({ language: null, label: "Plain text" });
    expect(rows.some((r) => r.language === "python")).toBe(true);
  });

  it("filters by substring across label/id/alias", () => {
    const labels = filterLanguages("ja").map((r) => r.label);
    expect(labels).toContain("Java");
    expect(labels).toContain("JavaScript");
    expect(labels).not.toContain("Plain text");
  });

  it("matches the Plain text row by its own label", () => {
    expect(filterLanguages("plain")).toEqual([{ language: null, label: "Plain text" }]);
  });

  it("returns nothing for a query matching no language", () => {
    expect(filterLanguages("zzzznotalang")).toEqual([]);
  });
});

describe("languageLabel", () => {
  it("resolves a known language to its display label", () => {
    expect(languageLabel("python")).toBe("Python");
  });

  it("falls back to the raw token for an unknown language", () => {
    expect(languageLabel("brainfuck")).toBe("brainfuck");
  });

  it("is 'plain text' for null", () => {
    expect(languageLabel(null)).toBe("plain text");
  });
});

describe("CodeBlockView", () => {
  afterEach(() => {
    for (const v of mounted.splice(0)) v.destroy();
  });

  it("shows chrome in edit mode and hides it live when editable flips", async () => {
    const { view, setEditable } = mount("python");
    expect(view.dom.querySelector(".pm-code-block--editable")).not.toBeNull();
    setEditable(false);
    // The MutationObserver watching `contenteditable` fires as a microtask.
    await Promise.resolve();
    expect(view.dom.querySelector(".pm-code-block--editable")).toBeNull();
    setEditable(true);
    await Promise.resolve();
    expect(view.dom.querySelector(".pm-code-block--editable")).not.toBeNull();
  });

  it("labels the button with the resolved language, raw token if unknown, plain text if null", () => {
    expect(mount("python").view.dom.querySelector(".pm-code-block-lang-btn")?.textContent).toContain(
      "Python",
    );
    expect(
      mount("brainfuck").view.dom.querySelector(".pm-code-block-lang-btn")?.textContent,
    ).toContain("brainfuck");
    expect(mount(null).view.dom.querySelector(".pm-code-block-lang-btn")?.textContent).toContain(
      "plain text",
    );
  });

  it("filters on type and selects with Enter, dispatching a setNodeMarkup", () => {
    const { view } = mount("python");
    const btn = view.dom.querySelector(".pm-code-block-lang-btn") as HTMLButtonElement;
    btn.click();
    const popup = view.dom.querySelector(".pm-code-block-lang-popup");
    expect(popup?.classList.contains("pm-code-block-lang-popup--open")).toBe(true);

    const input = view.dom.querySelector(".pm-code-block-lang-input") as HTMLInputElement;
    input.value = "ja";
    input.dispatchEvent(new Event("input"));
    const items = () => [...view.dom.querySelectorAll(".pm-code-block-lang-item")];
    expect(items().map((i) => i.textContent)).toEqual(["JavaScript", "Java"]);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    const node = view.state.doc.firstChild!;
    expect(node.attrs.language).toBe("java");
    // Selection closes the popup and refocuses the editor.
    expect(popup?.classList.contains("pm-code-block-lang-popup--open")).toBe(false);
  });

  it("selecting Plain text writes language: null", () => {
    const { view } = mount("python");
    const btn = view.dom.querySelector(".pm-code-block-lang-btn") as HTMLButtonElement;
    btn.click();
    view.dom.querySelector(".pm-code-block-lang-input")!.dispatchEvent(new Event("input"));
    const plain = [...view.dom.querySelectorAll(".pm-code-block-lang-item")].find(
      (el) => el.textContent === "Plain text",
    ) as HTMLButtonElement;
    plain.click();
    expect(view.state.doc.firstChild!.attrs.language).toBeNull();
  });

  it("Escape and outside-click both close the popup, cleanly across repeated cycles", () => {
    const { view } = mount("python");
    const btn = view.dom.querySelector(".pm-code-block-lang-btn") as HTMLButtonElement;
    const isOpen = () =>
      view.dom
        .querySelector(".pm-code-block-lang-popup")!
        .classList.contains("pm-code-block-lang-popup--open");

    btn.click();
    expect(isOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(isOpen()).toBe(false);

    btn.click();
    expect(isOpen()).toBe(true);
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(isOpen()).toBe(false);

    // A third open/close cycle with no leaked listeners still behaves.
    btn.click();
    expect(isOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(isOpen()).toBe(false);
  });

  it("never renders reserved fence tokens in the picker list", () => {
    const rows = filterLanguages("");
    const reserved = ["source", "paper-embed", "paper-toc", "paper-table"];
    expect(rows.some((r) => r.language && reserved.includes(r.language))).toBe(false);
  });

  it("disables spellcheck on the static <pre>, keeps chrome non-editable", () => {
    const { view } = mount("python");
    const pre = view.dom.querySelector("pre") as HTMLPreElement;
    expect(pre.getAttribute("spellcheck")).toBe("false");
    expect(pre.getAttribute("autocorrect")).toBe("off");
    expect(pre.getAttribute("autocapitalize")).toBe("off");
    expect(view.dom.querySelector(".pm-code-block-lang-btn")!.getAttribute("contenteditable")).toBe(
      "false",
    );
    expect(view.dom.querySelector(".pm-code-block-lang-popup")!.getAttribute("contenteditable")).toBe(
      "false",
    );
    // The contentDOM itself carries no override, so it inherits the real
    // editable state from the editor root rather than being hardcoded.
    expect(view.dom.querySelector(".pm-code-block pre code")!.getAttribute("contenteditable")).toBeNull();
  });
});
