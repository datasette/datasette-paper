<script lang="ts">
  /**
   * Manager-only Publish dialog. Lets the owner publish a pinned version of the
   * doc as a static read-only page (`/-/paper/doc/<id>/publish`): choose the
   * default data mode (live vs frozen) + per-block overrides, pick the audience,
   * preview the rendered page, then Publish / Republish / Unpublish.
   *
   * All work goes through the typed publish API (client.ts). The preview
   * endpoint renders without persisting and returns the data blocks + their
   * resolved modes, which drives the per-block toggle list + the
   * sensitive-table warning shown when a block is set to frozen.
   */
  // The publish endpoints return ad-hoc JSON (not a typed response model), so
  // we call them with plain `fetch` + local types rather than the typed client
  // — the same approach DocHeader uses for `sweep-subscribers`. POSTs send
  // `Content-Type: application/json` (Datasette's skip_csrf requires it).
  let {
    open = $bindable(false),
    docId,
    onPublished,
  }: {
    open?: boolean;
    docId: string;
    onPublished?: (version: number | null) => void;
  } = $props();

  type Block = { block_id: string; kind: string; mode: string; label: string };
  type PreviewResp = { version: number; html: string; blocks: Block[] };
  type PubsResp = { published_version: number | null };
  type PublishResp = { version: number };

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`/-/paper/api/docs/${id}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  let dialogEl: HTMLDialogElement | undefined = $state();
  let loading = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  let version = $state<number | null>(null);
  let publishedVersion = $state<number | null>(null);
  let dataModeDefault = $state<"live" | "frozen">("live");
  let overrides = $state<Record<string, "live" | "frozen">>({});
  let audience = $state<"private" | "authenticated" | "public">("private");
  let blocks = $state<Block[]>([]);
  let previewHtml = $state("");

  const id = $derived(Number(docId));
  const dataBlocks = $derived(
    blocks.filter((b) => b.kind === "sql" || b.kind === "embed" || b.kind === "value"),
  );

  function modeFor(b: Block): "live" | "frozen" {
    return overrides[b.block_id] ?? dataModeDefault;
  }

  // Drive the native <dialog> from `open`, and (re)load a preview when opened.
  $effect(() => {
    const el = dialogEl;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      void loadStatus();
      void loadPreview();
    } else if (!open && el.open) {
      el.close();
    }
  });

  async function loadStatus() {
    const r = await fetch(`/-/paper/api/docs/${id}/publications`);
    if (!r.ok) return;
    const d = (await r.json()) as PubsResp;
    publishedVersion = d.published_version ?? null;
  }

  async function loadPreview() {
    loading = true;
    error = null;
    const r = await fetch(
      `/-/paper/api/docs/${id}/publish/preview?data_mode_default=${dataModeDefault}`,
    );
    loading = false;
    if (!r.ok) {
      error = "Could not render a preview.";
      return;
    }
    const d = (await r.json()) as PreviewResp;
    version = d.version;
    blocks = d.blocks ?? [];
    previewHtml = d.html ?? "";
  }

  function audienceGrants() {
    if (audience === "public") return [{ principal: "everyone" }];
    if (audience === "authenticated") return [{ principal: "authenticated" }];
    return []; // private — only the publisher (auto-granted)
  }

  async function publish() {
    busy = true;
    error = null;
    const r = await postJson("/publish", {
      version: version ?? undefined,
      data_mode_default: dataModeDefault,
      block_overrides: overrides,
      audience: audienceGrants(),
    });
    busy = false;
    if (!r.ok) {
      error = "Publish failed.";
      return;
    }
    const d = (await r.json()) as PublishResp;
    publishedVersion = d.version;
    onPublished?.(publishedVersion);
    open = false;
  }

  async function unpublish() {
    busy = true;
    const r = await postJson("/unpublish", {});
    busy = false;
    if (!r.ok) {
      error = "Unpublish failed.";
      return;
    }
    publishedVersion = null;
    onPublished?.(null);
  }

  // Re-preview when the default mode changes (frozen results differ).
  let lastMode = $state<"live" | "frozen">("live");
  $effect(() => {
    if (open && dataModeDefault !== lastMode) {
      lastMode = dataModeDefault;
      void loadPreview();
    }
  });

  const anyFrozen = $derived(dataBlocks.some((b) => modeFor(b) === "frozen"));
</script>

<dialog
  bind:this={dialogEl}
  class="publish-dialog"
  onclose={() => (open = false)}
>
  <div class="pub-head">
    <strong>Publish</strong>
    <button type="button" class="pub-x" aria-label="Close" onclick={() => (open = false)}
      >×</button
    >
  </div>

  <p class="pub-version">
    {#if version !== null}
      Publishing <strong>version {version}</strong>.
    {/if}
    {#if publishedVersion !== null}
      <span class="pub-current">Currently published: v{publishedVersion}</span>
    {/if}
  </p>

  <section class="pub-section">
    <div class="pub-label">Data mode</div>
    <label
      ><input type="radio" bind:group={dataModeDefault} value="live" /> Live — each
      viewer runs the queries under their own permissions (safe; slower at scale)</label
    >
    <label
      ><input type="radio" bind:group={dataModeDefault} value="frozen" /> Frozen — run
      once now, bake results into the page (fast; shows your data to the audience)</label
    >
  </section>

  {#if dataBlocks.length}
    <section class="pub-section">
      <div class="pub-label">Data blocks</div>
      <ul class="pub-blocks">
        {#each dataBlocks as b (b.block_id)}
          <li>
            <span class="pub-block-label">{b.kind}: {b.label}</span>
            <select
              bind:value={
                () => modeFor(b),
                (v) => (overrides = { ...overrides, [b.block_id]: v as "live" | "frozen" })
              }
            >
              <option value="live">live</option>
              <option value="frozen">frozen</option>
            </select>
          </li>
        {/each}
      </ul>
      {#if anyFrozen}
        <p class="pub-warn" role="alert">
          ⚠ Frozen blocks bake <strong>your</strong> query results into the page — everyone
          in the audience sees them, including the listed databases / resources.
        </p>
      {/if}
    </section>
  {/if}

  <section class="pub-section">
    <div class="pub-label">Audience</div>
    <label><input type="radio" bind:group={audience} value="private" /> Just me (private)</label>
    <label
      ><input type="radio" bind:group={audience} value="authenticated" /> Anyone signed
      in</label
    >
    <label><input type="radio" bind:group={audience} value="public" /> Public (anyone)</label>
    <p class="pub-hint">
      Grants are additive — use <em>Share</em> to remove access. The publisher can always
      view the published page.
    </p>
  </section>

  <section class="pub-section">
    <div class="pub-label">Preview</div>
    {#if loading}
      <p class="pub-hint">Rendering…</p>
    {:else}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="pub-preview paper-published">{@html previewHtml}</div>
    {/if}
  </section>

  {#if error}
    <p class="pub-error" role="alert">{error}</p>
  {/if}

  <div class="pub-foot">
    {#if publishedVersion !== null}
      <a class="pub-view" href={`/-/paper/doc/${docId}/publish`} target="_blank">View ↗</a>
      <button type="button" class="pub-unpublish" disabled={busy} onclick={unpublish}
        >Unpublish</button
      >
    {/if}
    <span class="pub-spacer"></span>
    <button type="button" class="pub-cancel" onclick={() => (open = false)}>Cancel</button>
    <button type="button" class="pub-go" disabled={busy} onclick={publish}>
      {publishedVersion !== null ? "Republish" : "Publish"}
    </button>
  </div>
</dialog>

<style>
  .publish-dialog {
    width: min(620px, 94vw);
    border: 1px solid #d0d7de;
    border-radius: 10px;
    padding: 16px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
    font: inherit;
    color: #1a1a1a;
  }
  .publish-dialog::backdrop {
    background: rgba(0, 0, 0, 0.35);
  }
  .pub-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 15px;
  }
  .pub-x {
    border: none;
    background: transparent;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    color: #666;
  }
  .pub-version {
    margin: 0 0 12px;
    font-size: 13px;
    color: #444;
  }
  .pub-current {
    margin-left: 8px;
    color: #1a7f37;
  }
  .pub-section {
    margin: 14px 0;
  }
  .pub-label {
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 6px;
    color: #24292f;
  }
  .pub-section label {
    display: block;
    font-size: 13px;
    margin: 3px 0;
    color: #333;
  }
  .pub-blocks {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .pub-blocks li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 13px;
  }
  .pub-block-label {
    flex: 1;
    font-family: ui-monospace, monospace;
    color: #444;
  }
  .pub-warn {
    margin: 8px 0 0;
    padding: 6px 10px;
    background: #fff3cd;
    color: #664d03;
    border-radius: 6px;
    font-size: 12px;
  }
  .pub-hint {
    margin: 6px 0 0;
    font-size: 12px;
    color: #777;
  }
  .pub-preview {
    max-height: 220px;
    overflow: auto;
    border: 1px solid #e4e4e4;
    border-radius: 8px;
    padding: 8px 12px;
    background: #fff;
    font-size: 13px;
  }
  .pub-error {
    margin: 10px 0 0;
    padding: 6px 10px;
    background: #ffd6d6;
    color: #5a0000;
    border-radius: 6px;
    font-size: 12px;
  }
  .pub-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 16px;
  }
  .pub-spacer {
    flex: 1;
  }
  .pub-view {
    font-size: 13px;
    color: #0969da;
    text-decoration: none;
  }
  .pub-cancel,
  .pub-unpublish,
  .pub-go {
    padding: 6px 14px;
    border-radius: 999px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid #d0d7de;
    background: #fff;
    color: #333;
  }
  .pub-go {
    border-color: #0b5cad;
    background: #0b5cad;
    color: #fff;
  }
  .pub-go:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .pub-unpublish {
    border-color: #cf222e;
    color: #cf222e;
  }
</style>
