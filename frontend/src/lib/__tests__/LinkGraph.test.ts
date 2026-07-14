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
  colorFor,
  buildLegend,
  sizeScale,
  applyFilters,
  nodeCategory,
  matchesQuery,
  type ColorMode,
  type SizeStats,
} from "../LinkGraph.svelte";

type Graph = {
  nodes: { id: number; title: string; state: string }[];
  edges: { source: number; target: number; occurrences: number }[];
};

// Build the category→colour assignment the way the component does (from the
// legend) so `colorFor` fixtures mirror the live wiring.
function assignmentFor(
  nodes: Parameters<typeof buildLegend>[0],
  mode: ColorMode,
): Map<string, string> {
  return new Map(buildLegend(nodes, mode).map((e) => [e.key, e.color]));
}

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
    // All three live: archived nodes now DROP by default (show-archived off),
    // so this render-count fixture keeps every node in a visible state.
    graphPayload = {
      nodes: [
        { id: 1, title: "Alpha", state: "active" },
        { id: 2, title: "Beta", state: "active" },
        { id: 3, title: "Gamma", state: "active" },
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
          state: "active",
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

// --- Facets: colour-by / size-by / filters (T06 / T07) ---------------------

describe("nodeCategory", () => {
  it("buckets by state / kind, and by first sorted tag for tags", () => {
    expect(nodeCategory({ id: 1, state: "active" }, "state")).toBe("active");
    expect(nodeCategory({ id: 1, kind: "note" }, "kind")).toBe("note");
    // First tag in sorted order (v1 multi-tag simplification).
    expect(nodeCategory({ id: 1, tags: ["zed", "alpha"] }, "tag")).toBe("alpha");
    // Untagged / missing → empty key (→ overflow grey downstream).
    expect(nodeCategory({ id: 1, tags: [] }, "tag")).toBe("");
    expect(nodeCategory({ id: 1 }, "tag")).toBe("");
  });
});

describe("colorFor", () => {
  it("state mode keeps today's accent / muted colours", () => {
    const noAssign = new Map<string, string>();
    expect(colorFor({ id: 1, state: "active" }, "state", noAssign)).toBe("var(--pp-accent)");
    expect(colorFor({ id: 2, state: "archived" }, "state", noAssign)).toBe("#cbd2da");
    expect(colorFor({ id: 3, state: "trashed" }, "state", noAssign)).toBe("#cbd2da");
  });

  it("tag mode maps a known tag to its palette slot", () => {
    const nodes = [
      { id: 1, tags: ["alpha"] },
      { id: 2, tags: ["beta"] },
    ];
    const assign = assignmentFor(nodes, "tag");
    // Sorted keys → alpha = slot 0, beta = slot 1.
    expect(colorFor(nodes[0], "tag", assign)).toBe("#0072B2");
    expect(colorFor(nodes[1], "tag", assign)).toBe("#E69F00");
    // Multi-tag node colours by its first sorted tag.
    expect(colorFor({ id: 3, tags: ["beta", "alpha"] }, "tag", assign)).toBe("#0072B2");
  });

  it("overflow (8th+ category) and untagged both map to the neutral grey", () => {
    const nodes = "abcdefgh".split("").map((t, i) => ({ id: i, tags: [t] }));
    const assign = assignmentFor(nodes, "tag");
    // Seven distinct hues, then grey for the 8th sorted key ("h").
    expect(colorFor({ id: 99, tags: ["h"] }, "tag", assign)).toBe("#999999");
    // Untagged → grey regardless of assignment.
    expect(colorFor({ id: 100, tags: [] }, "tag", assign)).toBe("#999999");
  });

  it("kind mode maps a known kind to its palette slot", () => {
    const nodes = [
      { id: 1, kind: "note" },
      { id: 2, kind: "spec" },
    ];
    const assign = assignmentFor(nodes, "kind");
    expect(colorFor(nodes[0], "kind", assign)).toBe("#0072B2"); // note (sorted first)
    expect(colorFor(nodes[1], "kind", assign)).toBe("#E69F00"); // spec
  });
});

describe("buildLegend", () => {
  const nodes = [
    { id: 1, tags: ["x"] },
    { id: 2, tags: ["x"] },
    { id: 3, tags: ["y"] },
    { id: 4, tags: [] },
  ];

  it("orders by count desc then key, with counts and labels", () => {
    const legend = buildLegend(nodes, "tag");
    expect(legend.map((e) => e.key)).toEqual(["x", "", "y"]); // x(2), then ""/y tie by key
    expect(legend.map((e) => e.count)).toEqual([2, 1, 1]);
    const untagged = legend.find((e) => e.key === "")!;
    expect(untagged.label).toBe("Untagged");
    expect(untagged.color).toBe("#999999");
  });

  it("assigns palette colours stably (same input → same assignment)", () => {
    const a = buildLegend(nodes, "tag");
    const b = buildLegend(nodes, "tag");
    const colorOf = (l: typeof a, key: string) => l.find((e) => e.key === key)!.color;
    expect(colorOf(a, "x")).toBe(colorOf(b, "x"));
    expect(colorOf(a, "y")).toBe(colorOf(b, "y"));
    // Colours follow the sorted key, not the display (count) order.
    expect(colorOf(a, "x")).toBe("#0072B2");
    expect(colorOf(a, "y")).toBe("#E69F00");
  });

  it("state mode legend uses the accent / muted colours", () => {
    const legend = buildLegend(
      [
        { id: 1, state: "active" },
        { id: 2, state: "archived" },
      ],
      "state",
    );
    expect(legend.find((e) => e.key === "active")!.color).toBe("var(--pp-accent)");
    expect(legend.find((e) => e.key === "archived")!.color).toBe("#cbd2da");
  });
});

describe("sizeScale", () => {
  const stats: SizeStats = {
    degree: new Map([
      [1, 0],
      [2, 5],
      [3, 20],
    ]),
    directed: new Map([
      [1, { out: 0, in: 3 }],
      [2, { out: 2, in: 0 }],
    ]),
    minTime: Date.parse("2020-01-01T00:00:00Z"),
    maxTime: Date.parse("2020-12-31T00:00:00Z"),
  };

  it("degree mode is byte-identical to the legacy radius()", () => {
    const legacy = (d: number) => 6 + Math.min(d, 12) * 1.5;
    expect(sizeScale({ id: 1 }, "degree", stats)).toBe(legacy(0));
    expect(sizeScale({ id: 2 }, "degree", stats)).toBe(legacy(5));
    expect(sizeScale({ id: 3 }, "degree", stats)).toBe(legacy(20)); // clamps at 12
    expect(sizeScale({ id: 99 }, "degree", stats)).toBe(legacy(0)); // unknown → 0
  });

  it("backlinks mode scales on the directed in-count", () => {
    expect(sizeScale({ id: 1 }, "backlinks", stats)).toBe(6 + 3 * 1.5);
    expect(sizeScale({ id: 2 }, "backlinks", stats)).toBe(6); // 0 backlinks → min
  });

  it("recency mode: newer > older, missing/collapsed → min size", () => {
    const newest = sizeScale({ id: 1, updated_at: "2020-12-31T00:00:00Z" }, "recency", stats);
    const oldest = sizeScale({ id: 2, updated_at: "2020-01-01T00:00:00Z" }, "recency", stats);
    const middle = sizeScale({ id: 3, updated_at: "2020-06-15T00:00:00Z" }, "recency", stats);
    expect(newest).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(oldest);
    expect(oldest).toBe(6); // R_MIN
    expect(sizeScale({ id: 4 }, "recency", stats)).toBe(6); // missing date → min
    expect(sizeScale({ id: 5, updated_at: "not-a-date" }, "recency", stats)).toBe(6);
    // Collapsed range (all same timestamp) → min.
    const flat: SizeStats = { ...stats, minTime: 1000, maxTime: 1000 };
    expect(sizeScale({ id: 6, updated_at: "2020-06-15T00:00:00Z" }, "recency", flat)).toBe(6);
  });
});

describe("matchesQuery", () => {
  it("matches everything on empty query, substring otherwise (case-insensitive)", () => {
    expect(matchesQuery("Alpha", "")).toBe(true);
    expect(matchesQuery("Alpha", "  ")).toBe(true);
    expect(matchesQuery("Alpha", "lph")).toBe(true);
    expect(matchesQuery("Alpha", "ALP")).toBe(true);
    expect(matchesQuery("Alpha", "beta")).toBe(false);
    expect(matchesQuery(undefined, "a")).toBe(false);
  });
});

describe("applyFilters", () => {
  const nodes = [
    { id: 1, state: "active", tags: ["x"] },
    { id: 2, state: "active", tags: ["y"] },
    { id: 3, state: "archived", tags: ["x"] },
  ];
  const edges = [
    { source: 1, target: 2, occurrences: 1 },
    { source: 2, target: 3, occurrences: 1 },
  ];

  it("hides archived nodes by default and drops their incident edges", () => {
    const { nodes: vn, edges: ve } = applyFilters(nodes, edges, {
      activeCategories: new Set(),
      mode: "tag",
      showArchived: false,
    });
    expect(vn.map((n) => n.id)).toEqual([1, 2]);
    // Edge 2→3 drops because endpoint 3 (archived) is gone.
    expect(ve).toHaveLength(1);
    expect(ve[0].source).toBe(1);
  });

  it("keeps archived nodes when showArchived is on", () => {
    const { nodes: vn, edges: ve } = applyFilters(nodes, edges, {
      activeCategories: new Set(),
      mode: "tag",
      showArchived: true,
    });
    expect(vn.map((n) => n.id)).toEqual([1, 2, 3]);
    expect(ve).toHaveLength(2);
  });

  it("excludes a legend-toggled category (and its edges)", () => {
    const { nodes: vn, edges: ve } = applyFilters(nodes, edges, {
      activeCategories: new Set(["y"]), // hide first-tag "y" → node 2
      mode: "tag",
      showArchived: true,
    });
    expect(vn.map((n) => n.id)).toEqual([1, 3]);
    // Both edges touch node 2, so both drop.
    expect(ve).toHaveLength(0);
  });

  it("resolves endpoints whether edges hold ids or d3 node refs", () => {
    const refEdges = [{ source: nodes[0], target: nodes[1], occurrences: 1 }];
    const { edges: ve } = applyFilters(nodes, refEdges, {
      activeCategories: new Set(),
      mode: "tag",
      showArchived: true,
    });
    expect(ve).toHaveLength(1);
  });

  it("does not drop nodes on query (search dims, not drops)", () => {
    const { nodes: vn } = applyFilters(nodes, edges, {
      activeCategories: new Set(),
      mode: "tag",
      query: "zzz-no-match",
      showArchived: true,
    });
    expect(vn.map((n) => n.id)).toEqual([1, 2, 3]);
  });
});

describe("LinkGraph facet UI", () => {
  async function waitForGraph(): Promise<void> {
    await vi.waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  }

  const richGraph = {
    nodes: [
      { id: 1, title: "Alpha", state: "active", kind: "note", updated_at: "2020-01-01T00:00:00Z", tags: ["red"] },
      { id: 2, title: "Beta", state: "active", kind: "note", updated_at: "2020-02-01T00:00:00Z", tags: ["red"] },
      { id: 3, title: "Gamma", state: "active", kind: "spec", updated_at: "2020-03-01T00:00:00Z", tags: ["blue"] },
    ],
    edges: [
      { source: 1, target: 2, occurrences: 1 },
      { source: 2, target: 3, occurrences: 1 },
    ],
  };

  it("switching Color by → Tag paints inline fills and lists tags with counts", async () => {
    graphPayload = richGraph as unknown as Graph;
    const { container } = render(LinkGraph);
    await waitForGraph();
    await vi.waitFor(() => expect(container.querySelectorAll("circle").length).toBe(3));

    // State mode (default): no inline fill on node circles.
    expect(
      Array.from(container.querySelectorAll(".link-graph-nodes circle")).some((c) =>
        c.getAttribute("style"),
      ),
    ).toBe(false);

    const select = screen.getByLabelText("Color nodes by") as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: "tag" } });

    // Now every node carries an inline palette fill.
    await vi.waitFor(() =>
      expect(
        Array.from(container.querySelectorAll(".link-graph-nodes circle")).every((c) =>
          (c.getAttribute("style") ?? "").includes("fill:"),
        ),
      ).toBe(true),
    );

    // Legend lists the tags with their counts.
    const legend = container.querySelector(".link-graph-legend")!;
    expect(legend.textContent).toContain("red");
    expect(legend.textContent).toContain("blue");
    const redSwatch = Array.from(legend.querySelectorAll(".link-graph-swatch")).find((s) =>
      s.textContent?.includes("red"),
    )!;
    expect(redSwatch.textContent).toContain("2"); // two red nodes
  });

  it("clicking a legend swatch drops that category's nodes", async () => {
    graphPayload = richGraph as unknown as Graph;
    const { container } = render(LinkGraph);
    await waitForGraph();
    await vi.waitFor(() => expect(container.querySelectorAll("circle").length).toBe(3));

    const select = screen.getByLabelText("Color nodes by") as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: "tag" } });

    const legend = container.querySelector(".link-graph-legend")!;
    const redSwatch = Array.from(legend.querySelectorAll(".link-graph-swatch")).find((s) =>
      s.textContent?.includes("red"),
    ) as HTMLButtonElement;
    await fireEvent.click(redSwatch);

    // The two "red" nodes drop; only "blue" Gamma remains.
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".link-graph-nodes circle").length).toBe(1),
    );
    const anchors = Array.from(container.querySelectorAll(".link-graph-nodes a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(anchors).toEqual(["/-/paper/doc/3"]);
  });

  it("search dims non-matching titles", async () => {
    graphPayload = richGraph as unknown as Graph;
    const { container } = render(LinkGraph);
    await waitForGraph();
    await vi.waitFor(() => expect(container.querySelectorAll("circle").length).toBe(3));

    const search = screen.getByLabelText("Search paper titles") as HTMLInputElement;
    await fireEvent.input(search, { target: { value: "alph" } });

    const anchorFor = (id: number) =>
      Array.from(container.querySelectorAll(".link-graph-nodes a")).find(
        (a) => a.getAttribute("href") === `/-/paper/doc/${id}`,
      )!;
    await vi.waitFor(() => expect(anchorFor(2).classList.contains("dimmed")).toBe(true));
    // Match stays lit; non-matches dim (but are NOT dropped).
    expect(anchorFor(1).classList.contains("dimmed")).toBe(false);
    expect(anchorFor(3).classList.contains("dimmed")).toBe(true);
    expect(container.querySelectorAll(".link-graph-nodes circle").length).toBe(3);
  });

  it("Show archived toggles the muted nodes in and out of the layout", async () => {
    graphPayload = {
      nodes: [
        { id: 1, title: "Alpha", state: "active", kind: "note", updated_at: "2020-01-01T00:00:00Z", tags: [] },
        { id: 2, title: "Beta", state: "active", kind: "note", updated_at: "2020-02-01T00:00:00Z", tags: [] },
        { id: 3, title: "Gamma", state: "archived", kind: "note", updated_at: "2020-03-01T00:00:00Z", tags: [] },
      ],
      edges: [{ source: 2, target: 3, occurrences: 1 }],
    } as unknown as Graph;
    const { container } = render(LinkGraph);
    await waitForGraph();

    // Archived Gamma is hidden by default → 2 nodes, 0 visible edges.
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".link-graph-nodes circle").length).toBe(2),
    );
    expect(container.querySelectorAll(".link-graph-edges line").length).toBe(0);

    const check = screen.getByLabelText("Show archived") as HTMLInputElement;
    await fireEvent.click(check);

    // Now all three render and the 2→3 edge reappears.
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".link-graph-nodes circle").length).toBe(3),
    );
    expect(container.querySelectorAll(".link-graph-edges line").length).toBe(1);
  });
});
