<script lang="ts" module>
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
   * Pure gate for the animated render path. Live if the platform can drive
   * rAF ticks and the viewer hasn't asked to reduce motion. Callers pass
   * `reduceMotion = true` when the preference can't be read (no `matchMedia`,
   * e.g. jsdom) so we fall back to the synchronous settle — the honest
   * reduced-motion behaviour and what the non-ticking render test depends on.
   */
  export function shouldAnimate(hasRaf: boolean, reduceMotion: boolean): boolean {
    return hasRaf && !reduceMotion;
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
   */

  // Type-only import: erased at build, so it does NOT pull d3-force onto the
  // top-level bundle — the runtime import stays dynamic inside build().
  import type { Simulation, ForceCenter } from "d3-force";

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

  // Node shape after d3 mutates it with layout coordinates.
  type SimNode = GraphNode & { x: number; y: number };
  // Edge shape after d3 replaces source/target ids with node refs.
  type SimEdge = {
    source: SimNode;
    target: SimNode;
    occurrences: number;
  };

  // Fallback dims when the container has no measured size yet (jsdom / pre-
  // layout). Real dimensions come from the ResizeObserver below.
  const DEFAULT_WIDTH = 640;
  const DEFAULT_HEIGHT = 480;
  const TICKS = 300;

  let loading = $state(true);
  let error = $state<string | null>(null);
  let nodes = $state<SimNode[]>([]);
  let edges = $state<SimEdge[]>([]);
  let w = $state(DEFAULT_WIDTH);
  let h = $state(DEFAULT_HEIGHT);

  let container: HTMLDivElement;
  // Hoisted so the resize handler + effect teardown can reach the live sim.
  let sim: Simulation<SimNode, undefined> | null = null;
  let centerForce: ForceCenter<SimNode> | null = null;
  let animated = false;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  // Plain (non-reactive) Map: it is always assigned before `nodes` (the
  // reactive trigger for a render), so the render reads the current value.
  // Kept out of `$state` to avoid the SvelteMap reactivity lint while still
  // letting computeDegree return a vanilla Map per its contract.
  let degree = new Map<number, number>();

  function radius(id: number): number {
    const d = degree.get(id) ?? 0;
    return 6 + Math.min(d, 12) * 1.5;
  }

  function isMuted(state: string): boolean {
    return state === "archived" || state === "trashed";
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
      const rawEdges = data.edges ?? [];

      // Degree from the RAW edges (ids stable) before d3 mutates copies.
      degree = computeDegree(rawNodes, rawEdges);

      if (rawNodes.length === 0) {
        nodes = [];
        edges = [];
        return;
      }

      // d3 mutates the objects it's handed (adds x/y/vx/vy on nodes,
      // swaps source/target ids for node refs on links), so feed it copies.
      const simNodes = rawNodes.map((n) => ({ ...n })) as SimNode[];
      const simEdges = rawEdges.map((e) => ({ ...e })) as unknown as SimEdge[];

      const { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide } =
        await import("d3-force");

      animated = shouldAnimate(
        typeof requestAnimationFrame === "function",
        prefersReducedMotion(),
      );

      centerForce = forceCenter<SimNode>(w / 2, h / 2);
      sim = forceSimulation(simNodes)
        .force(
          "link",
          forceLink(simEdges)
            .id((d) => (d as SimNode).id)
            .distance(80),
        )
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

<div class="link-graph" bind:this={container}>
  {#if loading}
    <div class="link-graph-state">Loading…</div>
  {:else if error}
    <div class="link-graph-state link-graph-error">{error}</div>
  {:else if nodes.length === 0}
    <div class="link-graph-state link-graph-empty">No links yet.</div>
  {:else}
    <svg
      class="link-graph-svg"
      viewBox="0 0 {w} {h}"
      width={w}
      height={h}
      role="img"
      aria-label="Link graph"
    >
      <g class="link-graph-edges">
        {#each edges as e (`${e.source.id}-${e.target.id}`)}
          <line
            x1={e.source.x}
            y1={e.source.y}
            x2={e.target.x}
            y2={e.target.y}
            stroke-width={Math.min(1 + e.occurrences, 6)}
          />
        {/each}
      </g>
      <g class="link-graph-nodes">
        {#each nodes as n (n.id)}
          <a href="/-/paper/doc/{n.id}" class:muted={isMuted(n.state)}>
            <circle cx={n.x} cy={n.y} r={radius(n.id)}>
              <title>{n.title}</title>
            </circle>
            <text x={n.x} y={n.y - radius(n.id) - 4} text-anchor="middle">
              {n.title}
            </text>
          </a>
        {/each}
      </g>
    </svg>
  {/if}
</div>

<style>
  .link-graph {
    font-family: inherit;
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
  }
  .link-graph-nodes a {
    cursor: pointer;
  }
  /* deliberate literal: the graph's own grey ramp for edges and muted (linked-
     but-not-current) nodes — no matching role token. The live node fill and its
     accent-hover map to the palette. */
  .link-graph-edges line {
    stroke: #c0c8d0;
  }
  .link-graph-nodes circle {
    fill: var(--pp-accent);
    transition: fill 0.1s ease;
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
