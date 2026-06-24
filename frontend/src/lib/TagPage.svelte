<script lang="ts">
  /**
   * Inline-tag search results page. Fetches `/-/paper/api/tags/{slug}/refs`
   * (ACL-filtered server-side) and lists every doc whose BODY contains the
   * `#slug` inline tag. This is a separate namespace from the doc-level
   * `?tag=` filter on the index page.
   */
  import { onMount } from "svelte";
  import { client } from "./client";

  let { tag }: { tag: string } = $props();

  type TagDoc = {
    id: number;
    name: string;
    state: string;
    kind: string;
    occurrences: number;
    updated_at: string;
  };

  let docs = $state<TagDoc[] | null>(null);
  let error = $state<string | null>(null);

  onMount(async () => {
    const { data, error: err } = await client.GET(
      "/-/paper/api/tags/{tag}/refs",
      { params: { path: { tag } } },
    );
    if (err || !data) {
      error = "Could not load results for this tag.";
      docs = [];
      return;
    }
    docs = (data as unknown as { docs: TagDoc[] }).docs ?? [];
  });
</script>

<main class="tag-page">
  <h1>
    Documents tagged <span class="pm-tag">#{tag}</span>
  </h1>

  {#if docs === null}
    <p class="tag-page-status">Loading…</p>
  {:else if error}
    <p class="tag-page-status tag-page-error">{error}</p>
  {:else if docs.length === 0}
    <p class="tag-page-status">No documents contain <code>#{tag}</code>.</p>
  {:else}
    <ul class="tag-page-list">
      {#each docs as doc (doc.id)}
        <li class="tag-page-row">
          <a href="/-/paper/doc/{doc.id}">{doc.name || `Paper ${doc.id}`}</a>
          <span class="tag-page-count">
            {doc.occurrences}
            {doc.occurrences === 1 ? "mention" : "mentions"}
          </span>
          {#if doc.state !== "active"}
            <span class="tag-page-state">{doc.state}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <p class="tag-page-back"><a href="/-/paper">← All papers</a></p>
</main>

<style>
  .tag-page {
    max-width: 760px;
    margin: 2rem auto;
    padding: 0 1rem;
  }
  .tag-page h1 {
    font-size: 1.5rem;
    margin-bottom: 1rem;
  }
  .tag-page-status {
    color: #6b7280;
  }
  .tag-page-error {
    color: #b91c1c;
  }
  .tag-page-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .tag-page-row {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid #e5e7eb;
  }
  .tag-page-row a {
    font-weight: 500;
  }
  .tag-page-count {
    color: #6b7280;
    font-size: 0.85rem;
  }
  .tag-page-state {
    color: #92400e;
    background: #fef3c7;
    border-radius: 4px;
    padding: 0 0.4rem;
    font-size: 0.75rem;
  }
  .tag-page-back {
    margin-top: 1.5rem;
  }
</style>
