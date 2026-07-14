/**
 * @feat breadcrumbs: the crumb's paper switcher — chevron opens a searchable
 * popup of viewable papers (server order preserved), the current doc is
 * marked, filtering narrows, and rows are real anchors (Enter delegates to
 * the active row's anchor click, per the jsdom anchor-spy pattern).
 *
 * Like PaperIndexUi.test.ts, the component talks through the typed
 * openapi-fetch `client`, so we mock that module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock("../client", () => ({ client: { GET: getMock } }));

import CrumbSwitcher from "../CrumbSwitcher.svelte";

const DOCS = [
  { id: 3, name: "Roadmap", updated_at: "2026-07-14T10:00:00Z" },
  { id: 1, name: "Q3 Planning", updated_at: "2026-07-13T10:00:00Z" },
  { id: 2, name: "Meeting Notes", updated_at: "2026-07-01T10:00:00Z" },
];

beforeEach(() => {
  getMock.mockResolvedValue({ data: DOCS, error: undefined });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  getMock.mockReset();
});

async function open() {
  render(CrumbSwitcher, { props: { docId: "1" } });
  await fireEvent.click(screen.getByRole("button", { name: "Switch paper" }));
  // Let the load() promise resolve and the list render.
  await screen.findByText("Roadmap");
}

describe("CrumbSwitcher", () => {
  it("opens a popup listing papers in server (updated_at DESC) order", async () => {
    await open();
    expect(getMock).toHaveBeenCalledWith("/-/paper/api/docs");
    const names = screen
      .getAllByRole("link")
      .map((a) => a.textContent!.trim());
    expect(names).toEqual(["Roadmap", "Q3 Planning", "Meeting Notes"]);
  });

  it("rows are anchors to the doc pages and the current doc is marked", async () => {
    await open();
    const links = screen.getAllByRole("link") as HTMLAnchorElement[];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/-/paper/doc/3",
      "/-/paper/doc/1",
      "/-/paper/doc/2",
    ]);
    // docId=1 → the Q3 Planning row carries the current marker (check icon).
    expect(links[1].classList.contains("current")).toBe(true);
    expect(links[1].querySelector("svg")).not.toBeNull();
    expect(links[0].classList.contains("current")).toBe(false);
    expect(links[0].querySelector("svg")).toBeNull();
  });

  it("filters by substring, case-insensitive", async () => {
    await open();
    await fireEvent.input(screen.getByLabelText("Search papers"), {
      target: { value: "notes" },
    });
    const names = screen
      .getAllByRole("link")
      .map((a) => a.textContent!.trim());
    expect(names).toEqual(["Meeting Notes"]);
  });

  it("shows an empty state when nothing matches", async () => {
    await open();
    await fireEvent.input(screen.getByLabelText("Search papers"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No matching papers")).toBeTruthy();
  });

  it("ArrowDown + Enter clicks the active row's anchor", async () => {
    const clicked: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this.getAttribute("href")!);
      });
    await open();
    const input = screen.getByLabelText("Search papers");
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(clicked).toEqual(["/-/paper/doc/1"]);
    clickSpy.mockRestore();
  });

  it("Escape closes the popup", async () => {
    await open();
    await fireEvent.keyDown(screen.getByLabelText("Search papers"), {
      key: "Escape",
    });
    expect(screen.queryByLabelText("Search papers")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Switch paper" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("surfaces a load failure instead of an empty list", async () => {
    getMock.mockResolvedValue({ data: undefined, error: { status: 500 } });
    render(CrumbSwitcher, { props: { docId: "1" } });
    await fireEvent.click(
      screen.getByRole("button", { name: "Switch paper" }),
    );
    expect(await screen.findByText("Couldn't load papers")).toBeTruthy();
  });
});
