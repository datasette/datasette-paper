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
  let nodes = $state<SimNode[]>([]);
  let edges = $state<SimEdge[]>([]);
  let w = $state(DEFAULT_WIDTH);
  let h = $state(DEFAULT_HEIGHT);

  // Selection + view transform (T05 / T04).
  let selectedId = $state<number | null>(null);
  let transform = $state<Transform>({ k: 1, x: 0, y: 0 });

  let container: HTMLDivElement;
  // Hoisted so the resize handler + effect teardown can reach the live sim.
  let sim: Simulation<SimNode, undefined> | null = null;
  let centerForce: ForceCenter<SimNode> | null = null;
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
      rawEdges = data.edges ?? [];

      // Degrees from the RAW edges (ids stable) before d3 mutates copies.
      degree = computeDegree(rawNodes, rawEdges);
      dirDegree = directedDegree(rawNodes, rawEdges);

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
    const off = radius(e.target.id) + 6;
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
                class:dimmed={isDimmed(n.id, selectedId, neighborIds)}
                onpointerdown={(e) => onNodePointerDown(e, n)}
                onpointermove={(e) => onNodePointerMove(e, n)}
                onpointerup={(e) => onNodePointerUp(e, n)}
                onclick={(e) => onNodeClick(e, n)}
                ondblclick={(e) => onNodeDblClick(e, n)}
              >
                {#if n.pinned}
                  <circle class="pin-ring" cx={n.x} cy={n.y} r={radius(n.id) + 3} />
                {/if}
                <circle cx={n.x} cy={n.y} r={radius(n.id)}>
                  <title>{n.title}</title>
                </circle>
                <text x={n.x} y={n.y - radius(n.id) - 4} text-anchor="middle">
                  {n.title}
                </text>
              </a>
            {/each}
          </g>
        </g>
      </svg>

      <div class="link-graph-controls">
        <button type="button" onclick={reheat} title="Release pinned nodes and re-run the layout"
          >Reheat</button
        >
      </div>

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

<style>
  .link-graph-root {
    display: flex;
    gap: 12px;
    align-items: stretch;
    font-family: inherit;
  }
  .link-graph {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 360px;
    touch-action: none;
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
  .link-graph-controls {
    position: absolute;
    top: 8px;
    left: 8px;
  }
  .link-graph-zoom {
    position: absolute;
    bottom: 8px;
    right: 8px;
    display: flex;
    gap: 4px;
  }
  .link-graph-controls button,
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
  .link-graph-controls button:hover,
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
