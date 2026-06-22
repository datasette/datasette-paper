/**
 * LinkGraph tests, two layers:
 *
 *  - PURE: `computeDegree` over a small fixture (directionless count).
 *  - RENDER: mount LinkGraph with a stubbed `fetch` and a mocked d3-force
 *    whose fake simulation assigns deterministic x/y to each node and whose
 *    chained force methods return `this`. We then assert the SVG renders N
 *    node circles + M edge lines, that a node carries its title, and that a
 *    node anchor points at /-/paper/doc/{id} (the click target, asserted via
 *    href rather than stubbing navigation).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";

// Mock the dynamically imported d3-force module with a tiny deterministic
// fake. `forceSimulation` lays nodes out on a horizontal line and resolves
// link source/target ids into the node objects (mirroring real d3). Every
// force builder returns a chainable stub.
vi.mock("d3-force", () => {
  function chain() {
    const c: Record<string, () => unknown> = {};
    for (const m of ["id", "distance", "strength"]) c[m] = () => c;
    return c;
  }
  return {
    forceSimulation: (simNodes: { id: number; x: number; y: number }[]) => {
      simNodes.forEach((n, i) => {
        n.x = 50 + i * 100;
        n.y = 100;
      });
      type Link = { source: unknown; target: unknown };
      const sim: {
        _links: Link[];
        force: (name: string, f?: { _links?: Link[] }) => typeof sim;
        tick: () => typeof sim;
        stop: () => typeof sim;
      } = {
        _links: [],
        force(_name, f) {
          if (f && f._links) sim._links = f._links;
          // Resolve link endpoint ids to node refs once links are attached.
          for (const l of sim._links) {
            if (typeof l.source === "number") {
              l.source = simNodes.find((n) => n.id === l.source);
            }
            if (typeof l.target === "number") {
              l.target = simNodes.find((n) => n.id === l.target);
            }
          }
          return sim;
        },
        tick() {
          return sim;
        },
        stop() {
          return sim;
        },
      };
      return sim;
    },
    forceLink: (links: unknown[]) => {
      const f: Record<string, unknown> = { _links: links };
      f.id = () => f;
      f.distance = () => f;
      return f;
    },
    forceManyBody: () => chain(),
    forceCenter: () => chain(),
    forceCollide: () => chain(),
  };
});

import LinkGraph, { computeDegree } from "../LinkGraph.svelte";

type Graph = {
  nodes: { id: number; title: string; state: string }[];
  edges: { source: number; target: number; occurrences: number }[];
};

let graphPayload: Graph;

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  graphPayload = { nodes: [], edges: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse(graphPayload))),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("computeDegree", () => {
  it("counts incident edges per node (directionless)", () => {
    const nodes = [{ id: 1 }, { id: 2 }, { id: 3 }];
    // A->B, A->C, B->C  (1=A, 2=B, 3=C)
    const edges = [
      { source: 1, target: 2 },
      { source: 1, target: 3 },
      { source: 2, target: 3 },
    ];
    const deg = computeDegree(nodes, edges);
    expect(deg.get(1)).toBe(2);
    expect(deg.get(2)).toBe(2);
    expect(deg.get(3)).toBe(2);
  });

  it("includes isolated nodes with degree 0", () => {
    const deg = computeDegree([{ id: 1 }, { id: 9 }], [{ source: 1, target: 1 }]);
    expect(deg.get(9)).toBe(0);
    // A self-edge bumps the endpoint twice.
    expect(deg.get(1)).toBe(2);
  });
});

describe("LinkGraph render", () => {
  async function waitForGraph(): Promise<void> {
    await vi.waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  }

  it("shows an empty-state message when there are no nodes", async () => {
    graphPayload = { nodes: [], edges: [] };
    render(LinkGraph);
    await waitForGraph();
    expect(screen.getByText("No links yet.")).toBeTruthy();
  });

  it("renders N circles + M lines and a node title, with doc-link hrefs", async () => {
    graphPayload = {
      nodes: [
        { id: 1, title: "Alpha", state: "active" },
        { id: 2, title: "Beta", state: "active" },
        { id: 3, title: "Gamma", state: "archived" },
      ],
      edges: [
        { source: 1, target: 2, occurrences: 1 },
        { source: 2, target: 3, occurrences: 3 },
      ],
    };
    const { container } = render(LinkGraph);
    await waitForGraph();
    await vi.waitFor(() =>
      expect(container.querySelectorAll("circle").length).toBe(3),
    );

    expect(container.querySelectorAll("circle").length).toBe(3);
    expect(container.querySelectorAll("line").length).toBe(2);

    // A node carries its title (both as label text and <title> tooltip).
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);

    // Node anchors point at the doc route — the click target.
    const anchors = Array.from(container.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(anchors).toContain("/-/paper/doc/1");
    expect(anchors).toContain("/-/paper/doc/3");
  });
});
