<script lang="ts" module>
  import {
    assignCategoryColors,
    GRAPH_OVERFLOW_COLOR,
  } from "./graphPalette";

  /**
   * Pure, DOM/d3-free degree helper. Counts incident edges per node id,
   * treating the graph as directionless (each edge bumps both endpoints).
   * Edges may arrive with source/target as plain ids OR — after d3 mutates
   * them in place — as node objects; callers should feed the RAW fetched
   * edges here so the ids are still stable.
   */
  export function computeDegree(
    nodes: { id: number }[],
    edges: { source: number; target: number }[],
  ): Map<number, number> {
    // Pure local Map, never stored in reactive state — SvelteMap is unneeded.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const deg = new Map<number, number>();
    for (const n of nodes) deg.set(n.id, 0);
    for (const e of edges) {
      deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
      deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    }
    return deg;
  }

  /**
   * Pure, directed variant of computeDegree: forward-link (`out`) and
   * backlink (`in`) counts per node id. Same contract as computeDegree —
   * feed the RAW fetched edges so source/target are still stable ids.
   */
  export function directedDegree(
    nodes: { id: number }[],
    edges: { source: number; target: number }[],
  ): Map<number, { out: number; in: number }> {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const deg = new Map<number, { out: number; in: number }>();
    for (const n of nodes) deg.set(n.id, { out: 0, in: 0 });
    for (const e of edges) {
      const s = deg.get(e.source) ?? { out: 0, in: 0 };
      s.out += 1;
      deg.set(e.source, s);
      const t = deg.get(e.target) ?? { out: 0, in: 0 };
      t.in += 1;
      deg.set(e.target, t);
    }
    return deg;
  }

  /**
   * Pure gate for the animated render path. Live if the platform can drive
   * rAF ticks and the viewer hasn't asked to reduce motion. Callers pass
   * `reduceMotion = true` when the preference can't be read (no `matchMedia`,
   * e.g. jsdom) so we fall back to the synchronous settle — the honest
   * reduced-motion behaviour and what the non-ticking render test depends on.
   */
  export function shouldAnimate(hasRaf: boolean, reduceMotion: boolean): boolean {
    return hasRaf && !reduceMotion;
  }

  /**
   * Screen→graph coordinate map — the single source of truth shared by
   * zoom (T04) and node drag (T03). `transform` is the `<g>`'s
   * `translate(x y) scale(k)`; inverting it turns a viewport-local pixel
   * into the graph-space coordinate under it.
   */
  export function screenToGraph(
    px: number,
    py: number,
    transform: { k: number; x: number; y: number },
  ): { x: number; y: number } {
    return {
      x: (px - transform.x) / transform.k,
      y: (py - transform.y) / transform.k,
    };
  }

  const K_MIN = 0.2;
  const K_MAX = 4;

  /** Clamp a zoom factor to the allowed range. Pure, for the zoom math. */
  export function clampScale(k: number): number {
    return Math.min(K_MAX, Math.max(K_MIN, k));
  }

  /**
   * A pointer that has travelled past this many pixels counts as a drag, so
   * the trailing click is a reposition (or pan), not a selection. Pure so the
   * threshold can be pinned in a unit test without simulating pointer events.
   */
  export function movedBeyondThreshold(dx: number, dy: number, threshold = 4): boolean {
    return Math.hypot(dx, dy) > threshold;
  }

  /**
   * Pure highlight predicate: a node is dimmed only when a selection exists
   * and the node is neither the selection nor one of its neighbours.
   * `adjacency` is the selected node's neighbour-id set (excluding itself).
   */
  export function isDimmed(
    nodeId: number,
    selectedId: number | null,
    adjacency: Set<number>,
  ): boolean {
    if (selectedId === null) return false;
    if (nodeId === selectedId) return false;
    return !adjacency.has(nodeId);
  }

  /**
   * Pure relative-time formatter for the metadata panel. `now` is injectable
   * so the output is deterministic in tests. Unparseable input echoes back.
   */
  export function relativeTime(iso: string, now: number = Date.now()): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const diff = now - t;
    if (diff < 45_000) return "just now";
    const mins = Math.round(diff / 60_000);
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const hours = Math.round(diff / 3_600_000);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.round(diff / 86_400_000);
    if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
    const weeks = Math.round(days / 7);
    if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
    const years = Math.round(days / 365);
    return `${years} year${years === 1 ? "" : "s"} ago`;
  }

  // --- Facets: colour-by, size-by, filters (T06 / T07) -----------------------

  /** State-driven colour mode names; `state` keeps today's accent/muted look. */
  export type ColorMode = "state" | "tag" | "kind";
  /** Size-driven radius mode names. `degree` reproduces the legacy `radius()`. */
  export type SizeMode = "degree" | "backlinks" | "recency";

  // Radius envelope. `R_MAX` (24) matches the legacy degree cap
  // `6 + min(deg,12)*1.5`, so every mode shares one size range.
  const R_MIN = 6;
  const R_MAX = 24;

  type FacetNode = {
    id: number;
    state?: string;
    kind?: string;
    tags?: string[];
    updated_at?: string;
    title?: string;
  };

  /** The two states the doc list buckets as "muted" — hidden by default. */
  export function isMutedState(state: string | undefined): boolean {
    return state === "archived" || state === "trashed";
  }

  /**
   * The single category a node belongs to under a colour mode — the seam
   * shared by colouring, the legend, and the legend-as-filter so a swatch
   * toggles exactly the nodes wearing its colour.
   *
   * v1 multi-tag simplification: a node with several tags is bucketed by its
   * FIRST tag in sorted (lexicographic) order; segmented/pie nodes are a
   * follow-up (design §7). An untagged (or state-/kind-less) node returns the
   * empty string, which maps to the neutral overflow grey.
   */
  export function nodeCategory(node: FacetNode, mode: ColorMode): string {
    if (mode === "state") return node.state ?? "";
    if (mode === "kind") return node.kind ?? "";
    const tags = node.tags ?? [];
    if (tags.length === 0) return "";
    return [...tags].sort()[0];
  }

  /**
   * Fill colour for a node under a colour mode. `state` mode is unchanged from
   * today — live nodes take the accent token, muted (archived/trashed) nodes
   * the grey literal — so the caller can keep driving state-mode fills from CSS
   * and only apply this inline for `tag`/`kind`. `tag`/`kind` look the node's
   * category up in a precomputed `assignment` (see `assignCategoryColors`),
   * falling back to the overflow grey for unknown/untagged categories.
   */
  export function colorFor(
    node: FacetNode,
    mode: ColorMode,
    assignment: Map<string, string>,
  ): string {
    if (mode === "state") {
      // Matches the CSS: `var(--pp-accent)` live, `#cbd2da` muted.
      return isMutedState(node.state) ? "#cbd2da" : "var(--pp-accent)";
    }
    const key = nodeCategory(node, mode);
    if (key === "") return GRAPH_OVERFLOW_COLOR;
    return assignment.get(key) ?? GRAPH_OVERFLOW_COLOR;
  }

  function legendLabel(key: string, mode: ColorMode): string {
    if (key !== "") return key;
    return mode === "tag" ? "Untagged" : "—";
  }

  function legendColor(
    key: string,
    mode: ColorMode,
    assignment: Map<string, string>,
  ): string {
    if (mode === "state") {
      return isMutedState(key) ? "#cbd2da" : "var(--pp-accent)";
    }
    if (key === "") return GRAPH_OVERFLOW_COLOR;
    return assignment.get(key) ?? GRAPH_OVERFLOW_COLOR;
  }

  /**
   * Build the legend rows for a colour mode: one entry per distinct category
   * with its swatch colour and node count, ordered by count desc then key.
   * Drives both the swatch strip and the category→colour assignment consumed
   * by `colorFor` (build it once, pass the same map to both, and colours stay
   * in lock-step). Colours come from a stable sort of the category keys, so the
   * display order (count desc) never perturbs which hue a category gets.
   */
  export function buildLegend(
    nodes: FacetNode[],
    mode: ColorMode,
  ): { key: string; label: string; color: string; count: number }[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const counts = new Map<string, number>();
    for (const n of nodes) {
      const key = nodeCategory(n, mode);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const assignment = assignCategoryColors(
      [...counts.keys()].filter((k) => k !== ""),
    );
    const entries = [...counts.entries()].map(([key, count]) => ({
      key,
      label: legendLabel(key, mode),
      color: legendColor(key, mode, assignment),
      count,
    }));
    entries.sort(
      (a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    return entries;
  }

  /** Precomputed inputs for `sizeScale`, built once per fetch. */
  export type SizeStats = {
    degree: Map<number, number>;
    directed: Map<number, { out: number; in: number }>;
    // Age envelope (ms since epoch) across all parseable `updated_at`s.
    minTime: number;
    maxTime: number;
  };

  /**
   * Radius for a node under a size mode. Pure; all data-dependent inputs come
   * through `stats` so the scale is stable frame-to-frame.
   *
   * - `degree`   — byte-identical to the legacy `radius()`:
   *                `6 + min(undirectedDegree, 12) * 1.5`.
   * - `backlinks`— same clamp on the directed `in` (backlink) count.
   * - `recency`  — maps `updated_at` age onto `[R_MIN, R_MAX]`, newest largest;
   *                a missing / unparseable date (or a single-timestamp graph
   *                where the range collapses) falls back to `R_MIN`.
   */
  export function sizeScale(node: FacetNode, mode: SizeMode, stats: SizeStats): number {
    if (mode === "degree") {
      const d = stats.degree.get(node.id) ?? 0;
      return 6 + Math.min(d, 12) * 1.5;
    }
    if (mode === "backlinks") {
      const back = stats.directed.get(node.id)?.in ?? 0;
      return 6 + Math.min(back, 12) * 1.5;
    }
    // recency
    const t = node.updated_at ? Date.parse(node.updated_at) : NaN;
    if (Number.isNaN(t) || !(stats.maxTime > stats.minTime)) return R_MIN;
    const frac = (t - stats.minTime) / (stats.maxTime - stats.minTime);
    return R_MIN + frac * (R_MAX - R_MIN);
  }

  /**
   * Pure title-substring match for the search box. Empty query matches
   * everything. Search DIMS non-matches (design §4 / T07) rather than dropping
   * them, so this feeds a render class, not `applyFilters`.
   */
  export function matchesQuery(title: string | undefined, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (q === "") return true;
    return (title ?? "").toLowerCase().includes(q);
  }

  // Endpoint id whether the edge still holds raw ids or d3-resolved node refs.
  function endpointId(x: number | { id: number }): number {
    return typeof x === "number" ? x : x.id;
  }

  /** Options funnelled through `applyFilters`. */
  export type FilterOpts = {
    // Categories the viewer has toggled OFF (hidden) via the legend; a node
    // whose `nodeCategory(mode)` is in this set drops. Empty = show all.
    activeCategories: { has(key: string): boolean };
    mode: ColorMode;
    // Present for a single call-site funnel, but search DIMS (does not drop),
    // so `query` deliberately never removes a node here.
    query?: string;
    showArchived: boolean;
  };

  /**
   * The one filter funnel (T07): combine the legend's category exclusions and
   * the show-archived toggle into the visible `{ nodes, edges }`. An edge drops
   * when either endpoint dropped. `query` is accepted but intentionally inert —
   * search is a dim, not a drop (see `matchesQuery`).
   *
   * Pure and endpoint-shape-agnostic (raw ids or d3 node refs), so it covers
   * both the unit fixtures and the live, d3-mutated edge list.
   */
  export function applyFilters<
    N extends FacetNode,
    E extends { source: number | { id: number }; target: number | { id: number } },
  >(nodes: N[], edges: E[], opts: FilterOpts): { nodes: N[]; edges: E[] } {
    const visible = nodes.filter((n) => {
      if (!opts.showArchived && isMutedState(n.state)) return false;
      if (opts.activeCategories.has(nodeCategory(n, opts.mode))) return false;
      return true;
    });
    const ids = new Set(visible.map((n) => n.id));
    const visibleEdges = edges.filter(
      (e) => ids.has(endpointId(e.source)) && ids.has(endpointId(e.target)),
    );
    return { nodes: visible, edges: visibleEdges };
  }
</script>

<script lang="ts">
  /**
   * @feat link-graph: force-directed view of the viewable link graph.
   *
   * Fetches `/-/paper/api/links/graph` (already permission-scoped
   * server-side), lays the nodes out with a d3-force simulation, and renders
   * plain SVG — one <line> per edge, one <circle>+<text> per node.
   *
   * d3-force is DYNAMICALLY imported (never top-level) — it only loads once
   * this component mounts, mirroring PaperApp's lazy prosemirror-markdown
   * import.
   *
   * Two layout paths (see `shouldAnimate`): a live `on("tick")` loop that
   * writes coordinates into `$state` each frame (d3 never touches the DOM),
   * or — under reduced motion / no rAF / the non-ticking jsdom test — a
   * synchronous fixed-tick settle that assigns once. The viewport tracks the
   * container size (ResizeObserver), so `viewBox`/`forceCenter` are live.
   *
   * Interaction (all hand-rolled — no d3-selection/-zoom/-drag): pointer
   * drag repositions a node (shift pins it); wheel zooms about the cursor and
   * a background drag pans, both through a single `<g transform>` over
   * `screenToGraph`; a plain click selects a node (double-click / ⌘-click /
   * the panel Open link navigate), lighting its neighbourhood and filling the
   * metadata aside. Directed arrowheads point src→dst.
   */

  // Type-only import: erased at build, so it does NOT pull d3-force onto the
  // top-level bundle — the runtime import stays dynamic inside build().
  import type { Simulation, ForceCenter, ForceLink } from "d3-force";
  import { SvelteSet } from "svelte/reactivity";
  import { TOOLBAR_ICONS } from "./icons";

  type GraphNode = {
    id: number;
    title: string;
    state: string;
    kind: string;
    updated_at: string;
    tags: string[];
  };

  type GraphEdge = {
    source: number;
    target: number;
    occurrences: number;
  };

  // Node shape after d3 mutates it with layout coordinates. `fx`/`fy` pin a
  // node to a fixed point (set while dragging / when pinned); `pinned` keeps
  // them across release.
  type SimNode = GraphNode & {
    x: number;
    y: number;
    fx?: number | null;
    fy?: number | null;
    pinned?: boolean;
  };
  // Edge shape after d3 replaces source/target ids with node refs.
  type SimEdge = {
    source: SimNode;
    target: SimNode;
    occurrences: number;
  };

  type Transform = { k: number; x: number; y: number };

  // Fallback dims when the container has no measured size yet (jsdom / pre-
  // layout). Real dimensions come from the ResizeObserver below.
  const DEFAULT_WIDTH = 640;
  const DEFAULT_HEIGHT = 480;
  const TICKS = 300;

  let loading = $state(true);
  let error = $state<string | null>(null);
  // The VISIBLE (post-`applyFilters`) sets that actually render + feed the sim.
  let nodes = $state<SimNode[]>([]);
  let edges = $state<SimEdge[]>([]);
  let w = $state(DEFAULT_WIDTH);
  let h = $state(DEFAULT_HEIGHT);

  // Selection + view transform (T05 / T04).
  let selectedId = $state<number | null>(null);
  let transform = $state<Transform>({ k: 1, x: 0, y: 0 });

  // --- Facet controls (T06 / T07) --------------------------------------------
  let colorMode = $state<ColorMode>("state");
  let sizeMode = $state<SizeMode>("degree");
  let query = $state("");
  let showArchived = $state(false);
  // Categories toggled OFF (hidden) via the legend. SvelteSet so add/delete/has
  // stay reactive without the plain-Set reactivity lint. Empty = show all.
  let activeCategories = new SvelteSet<string>();

  let container: HTMLDivElement;
  // Hoisted so the resize handler + effect teardown can reach the live sim.
  let sim: Simulation<SimNode, undefined> | null = null;
  let centerForce: ForceCenter<SimNode> | null = null;
  let linkForce: ForceLink<SimNode, SimEdge> | null = null;
  let animated = false;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  // Plain (non-reactive) Maps/arrays: always assigned before `nodes` (the
  // reactive trigger for a render), so the render reads the current value.
  // Kept out of `$state` to avoid the SvelteMap reactivity lint while still
  // letting the pure helpers return vanilla collections per their contracts.
  let degree = new Map<number, number>();
  let dirDegree = new Map<number, { out: number; in: number }>();
  let rawEdges: GraphEdge[] = [];
  // Size-by inputs, rebuilt once per fetch (degree/backlinks maps + age range).
  let sizeStats: SizeStats = {
    degree,
    directed: dirDegree,
    minTime: Infinity,
    maxTime: -Infinity,
  };
  // The MASTER sets (all fetched nodes/edges, d3-mutated in place). `nodes`/
  // `edges` are the currently-visible SUBSET; filtering never mutates these.
  // `$state` so the legend derivation recomputes once build() assigns them.
  let masterNodes = $state<SimNode[]>([]);
  let masterEdges: SimEdge[] = [];
  // The current visible subset fed to the sim (and mirrored into `nodes`/
  // `edges` for render). Reassigned on every filter change; the sim ticks
  // these same objects so positions carry over between filter states.
  let simNodes: SimNode[] = [];
  let simEdges: SimEdge[] = [];

  // Legend rows + the category→colour assignment, derived over the MASTER set
  // (not the filtered one) so colours never reshuffle as categories hide/show.
  let legend = $derived(masterNodes.length ? buildLegend(masterNodes, colorMode) : []);
  let colorAssignment = $derived(new Map(legend.map((e) => [e.key, e.color])));

  // Non-reactive gesture bookkeeping. Reassigning `nodes`/`transform` after a
  // mutation is what actually repaints; these just hold the in-flight gesture.
  let dragState: {
    id: number;
    pointerId: number;
    startX: number;
    startY: number;
    // Grab offset (node centre − pointer, graph space) so a drag moves the
    // node from where it was grabbed instead of snapping its centre to the
    // cursor.
    offX: number;
    offY: number;
    moved: boolean;
    el: Element;
  } | null = null;
  // True after a drag that moved past the threshold, so the trailing click is
  // swallowed (repositioning a node must not also select it).
  let suppressClick = false;
  let panState: {
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null = null;

  // Selected node + its neighbourhood, derived from selectionId. `rawEdges`
  // is stable after build(), so reading it untracked is safe — the derivation
  // re-runs whenever `selectedId` (reactive) changes.
  let selectedNode = $derived(
    selectedId == null ? null : (nodes.find((n) => n.id === selectedId) ?? null),
  );
  let selectedCounts = $derived(
    selectedId == null ? { out: 0, in: 0 } : (dirDegree.get(selectedId) ?? { out: 0, in: 0 }),
  );
  let neighborIds = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const s = new Set<number>();
    if (selectedId == null) return s;
    for (const e of rawEdges) {
      if (e.source === selectedId) s.add(e.target);
      if (e.target === selectedId) s.add(e.source);
    }
    return s;
  });

  // Per-node radius under the active size mode (T07). Replaces the old
  // `radius(id)` — `degree` mode is byte-identical to it.
  function nodeRadius(n: SimNode): number {
    return sizeScale(n, sizeMode, sizeStats);
  }

  function isMuted(state: string): boolean {
    return isMutedState(state);
  }

  // Give any node without a finite position a starting point (viewport centre
  // + jitter) so a newly-revealed node has coordinates before the sim runs —
  // and so the reduced-motion / mocked path never renders NaN geometry.
  // Already-positioned nodes are left put, which is what keeps a filter toggle
  // feeling continuous.
  function seedPositions(ns: SimNode[]): void {
    for (const n of ns) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
        n.x = w / 2 + (Math.random() - 0.5) * 40;
        n.y = h / 2 + (Math.random() - 0.5) * 40;
      }
    }
  }

  function currentFilterOpts(): FilterOpts {
    return { activeCategories, mode: colorMode, query, showArchived };
  }

  // Recompute the visible subset and re-point the sim at it. Node objects are
  // shared with the master set, so survivors keep their x/y (continuous layout)
  // while dropped nodes simply stop being simulated. Reheats gently rather than
  // restarting from scratch. Sim reconfiguration is guarded on the real d3 API
  // (`sim.nodes`) so the non-ticking test mock — which lacks it — just takes
  // the reassigned arrays.
  function refreshFilters(reheat = true): void {
    if (masterNodes.length === 0) return;
    const vis = applyFilters(masterNodes, masterEdges, currentFilterOpts());
    // A filtered-out selection would keep dimming the survivors invisibly.
    if (selectedId != null && !vis.nodes.some((n) => n.id === selectedId)) {
      selectedId = null;
    }
    seedPositions(vis.nodes);
    simNodes = vis.nodes;
    simEdges = vis.edges;
    nodes = simNodes;
    edges = simEdges;
    if (sim && typeof sim.nodes === "function") {
      sim.nodes(simNodes);
      linkForce?.links(simEdges);
      if (reheat) {
        if (animated) {
          sim.alpha(0.3).restart();
        } else {
          for (let i = 0; i < TICKS; i++) sim.tick();
          sim.stop();
          nodes = [...simNodes];
          edges = [...simEdges];
        }
      }
    }
  }

  async function build(): Promise<void> {
    loading = true;
    error = null;
    try {
      const resp = await fetch("/-/paper/api/links/graph");
      if (!resp.ok) throw new Error("Failed to load graph");
      const data = (await resp.json()) as {
        nodes: GraphNode[];
        edges: GraphEdge[];
      };
      const rawNodes = data.nodes ?? [];
      rawEdges = data.edges ?? [];

      // Degrees from the RAW edges (ids stable) before d3 mutates copies.
      degree = computeDegree(rawNodes, rawEdges);
      dirDegree = directedDegree(rawNodes, rawEdges);
      // Age envelope for recency sizing, over every parseable timestamp.
      let minTime = Infinity;
      let maxTime = -Infinity;
      for (const n of rawNodes) {
        const t = n.updated_at ? Date.parse(n.updated_at) : NaN;
        if (!Number.isNaN(t)) {
          if (t < minTime) minTime = t;
          if (t > maxTime) maxTime = t;
        }
      }
      sizeStats = { degree, directed: dirDegree, minTime, maxTime };

      if (rawNodes.length === 0) {
        masterNodes = [];
        masterEdges = [];
        nodes = [];
        edges = [];
        return;
      }

      // d3 mutates the objects it's handed (adds x/y/vx/vy on nodes,
      // swaps source/target ids for node refs on links), so feed it copies.
      // These are the MASTER sets; the sim only ever gets the visible subset.
      masterNodes = rawNodes.map((n) => ({ ...n })) as SimNode[];
      masterEdges = rawEdges.map((e) => ({ ...e })) as unknown as SimEdge[];

      // Resolve EVERY edge's source/target to its node ref up front — d3 only
      // resolves the links it's handed (the visible subset), so an edge first
      // revealed by a later filter toggle would otherwise still hold raw ids
      // and render as NaN geometry. d3/mock link forces leave already-resolved
      // refs untouched, so this is safe to do ahead of them.
      const nodeById = new Map(masterNodes.map((n) => [n.id, n]));
      for (const e of masterEdges) {
        const s = e.source as unknown as number;
        const t = e.target as unknown as number;
        e.source = nodeById.get(s) ?? e.source;
        e.target = nodeById.get(t) ?? e.target;
      }

      // Initial visible set (default: archived hidden, nothing legend-excluded).
      const vis = applyFilters(masterNodes, masterEdges, currentFilterOpts());
      simNodes = vis.nodes;
      simEdges = vis.edges;

      const { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide } =
        await import("d3-force");

      animated = shouldAnimate(
        typeof requestAnimationFrame === "function",
        prefersReducedMotion(),
      );

      centerForce = forceCenter<SimNode>(w / 2, h / 2);
      linkForce = forceLink<SimNode, SimEdge>(simEdges)
        .id((d) => (d as SimNode).id)
        .distance(80);
      sim = forceSimulation(simNodes)
        .force("link", linkForce)
        .force("charge", forceManyBody().strength(-220))
        .force("center", centerForce)
        .force("collide", forceCollide(24))
        .stop();

      // Modal closed before d3 finished loading — don't start ticking.
      if (destroyed) {
        sim.stop();
        return;
      }

      if (animated) {
        sim.on("tick", () => {
          nodes = [...simNodes];
          edges = [...simEdges];
        });
        // Paint the initial layout now — restart()'s first tick lands a frame
        // later, and `loading` flips false before it, flashing the empty state.
        nodes = [...simNodes];
        edges = [...simEdges];
        sim.alpha(1).restart();
      } else {
        for (let i = 0; i < TICKS; i++) sim.tick();
        sim.stop();
        nodes = simNodes;
        edges = simEdges;
      }
    } catch {
      error = "Could not load the link graph.";
    } finally {
      loading = false;
    }
  }

  function prefersReducedMotion(): boolean {
    // No matchMedia (jsdom) → assume reduced motion so we take the settle path.
    if (typeof window.matchMedia !== "function") return true;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function measure(): void {
    if (!container) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw > 0) w = cw;
    if (ch > 0) h = ch;
  }

  function onResize(): void {
    measure();
    // Keep the layout centred in the new box; only reheat when animated.
    if (centerForce && typeof centerForce.x === "function") {
      centerForce.x(w / 2).y(h / 2);
    }
    if (!animated || !sim) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      sim?.alpha(0.3).restart();
    }, 150);
  }

  // Viewport-local pixel for a pointer/wheel event, then through the current
  // transform to graph space. `w === container.clientWidth` (ResizeObserver),
  // so 1 CSS px == 1 SVG user unit and the container rect is the SVG origin.
  function graphPointFromEvent(e: { clientX: number; clientY: number }): {
    x: number;
    y: number;
  } {
    const rect = container.getBoundingClientRect();
    return screenToGraph(e.clientX - rect.left, e.clientY - rect.top, transform);
  }

  // --- Node drag + pin (T03) -------------------------------------------------

  function onNodePointerDown(e: PointerEvent, n: SimNode): void {
    // Don't let the background pan handler also claim this gesture.
    e.stopPropagation();
    const el = e.currentTarget as Element;
    el.setPointerCapture?.(e.pointerId);
    const p = graphPointFromEvent(e);
    dragState = {
      id: n.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      offX: n.x - p.x,
      offY: n.y - p.y,
      moved: false,
      el,
    };
    if (e.shiftKey) n.pinned = true;
    // Nothing moves yet: heating the sim / fixing the node waits for the
    // threshold, so a plain selection click never perturbs the layout.
  }

  function onNodePointerMove(e: PointerEvent, n: SimNode): void {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    if (!dragState.moved) {
      if (!movedBeyondThreshold(e.clientX - dragState.startX, e.clientY - dragState.startY)) {
        return;
      }
      dragState.moved = true;
      if (animated && sim) sim.alphaTarget(0.3).restart();
    }
    const p = graphPointFromEvent(e);
    n.fx = p.x + dragState.offX;
    n.fy = p.y + dragState.offY;
    // Static path never ticks, so move the rendered coordinate too.
    if (!animated) {
      n.x = n.fx;
      n.y = n.fy;
    }
    nodes = [...nodes];
  }

  function onNodePointerUp(e: PointerEvent, n: SimNode): void {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    dragState.el.releasePointerCapture?.(e.pointerId);
    if (dragState.moved && animated && sim) sim.alphaTarget(0);
    if (n.pinned) {
      // Shift-click without a drag pins the node where it sits.
      if (n.fx == null) {
        n.fx = n.x;
        n.fy = n.y;
      }
    } else {
      // Release back to physics.
      n.fx = null;
      n.fy = null;
    }
    // A real drag swallows the click that follows pointerup.
    suppressClick = dragState.moved;
    dragState = null;
    nodes = [...nodes];
  }

  function onNodeClick(e: MouseEvent, n: SimNode): void {
    // ⌘/Ctrl-click → open (possibly new tab): let the anchor navigate.
    if (e.metaKey || e.ctrlKey) return;
    // Keyboard activation (Enter on the focused anchor) reports detail 0 —
    // let it fall through to native navigation (the a11y open path).
    if (e.detail === 0) return;
    e.preventDefault();
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    selectedId = n.id;
  }

  function onNodeDblClick(e: MouseEvent, n: SimNode): void {
    // Explicit navigation — selection intercepts the single click, so open here.
    e.preventDefault();
    window.location.href = `/-/paper/doc/${n.id}`;
  }

  function togglePin(n: SimNode): void {
    n.pinned = !n.pinned;
    if (n.pinned) {
      n.fx = n.x;
      n.fy = n.y;
    } else {
      n.fx = null;
      n.fy = null;
      if (animated && sim) sim.alpha(0.3).restart();
    }
    nodes = [...nodes];
  }

  function reheat(): void {
    for (const n of nodes) {
      n.pinned = false;
      n.fx = null;
      n.fy = null;
    }
    if (animated && sim) {
      sim.alpha(0.6).restart();
    } else if (sim) {
      for (let i = 0; i < TICKS; i++) sim.tick();
      sim.stop();
    }
    nodes = [...nodes];
    edges = [...edges];
  }

  // --- Facet handlers (T06 / T07) --------------------------------------------

  // Categories are mode-specific, so a stale hide-filter from the previous mode
  // would be meaningless — clear it whenever the colour mode changes.
  function onColorModeChange(e: Event): void {
    colorMode = (e.currentTarget as HTMLSelectElement).value as ColorMode;
    activeCategories.clear();
    refreshFilters();
  }

  function onSizeModeChange(e: Event): void {
    // Size-by only changes radii (a pure render read of `sizeMode`); no
    // membership change, so the layout is left where it is.
    sizeMode = (e.currentTarget as HTMLSelectElement).value as SizeMode;
  }

  function onShowArchivedChange(e: Event): void {
    showArchived = (e.currentTarget as HTMLInputElement).checked;
    refreshFilters();
  }

  // Legend swatch = filter: toggle this category's membership in the hidden set.
  function toggleCategory(key: string): void {
    if (activeCategories.has(key)) activeCategories.delete(key);
    else activeCategories.add(key);
    refreshFilters();
  }

  function nodeFillStyle(n: SimNode): string | undefined {
    // State mode is driven entirely by CSS (accent / muted / hover), so leave
    // the fill unset; tag/kind paint an inline literal that wins over the CSS
    // default (a presentation attribute would lose to the stylesheet).
    if (colorMode === "state") return undefined;
    return `fill: ${colorFor(n, colorMode, colorAssignment)}`;
  }

  // Dim on either the selection neighbourhood (T05) or a search miss (T07);
  // both reuse the same `.dimmed` treatment.
  function nodeDimmed(n: SimNode): boolean {
    return isDimmed(n.id, selectedId, neighborIds) || !matchesQuery(n.title, query);
  }

  // --- Zoom + pan (T04) ------------------------------------------------------

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const g = screenToGraph(px, py, transform);
    const k = clampScale(transform.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    // Recompute translate so the graph point under the cursor stays put.
    transform = { k, x: px - g.x * k, y: py - g.y * k };
  }

  function zoomAboutCenter(factor: number): void {
    const cx = w / 2;
    const cy = h / 2;
    const g = screenToGraph(cx, cy, transform);
    const k = clampScale(transform.k * factor);
    transform = { k, x: cx - g.x * k, y: cy - g.y * k };
  }

  function resetView(): void {
    transform = { k: 1, x: 0, y: 0 };
  }

  function onBackgroundPointerDown(e: PointerEvent): void {
    const svg = e.currentTarget as SVGSVGElement;
    svg.setPointerCapture?.(e.pointerId);
    panState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origX: transform.x,
      origY: transform.y,
      moved: false,
    };
  }

  function onBackgroundPointerMove(e: PointerEvent): void {
    if (!panState || panState.pointerId !== e.pointerId) return;
    const dx = e.clientX - panState.startX;
    const dy = e.clientY - panState.startY;
    if (movedBeyondThreshold(dx, dy)) panState.moved = true;
    transform = { ...transform, x: panState.origX + dx, y: panState.origY + dy };
  }

  function onBackgroundPointerUp(e: PointerEvent): void {
    if (!panState || panState.pointerId !== e.pointerId) return;
    const wasPan = panState.moved;
    panState = null;
    // A background click (no pan) clears the selection.
    if (!wasPan) selectedId = null;
  }

  // --- Directed-edge geometry (T05) ------------------------------------------

  // Pull the arrow-tip back off the target so the marker isn't buried under
  // the node circle.
  function edgeEnd(e: SimEdge): { x: number; y: number } {
    const dx = e.target.x - e.source.x;
    const dy = e.target.y - e.source.y;
    const len = Math.hypot(dx, dy) || 1;
    const off = nodeRadius(e.target) + 6;
    return { x: e.target.x - (dx / len) * off, y: e.target.y - (dy / len) * off };
  }

  function edgeIncident(e: SimEdge): boolean {
    return selectedId != null && (e.source.id === selectedId || e.target.id === selectedId);
  }

  function edgeDimmed(e: SimEdge): boolean {
    return selectedId != null && !edgeIncident(e);
  }

  // Edge click selects its SOURCE. Selection already lights the source's whole
  // neighbourhood (which includes this edge's target), so the pair reads as
  // highlighted while the panel shows the "from" doc — the natural subject of
  // an "A → B" link.
  function onEdgeClick(e: MouseEvent, edge: SimEdge): void {
    e.preventDefault();
    e.stopPropagation();
    selectedId = edge.source.id;
  }

  // Build once on mount. Reading nothing reactive here keeps it to one run —
  // build()'s later reads of w/h happen after `await`, so they aren't tracked.
  $effect(() => {
    measure();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver === "function" && container) {
      ro = new ResizeObserver(() => onResize());
      ro.observe(container);
    }
    void build();
    return () => {
      destroyed = true;
      ro?.disconnect();
      clearTimeout(resizeTimer);
      sim?.stop();
    };
  });
</script>

<div class="link-graph-root">
  <!-- Gate the toolbar/legend on the MASTER set: filters can empty the visible
       set, and the controls to undo that must not vanish with it. -->
  {#if !loading && !error && masterNodes.length > 0}
    <div class="link-graph-toolbar">
      <label class="link-graph-field">
        <span>Color by</span>
        <select value={colorMode} onchange={onColorModeChange} aria-label="Color nodes by">
          <option value="state">State</option>
          <option value="tag">Tag</option>
          <option value="kind">Kind</option>
        </select>
      </label>
      <label class="link-graph-field">
        <span>Size by</span>
        <select value={sizeMode} onchange={onSizeModeChange} aria-label="Size nodes by">
          <option value="degree">Degree</option>
          <option value="backlinks">Backlinks</option>
          <option value="recency">Recency</option>
        </select>
      </label>
      <span class="link-graph-search">
        <svg class="link-graph-search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <!-- eslint-disable-next-line svelte/no-at-html-tags — static path data from icons.ts, never user input -->
          {@html TOOLBAR_ICONS.funnel}
        </svg>
        <input
          type="search"
          placeholder="Search titles…"
          bind:value={query}
          aria-label="Search paper titles"
        />
      </span>
      <label class="link-graph-check">
        <input type="checkbox" checked={showArchived} onchange={onShowArchivedChange} />
        Show archived
      </label>
      <button
        type="button"
        class="link-graph-reheat"
        onclick={reheat}
        title="Release pinned nodes and re-run the layout">Reheat</button
      >
    </div>
    {#if legend.length > 0}
      <div class="link-graph-legend" role="group" aria-label="Legend and category filter">
        {#each legend as item (item.key)}
          <button
            type="button"
            class="link-graph-swatch"
            class:off={activeCategories.has(item.key)}
            aria-pressed={!activeCategories.has(item.key)}
            onclick={() => toggleCategory(item.key)}
            title={activeCategories.has(item.key) ? `Show ${item.label}` : `Hide ${item.label}`}
          >
            <span class="link-graph-swatch-dot" style="background: {item.color}"></span>
            <span class="link-graph-swatch-label">{item.label}</span>
            <span class="link-graph-swatch-count">{item.count}</span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}
  <div class="link-graph-body">
    <div class="link-graph" bind:this={container}>
    {#if loading}
      <div class="link-graph-state">Loading…</div>
    {:else if error}
      <div class="link-graph-state link-graph-error">{error}</div>
    {:else if nodes.length === 0}
      <div class="link-graph-state link-graph-empty">
        {masterNodes.length === 0 ? "No links yet." : "Every paper is filtered out."}
      </div>
    {:else}
      <svg
        class="link-graph-svg"
        viewBox="0 0 {w} {h}"
        width={w}
        height={h}
        role="img"
        aria-label="Link graph"
        aria-describedby="link-graph-summary"
        onwheel={onWheel}
        onpointerdown={onBackgroundPointerDown}
        onpointermove={onBackgroundPointerMove}
        onpointerup={onBackgroundPointerUp}
      >
        <desc id="link-graph-summary">{nodes.length} papers, {edges.length} links</desc>
        <defs>
          <!-- Arrowhead inherits each line's stroke via context-stroke, so a
               dimmed edge's arrow dims with it. userSpaceOnUse keeps it a
               fixed size regardless of the line's stroke-width. -->
          <marker
            id="link-graph-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
          </marker>
        </defs>
        <g class="link-graph-viewport" transform="translate({transform.x} {transform.y}) scale({transform.k})">
          <g class="link-graph-edges">
            {#each edges as e (`${e.source.id}-${e.target.id}`)}
              {@const end = edgeEnd(e)}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <line
                x1={e.source.x}
                y1={e.source.y}
                x2={end.x}
                y2={end.y}
                stroke-width={Math.min(1 + e.occurrences, 6)}
                marker-end="url(#link-graph-arrow)"
                class:dimmed={edgeDimmed(e)}
                class:emphasized={edgeIncident(e)}
                onclick={(ev) => onEdgeClick(ev, e)}
              >
                <title>{e.source.title} → {e.target.title} · ×{e.occurrences}</title>
              </line>
            {/each}
          </g>
          <g class="link-graph-nodes">
            {#each nodes as n (n.id)}
              <a
                href="/-/paper/doc/{n.id}"
                class:muted={isMuted(n.state)}
                class:selected={n.id === selectedId}
                class:dimmed={nodeDimmed(n)}
                onpointerdown={(e) => onNodePointerDown(e, n)}
                onpointermove={(e) => onNodePointerMove(e, n)}
                onpointerup={(e) => onNodePointerUp(e, n)}
                onclick={(e) => onNodeClick(e, n)}
                ondblclick={(e) => onNodeDblClick(e, n)}
              >
                {#if n.pinned}
                  <circle class="pin-ring" cx={n.x} cy={n.y} r={nodeRadius(n) + 3} />
                {/if}
                <circle cx={n.x} cy={n.y} r={nodeRadius(n)} style={nodeFillStyle(n)}>
                  <title>{n.title}</title>
                </circle>
                <text x={n.x} y={n.y - nodeRadius(n) - 4} text-anchor="middle">
                  {n.title}
                </text>
              </a>
            {/each}
          </g>
        </g>
      </svg>

      <div class="link-graph-zoom" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom in" onclick={() => zoomAboutCenter(1.2)}>+</button>
        <button type="button" aria-label="Zoom out" onclick={() => zoomAboutCenter(1 / 1.2)}
          >−</button
        >
        <button type="button" onclick={resetView}>Reset</button>
      </div>
    {/if}
    </div>

    {#if !loading && !error && nodes.length > 0}
    <aside class="link-graph-panel" aria-label="Selected paper">
      {#if selectedNode}
        <h3 class="link-graph-panel-title">{selectedNode.title}</h3>
        <dl class="link-graph-meta">
          <div>
            <dt>Kind</dt>
            <dd>{selectedNode.kind || "—"}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{selectedNode.state}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{selectedNode.updated_at ? relativeTime(selectedNode.updated_at) : "—"}</dd>
          </div>
          <div>
            <dt>Links</dt>
            <dd>{selectedCounts.out} out · {selectedCounts.in} in</dd>
          </div>
        </dl>
        {#if selectedNode.tags?.length}
          <div class="link-graph-tags">
            {#each selectedNode.tags as t (t)}
              <span class="link-graph-tag">{t}</span>
            {/each}
          </div>
        {/if}
        <label class="link-graph-pin">
          <input
            type="checkbox"
            checked={selectedNode.pinned ?? false}
            onchange={() => selectedNode && togglePin(selectedNode)}
          />
          Pinned
        </label>
        <a class="link-graph-open" href="/-/paper/doc/{selectedNode.id}">Open</a>
      {:else}
        <p class="link-graph-panel-empty">Select a node to see its details.</p>
      {/if}
    </aside>
    {/if}
  </div>
</div>

<style>
  .link-graph-root {
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-family: inherit;
  }
  .link-graph-body {
    display: flex;
    gap: 12px;
    align-items: stretch;
  }
  .link-graph {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 360px;
    touch-action: none;
  }
  /* --- Toolbar + legend (T06 / T07) chrome: all themed via --pp-* tokens
       so it reads on both the light and dark canvas; the Okabe–Ito fills sit
       only on the SVG nodes/swatch dots. --- */
  .link-graph-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    font-size: 13px;
    color: var(--pp-fg);
  }
  .link-graph-field {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .link-graph-field > span {
    color: var(--pp-fg-subtle);
  }
  .link-graph-field select,
  .link-graph-search input {
    border: 1px solid var(--pp-border);
    background: var(--pp-bg);
    color: var(--pp-fg);
    border-radius: 4px;
    padding: 3px 6px;
    font: inherit;
    font-size: 13px;
  }
  .link-graph-search {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .link-graph-search-icon {
    position: absolute;
    left: 7px;
    fill: var(--pp-fg-subtle);
    pointer-events: none;
  }
  .link-graph-search input {
    padding-left: 26px;
  }
  .link-graph-check {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--pp-fg);
  }
  .link-graph-reheat {
    margin-left: auto;
    border: 1px solid var(--pp-border);
    background: var(--pp-bg);
    color: var(--pp-fg);
    border-radius: 4px;
    padding: 3px 10px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .link-graph-reheat:hover {
    background: var(--pp-surface-2);
  }
  .link-graph-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .link-graph-swatch {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--pp-border);
    background: var(--pp-surface);
    color: var(--pp-fg);
    border-radius: 12px;
    padding: 2px 9px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .link-graph-swatch:hover {
    background: var(--pp-surface-2);
  }
  /* Toggled-off category: greyed + struck so the hidden state reads clearly. */
  .link-graph-swatch.off {
    opacity: 0.45;
  }
  .link-graph-swatch.off .link-graph-swatch-label {
    text-decoration: line-through;
  }
  .link-graph-swatch-dot {
    width: 11px;
    height: 11px;
    border-radius: 3px;
    flex: 0 0 auto;
  }
  .link-graph-swatch-count {
    color: var(--pp-fg-subtle);
    font-variant-numeric: tabular-nums;
  }
  .link-graph-panel {
    flex: 0 0 200px;
    border-left: 1px solid var(--pp-border);
    padding-left: 12px;
    font-size: 13px;
    color: var(--pp-fg);
  }
  .link-graph-panel-title {
    margin: 0 0 8px;
    font-size: 1em;
    font-weight: 600;
  }
  .link-graph-panel-empty {
    color: var(--pp-fg-subtle);
    font-style: italic;
    margin: 0;
  }
  .link-graph-meta {
    margin: 0 0 8px;
  }
  .link-graph-meta > div {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 0;
  }
  .link-graph-meta dt {
    color: var(--pp-fg-subtle);
    margin: 0;
  }
  .link-graph-meta dd {
    margin: 0;
    text-align: right;
  }
  .link-graph-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }
  .link-graph-tag {
    background: var(--pp-surface-2);
    border-radius: 10px;
    padding: 1px 8px;
    font-size: 12px;
  }
  .link-graph-pin {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 10px;
  }
  .link-graph-open {
    display: inline-block;
    padding: 4px 10px;
    border-radius: 4px;
    background: var(--pp-accent);
    color: #fff;
    text-decoration: none;
    font-weight: 500;
  }
  .link-graph-open:hover {
    /* deliberate literal: hover-darken of --pp-accent, no dedicated token. */
    background: #08407a;
  }
  .link-graph-state {
    color: var(--pp-fg-subtle);
    padding: 12px 0;
  }
  .link-graph-empty {
    font-style: italic;
  }
  /* deliberate literal: one-off error red, distinct from --pp-danger. */
  .link-graph-error {
    color: #8a2a2a;
  }
  .link-graph-svg {
    max-width: 100%;
    height: auto;
    display: block;
    touch-action: none;
  }
  .link-graph-zoom {
    position: absolute;
    bottom: 8px;
    right: 8px;
    display: flex;
    gap: 4px;
  }
  .link-graph-zoom button {
    border: 1px solid var(--pp-border);
    background: var(--pp-bg);
    color: var(--pp-fg);
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 13px;
    line-height: 1.4;
    cursor: pointer;
  }
  .link-graph-zoom button:hover {
    background: var(--pp-surface-2);
  }
  .link-graph-nodes a {
    cursor: pointer;
  }
  /* deliberate literal: the graph's own grey ramp for edges and muted (linked-
     but-not-current) nodes — no matching role token. The live node fill and its
     accent-hover map to the palette. */
  .link-graph-edges line {
    stroke: #c0c8d0;
    cursor: pointer;
  }
  .link-graph-edges line.emphasized {
    /* deliberate literal: darker grey to lift the selected node's own edges. */
    stroke: #6b7580;
  }
  .link-graph-edges line.dimmed {
    opacity: 0.2;
  }
  .link-graph-nodes circle {
    fill: var(--pp-accent);
    transition:
      fill 0.1s ease,
      opacity 0.1s ease;
  }
  .link-graph-nodes a.muted circle {
    fill: #cbd2da;
  }
  .link-graph-nodes a:hover circle {
    /* deliberate literal: hover-darken of --pp-accent, no dedicated hover token. */
    fill: #08407a;
  }
  .link-graph-nodes a.muted:hover circle {
    fill: #aab3bc;
  }
  .link-graph-nodes a.dimmed {
    opacity: 0.25;
  }
  .link-graph-nodes a.selected circle {
    /* deliberate literal: selection ring, darker accent stroke. */
    stroke: #08407a;
    stroke-width: 2.5;
  }
  .link-graph-nodes circle.pin-ring {
    fill: none;
    /* deliberate literal: pin-state ring, a warm accent distinct from the
       blue selection stroke so pinned + selected read differently. */
    stroke: #d08214;
    stroke-width: 2;
  }
  .link-graph-nodes text {
    font-size: 11px;
    fill: var(--pp-fg);
    pointer-events: none;
    user-select: none;
  }
  .link-graph-nodes a.muted text {
    fill: var(--pp-fg-subtle);
  }
</style>
