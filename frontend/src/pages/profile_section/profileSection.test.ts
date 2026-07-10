/**
 * @feat profile-papers: unit tests for the `<profile-papers>` web component —
 * fetch URL encoding, per-state rendering (list badges / empty / own-profile /
 * error), and payload escaping. Importing ./main registers the element; each
 * test appends a fresh instance to fire `connectedCallback`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import "./main";

interface DocFixture {
  id: number;
  name: string;
  url: string;
  created: boolean;
  last_edited_at: string | null;
  created_at: string;
  updated_at: string;
}

function doc(extra: Partial<DocFixture>): DocFixture {
  return {
    id: 1,
    name: "My Paper",
    url: "/-/paper/doc/1",
    created: true,
    last_edited_at: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...extra,
  };
}

/** Answer fetch with an OK JSON `{docs}` envelope. */
function okDocs(docs: DocFixture[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ docs }),
  } as Response);
}

async function mount(attrs: Record<string, string>): Promise<HTMLElement> {
  const el = document.createElement("profile-papers");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = okDocs([]);
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("<profile-papers>", () => {
  it("fetches the endpoint with the URL-encoded actor id", async () => {
    fetchMock = okDocs([doc({})]);
    global.fetch = fetchMock as unknown as typeof fetch;

    await mount({ "actor-id": "alice smith" });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("/-/paper/api/profile/alice%20smith/docs");
    expect(url).not.toContain(" ");
  });

  it("renders a created-only row with a 'Created' badge", async () => {
    fetchMock = okDocs([
      doc({ name: "Design doc", url: "/-/paper/doc/7", created: true, last_edited_at: null }),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });

    await vi.waitFor(() =>
      expect(el.querySelector(".paper-profile-item")).not.toBeNull(),
    );
    const link = el.querySelector<HTMLAnchorElement>(".paper-profile-link")!;
    expect(link.textContent).toBe("Design doc");
    expect(link.getAttribute("href")).toBe("/-/paper/doc/7");
    expect(el.querySelector(".paper-profile-badge")!.textContent).toBe("Created");
  });

  it("renders an edited-only row with an 'Edited' badge", async () => {
    fetchMock = okDocs([
      doc({ created: false, last_edited_at: "2026-07-08T00:00:00.000Z" }),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });

    await vi.waitFor(() =>
      expect(el.querySelector(".paper-profile-badge")).not.toBeNull(),
    );
    expect(el.querySelector(".paper-profile-badge")!.textContent).toBe("Edited");
  });

  it("renders a created+edited row with a 'Created · edited' badge", async () => {
    fetchMock = okDocs([
      doc({ created: true, last_edited_at: "2026-07-08T00:00:00.000Z" }),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });

    await vi.waitFor(() =>
      expect(el.querySelector(".paper-profile-badge")).not.toBeNull(),
    );
    expect(el.querySelector(".paper-profile-badge")!.textContent).toBe(
      "Created · edited",
    );
  });

  it("escapes a doc name containing markup (no script element injected)", async () => {
    const nasty = "<script>alert(1)</script>";
    fetchMock = okDocs([doc({ name: nasty })]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });

    await vi.waitFor(() =>
      expect(el.querySelector(".paper-profile-link")).not.toBeNull(),
    );
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector(".paper-profile-link")!.textContent).toBe(nasty);
  });

  it("shows the neutral empty copy for another actor's empty profile", async () => {
    fetchMock = okDocs([]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });

    await vi.waitFor(() =>
      expect(el.querySelector(".paper-profile-message")!.textContent).toBe(
        "No papers yet.",
      ),
    );
  });

  it("shows the own-profile empty copy when is-own-profile is true", async () => {
    fetchMock = okDocs([]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice", "is-own-profile": "true" });

    await vi.waitFor(() =>
      expect(el.querySelector(".paper-profile-message")!.textContent).toBe(
        "You haven't created any papers yet.",
      ),
    );
  });

  it("shows error copy on a non-OK response", async () => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });

    await vi.waitFor(() =>
      expect(el.querySelector(".paper-profile-message")!.textContent).toBe(
        "Could not load papers.",
      ),
    );
  });

  it("shows error copy (no unhandled rejection) on a rejected fetch", async () => {
    fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    global.fetch = fetchMock as unknown as typeof fetch;

    const el = await mount({ "actor-id": "alice" });

    await vi.waitFor(() =>
      expect(el.querySelector(".paper-profile-message")!.textContent).toBe(
        "Could not load papers.",
      ),
    );
  });

  it("does not fetch when actor-id is absent", async () => {
    const el = await mount({});

    // Give any (erroneous) async work a chance to run.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(el.querySelector(".paper-profile-message")).not.toBeNull();
  });
});
