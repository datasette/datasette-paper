/**
 * CmSqlField tests — the standalone CM SQL field behind the Sources panel's
 * draft editor. Real `@codemirror/*` under jsdom (the codeBlockCm.test.ts
 * precedent); the mounted view is reached via `core.EditorView.findFromDOM`
 * so the eslint import chokepoint stays honest.
 *
 * @feat source: proves the panel field mounts CM with the initial draft,
 * host-driven setValue doesn't echo onChange, and user edits do fire it
 */
import { describe, it, expect, vi } from "vitest";
import { CmSqlField } from "../cmSqlField";
import { loadCmCore } from "../cmCore";

async function mount(doc: string, onChange = vi.fn(), onSubmit?: () => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const field = await CmSqlField.create({ parent: host, doc, onChange, onSubmit });
  return { host, field, onChange };
}

describe("CmSqlField", () => {
  it("mounts a CM editor over the initial doc", async () => {
    const { host, field } = await mount("select 1 as total");
    expect(host.querySelector(".cm-editor")).toBeTruthy();
    expect(field.getValue()).toBe("select 1 as total");
    field.destroy();
    host.remove();
  });

  it("setValue replaces the doc without echoing onChange", async () => {
    const { host, field, onChange } = await mount("select 1");
    field.setValue("select 2 as n");
    expect(field.getValue()).toBe("select 2 as n");
    // Host-driven writes must not report back — the host already knows.
    expect(onChange).not.toHaveBeenCalled();
    field.destroy();
    host.remove();
  });

  it("reports user edits through onChange with the full doc", async () => {
    const { host, field, onChange } = await mount("select 1");
    const core = await loadCmCore();
    const cm = core.EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    cm.dispatch({ changes: { from: 7, to: 8, insert: "42" } });
    expect(onChange).toHaveBeenCalledWith("select 42");
    expect(field.getValue()).toBe("select 42");
    field.destroy();
    host.remove();
  });

  it("destroy unmounts the editor from the host", async () => {
    const { host, field } = await mount("select 1");
    field.destroy();
    expect(host.querySelector(".cm-editor")).toBeNull();
    host.remove();
  });
});
