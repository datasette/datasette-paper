/**
 * @feat task-assign: unit tests for the `<profile-todos>` web component —
 * fetch URL + status, per-state rendering (rows / cap+footer / empty / error),
 * overdue tint, multi-assignee chip resolution, and payload escaping (every
 * field reaches the DOM via textContent). Importing ./main registers the
 * element; each test appends a fresh instance to fire connectedCallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import "./main";
import type { TodoRow } from "../../lib/todos";

function todo(extra: Partial<TodoRow>): TodoRow {
  return {
    doc_id: 1,
    doc_name: "Doc",
    doc_url: "/-/paper/doc/1",
    ordinal: 0,
    text: "fix the door",
    checked: false,
    section: [],
    assignees: ["pat"],
    assignees_inherited: false,
    due: null,
    due_inherited: false,
    ...extra,
  };
}

/** fetch that answers the todos GET with `{todos}` and any resolve POST with
 *  a name map derived from the requested ids. */
function okTodos(todos: TodoRow[], names: Record<string, string> = {}) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (typeof url === "string" && url.includes("/actors/resolve")) {
      const ids = (JSON.parse(String(init?.body ?? "{}")).ids ?? []) as string[];
      const actors: Record<string, { name: string; avatar_url: null }> = {};
      for (const id of ids) actors[id] = { name: names[id] ?? id, avatar_url: null };
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ actors }) } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ todos }) } as Response);
  });
}

async function mount(attrs: Record<string, string>): Promise<HTMLElement> {
  const el = document.createElement("profile-todos");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = okTodos([]);
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("<profile-todos>", () => {
  it("fetches open todos with the URL-encoded actor id", async () => {
    await mount({ "actor-id": "alice smith" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("/-/paper/api/profile/alice%20smith/todos?status=open");
  });

  it("renders a row: checkbox, text link, doc badge", async () => {
    fetchMock = okTodos([todo({ text: "ship it", doc_name: "Plan", doc_url: "/-/paper/doc/7" })]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });
    await vi.waitFor(() => expect(el.querySelector(".paper-todos-item")).not.toBeNull());

    const check = el.querySelector<HTMLInputElement>(".paper-todos-check")!;
    expect(check.type).toBe("checkbox");
    expect(check.disabled).toBe(true);
    expect(check.checked).toBe(false);

    const link = el.querySelector<HTMLAnchorElement>(".paper-todos-text")!;
    expect(link.textContent).toBe("ship it");
    expect(link.getAttribute("href")).toBe("/-/paper/doc/7");
    expect(el.querySelector(".paper-todos-doc")!.textContent).toBe("Plan");
  });

  it("tints an overdue due date", async () => {
    fetchMock = okTodos([todo({ due: { date: "2020-01-01", time: null, tz: null } })]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });
    await vi.waitFor(() => expect(el.querySelector(".paper-todos-due")).not.toBeNull());
    expect(el.querySelector(".paper-todos-due-overdue")).not.toBeNull();
  });

  it("struck-through renders a done row (status=all could return one)", async () => {
    fetchMock = okTodos([todo({ checked: true })]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });
    await vi.waitFor(() => expect(el.querySelector(".paper-todos-text")).not.toBeNull());
    expect(el.querySelector<HTMLInputElement>(".paper-todos-check")!.checked).toBe(true);
    expect(el.querySelector(".paper-todos-done")).not.toBeNull();
  });

  it("shows multi-assignee chips and resolves their names", async () => {
    fetchMock = okTodos(
      [todo({ assignees: ["pat", "dev"] })],
      { pat: "Pat Smith", dev: "Dev Jones" },
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "pat" });
    await vi.waitFor(() => expect(el.querySelectorAll(".paper-todos-assignee").length).toBe(2));
    await vi.waitFor(() => {
      const labels = [...el.querySelectorAll(".paper-todos-assignee")].map((c) => c.textContent);
      expect(labels).toEqual(["@Pat Smith", "@Dev Jones"]);
    });
  });

  it("hides a direct single-assignee chip on the actor's own profile", async () => {
    fetchMock = okTodos([todo({ assignees: ["pat"] })]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "pat", "is-own-profile": "true" });
    await vi.waitFor(() => expect(el.querySelector(".paper-todos-item")).not.toBeNull());
    expect(el.querySelector(".paper-todos-assignee")).toBeNull();
  });

  it("shows a muted inherited single-assignee chip on another profile", async () => {
    fetchMock = okTodos(
      [todo({ assignees: ["pat"], assignees_inherited: true })],
      { pat: "Pat Smith" },
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "pat", "is-own-profile": "false" });
    await vi.waitFor(() => expect(el.querySelector(".paper-todos-assignee")).not.toBeNull());
    const chip = el.querySelector<HTMLElement>(".paper-todos-assignee")!;
    expect(chip.classList.contains("paper-todos-assignee-inherited")).toBe(true);
    expect(chip.title).toBe("Inherited from a parent task");
  });

  it("sends the required JSON content-type on the TODO request", async () => {
    await mount({ "actor-id": "alice" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][1]).toEqual({
      headers: { "Content-Type": "application/json" },
    });
  });

  it("caps at 10 rows and labels the footer with the total", async () => {
    const many = Array.from({ length: 14 }, (_, i) => todo({ ordinal: i, text: `t${i}` }));
    fetchMock = okTodos(many);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });
    await vi.waitFor(() => expect(el.querySelector(".paper-todos-more")).not.toBeNull());
    expect(el.querySelectorAll(".paper-todos-item").length).toBe(10);
    const more = el.querySelector<HTMLAnchorElement>(".paper-todos-more")!;
    expect(more.textContent).toBe("All 14 TODOs →");
    expect(more.getAttribute("href")).toBe("/-/paper/todos?actor=alice");
  });

  it("labels the footer plainly when not capped", async () => {
    fetchMock = okTodos([todo({})]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });
    await vi.waitFor(() => expect(el.querySelector(".paper-todos-more")).not.toBeNull());
    expect(el.querySelector(".paper-todos-more")!.textContent).toBe("All TODOs →");
  });

  it("shows the empty state", async () => {
    const el = await mount({ "actor-id": "alice" });
    await vi.waitFor(() =>
      expect(el.querySelector(".paper-profile-message")!.textContent).toBe("No open TODOs."),
    );
  });

  it("escapes untrusted task text and doc name (no script injected)", async () => {
    const nasty = "<script>alert(1)</script>";
    fetchMock = okTodos([todo({ text: nasty, doc_name: nasty })]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });
    await vi.waitFor(() => expect(el.querySelector(".paper-todos-text")).not.toBeNull());
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector(".paper-todos-text")!.textContent).toBe(nasty);
    expect(el.querySelector(".paper-todos-doc")!.textContent).toBe(nasty);
  });

  it("shows error copy on a non-OK response", async () => {
    fetchMock = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });
    await vi.waitFor(() =>
      expect(el.querySelector(".paper-profile-message")!.textContent).toBe("Could not load TODOs."),
    );
  });

  it("shows error copy (no unhandled rejection) on a rejected fetch", async () => {
    fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });
    await vi.waitFor(() =>
      expect(el.querySelector(".paper-profile-message")!.textContent).toBe("Could not load TODOs."),
    );
  });

  it("does not fetch when actor-id is absent", async () => {
    const el = await mount({});
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(el.querySelector(".paper-profile-message")).not.toBeNull();
  });
});
