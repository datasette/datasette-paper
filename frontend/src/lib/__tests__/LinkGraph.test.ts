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
import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";

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

import LinkGraph, {
  computeDegree,
  shouldAnimate,
  directedDegree,
  screenToGraph,
  clampScale,
  movedBeyondThreshold,
  isDimmed,
} from "../LinkGraph.svelte";

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

  it("sizes the viewBox to the container (ResizeObserver)", async () => {
    let roCb: (() => void) | null = null;
    let observed: Element | null = null;
    class FakeResizeObserver {
      constructor(cb: () => void) {
        roCb = cb;
      }
      observe(el: Element): void {
        observed = el;
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);

    graphPayload = {
      nodes: [{ id: 1, title: "Alpha", state: "active" }],
      edges: [],
    };
    const { container } = render(LinkGraph);
    await waitForGraph();

    // Report a stubbed container size, then fire the observer.
    Object.defineProperty(observed!, "clientWidth", {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(observed!, "clientHeight", {
      value: 600,
      configurable: true,
    });
    roCb!();

    await vi.waitFor(() =>
      expect(
        container.querySelector("svg.link-graph-svg")?.getAttribute("viewBox"),
      ).toBe("0 0 800 600"),
    );
  });
});

describe("shouldAnimate", () => {
  it("is false under reduced motion even with rAF", () => {
    expect(shouldAnimate(true, true)).toBe(false);
  });

  it("is false without rAF", () => {
    expect(shouldAnimate(false, false)).toBe(false);
  });

  it("is true with rAF and no motion preference", () => {
    expect(shouldAnimate(true, false)).toBe(true);
  });
});

describe("directedDegree", () => {
  it("splits forward links (out) from backlinks (in)", () => {
    // a->b, a->b, b->c  (1=a, 2=b, 3=c)
    const nodes = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const edges = [
      { source: 1, target: 2 },
      { source: 1, target: 2 },
      { source: 2, target: 3 },
    ];
    const deg = directedDegree(nodes, edges);
    expect(deg.get(1)).toEqual({ out: 2, in: 0 });
    expect(deg.get(2)).toEqual({ out: 1, in: 2 });
    expect(deg.get(3)).toEqual({ out: 0, in: 1 });
  });

  it("seeds isolated nodes with zero out/in", () => {
    const deg = directedDegree([{ id: 1 }, { id: 9 }], [{ source: 1, target: 1 }]);
    expect(deg.get(9)).toEqual({ out: 0, in: 0 });
  });
});

describe("screenToGraph / clampScale (zoom math)", () => {
  it("round-trips: the point under the cursor stays fixed across a zoom step", () => {
    // A zoom-about-cursor step recomputes translate so the graph point under
    // the pointer maps back to the same screen pixel.
    const px = 300;
    const py = 200;
    const t0 = { k: 1, x: 0, y: 0 };
    const g = screenToGraph(px, py, t0);
    const k = clampScale(t0.k * 1.1);
    const t1 = { k, x: px - g.x * k, y: py - g.y * k };
    // Same graph point projects back to the same screen pixel under t1.
    const back = { x: g.x * t1.k + t1.x, y: g.y * t1.k + t1.y };
    expect(back.x).toBeCloseTo(px, 6);
    expect(back.y).toBeCloseTo(py, 6);
    // And inverting t1 at that pixel returns the same graph point.
    const g2 = screenToGraph(px, py, t1);
    expect(g2.x).toBeCloseTo(g.x, 6);
    expect(g2.y).toBeCloseTo(g.y, 6);
  });

  it("clamps the scale to [0.2, 4]", () => {
    expect(clampScale(0.05)).toBe(0.2);
    expect(clampScale(10)).toBe(4);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(0.2)).toBe(0.2);
    expect(clampScale(4)).toBe(4);
  });
});

describe("movedBeyondThreshold", () => {
  it("is false for a jitter within the threshold, true past it", () => {
    expect(movedBeyondThreshold(0, 0)).toBe(false);
    expect(movedBeyondThreshold(2, 2)).toBe(false); // ~2.83px
    expect(movedBeyondThreshold(5, 0)).toBe(true);
    expect(movedBeyondThreshold(0, 10)).toBe(true);
  });

  it("honours a custom threshold", () => {
    expect(movedBeyondThreshold(8, 0, 10)).toBe(false);
    expect(movedBeyondThreshold(12, 0, 10)).toBe(true);
  });
});

describe("isDimmed", () => {
  const adjacency = new Set<number>([2]); // node 2 is adjacent to the selection

  it("dims nothing when there is no selection", () => {
    expect(isDimmed(1, null, adjacency)).toBe(false);
    expect(isDimmed(2, null, adjacency)).toBe(false);
  });

  it("keeps the selected node and its neighbours lit, dims the rest", () => {
    const selected = 1;
    expect(isDimmed(1, selected, adjacency)).toBe(false); // the selection
    expect(isDimmed(2, selected, adjacency)).toBe(false); // adjacent
    expect(isDimmed(3, selected, adjacency)).toBe(true); // unrelated
  });
});

describe("LinkGraph selection + metadata + directed edges", () => {
  async function waitForGraph(): Promise<void> {
    await vi.waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  }

  it("selecting a node fills the panel, dims the non-adjacent node, and edges carry arrowheads", async () => {
    graphPayload = {
      nodes: [
        {
          id: 1,
          title: "Alpha",
          state: "active",
          kind: "note",
          updated_at: "2020-01-01T00:00:00Z",
          tags: ["research", "ml"],
        },
        { id: 2, title: "Beta", state: "active", kind: "spec", updated_at: "2020-01-01T00:00:00Z", tags: [] },
        {
          id: 3,
          title: "Gamma",
          state: "archived",
          kind: "note",
          updated_at: "2020-01-01T00:00:00Z",
          tags: [],
        },
      ],
      // 1->2, 2->3  (so node 1's neighbourhood is {2}; node 3 is not adjacent)
      edges: [
        { source: 1, target: 2, occurrences: 1 },
        { source: 2, target: 3, occurrences: 2 },
      ],
    } as unknown as Graph;

    const { container } = render(LinkGraph);
    await waitForGraph();
    await vi.waitFor(() => expect(container.querySelectorAll("circle").length).toBe(3));

    // Every edge line points with a directed arrowhead marker.
    const lines = Array.from(container.querySelectorAll("line"));
    expect(lines.length).toBe(2);
    for (const l of lines) {
      expect(l.getAttribute("marker-end")).toBe("url(#link-graph-arrow)");
    }

    // Click node 1's anchor. detail:1 marks it a real mouse click (detail 0 =
    // keyboard, which the component lets fall through to native navigation).
    const anchor1 = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/-/paper/doc/1",
    )!;
    await fireEvent.click(anchor1, { detail: 1 });

    // The metadata panel now reflects node 1.
    const panel = container.querySelector(".link-graph-panel")!;
    const panelText = panel.textContent ?? "";
    expect(panel.querySelector(".link-graph-panel-title")?.textContent).toBe("Alpha");
    expect(panelText).toContain("note"); // kind
    expect(panelText).toContain("research"); // tag chip
    expect(panelText).toContain("ml"); // tag chip
    expect(panelText).toContain("1 out · 0 in"); // directed counts

    // Non-adjacent node (3) is dimmed; the adjacent node (2) is not.
    const anchor2 = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/-/paper/doc/2",
    )!;
    const anchor3 = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/-/paper/doc/3",
    )!;
    expect(anchor3.classList.contains("dimmed")).toBe(true);
    expect(anchor2.classList.contains("dimmed")).toBe(false);

    // The navigation target survives selection (click was intercepted).
    expect(anchor1.getAttribute("href")).toBe("/-/paper/doc/1");
    // The panel's Open link is the explicit navigation affordance.
    expect(panel.querySelector(".link-graph-open")?.getAttribute("href")).toBe(
      "/-/paper/doc/1",
    );
  });
});
