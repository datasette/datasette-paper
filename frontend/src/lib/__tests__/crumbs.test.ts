// @feat breadcrumbs: setCrumbName rewrites the server-rendered crumb span and
// keeps document.title in step; a page without the span (not a doc page) only
// gets the title update.
import { describe, it, expect, afterEach } from "vitest";
import { setCrumbName } from "../crumbs";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("setCrumbName", () => {
  it("updates the crumb span text and document.title", () => {
    document.body.innerHTML =
      '<p class="crumbs paper-crumbs"><a href="/-/paper/">Papers</a> / ' +
      '<span id="paper-crumb-current">Old</span></p>';
    setCrumbName("New Name");
    expect(document.getElementById("paper-crumb-current")!.textContent).toBe(
      "New Name",
    );
    expect(document.title).toBe("New Name");
  });

  it("sets textContent, never HTML", () => {
    document.body.innerHTML = '<span id="paper-crumb-current">Old</span>';
    setCrumbName("<img src=x onerror=boom>");
    const el = document.getElementById("paper-crumb-current")!;
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe("<img src=x onerror=boom>");
  });

  it("is a no-op on the span when it is absent, but still titles the tab", () => {
    setCrumbName("Solo");
    expect(document.title).toBe("Solo");
  });
});
