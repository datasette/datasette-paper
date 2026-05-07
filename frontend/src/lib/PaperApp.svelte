<script lang="ts">
  import { onDestroy } from "svelte";
  import type { EditorView } from "prosemirror-view";
  import { EditorConnection } from "./collab";
  import type { BootstrapPermissions } from "./collab";
  import { Reporter } from "./reporter";
  import type { ReporterState } from "./reporter";
  import Toolbar from "./Toolbar.svelte";
  import DocHeader from "./DocHeader.svelte";

  let { docId }: { docId: string } = $props();

  let editorEl: HTMLDivElement | undefined = $state(undefined);

  type StatusObj = { state: ReporterState; message: string };
  let status: StatusObj = $state({ state: "ok", message: "" });
  let view: EditorView | null = $state(null);
  let users = $state(0);
  let mode: "edit" | "view" = $state("edit");
  let permissions = $state<BootstrapPermissions | null>(null);
  // Read-only when the server says canEdit=false. When this flips on we
  // also force mode='view' so the toggle reflects reality.
  let canEdit = $derived(permissions?.canEdit ?? true);

  let conn: EditorConnection | undefined;
  let unsub: (() => void) | undefined;

  $effect(() => {
    if (!editorEl) return;

    const reporter = new Reporter();
    unsub = reporter.subscribe((s: ReporterState, m: string) => {
      status = { state: s, message: m };
    });

    conn = new EditorConnection(
      {
        docId,
        place: editorEl,
        onView: (v) => {
          view = v;
        },
        onUsers: (n) => {
          users = n;
        },
        onPermissions: (p) => {
          permissions = p;
          if (!p.canEdit) mode = "view";
        },
      },
      reporter,
    );

    return () => {
      unsub?.();
      conn?.close();
    };
  });

  // Push mode changes into the connection. Tracked separately from the
  // setup effect so we don't tear down the editor on every flip. The
  // server-side permission overrides any local toggle: if canEdit is
  // false, the editor stays read-only regardless of mode state.
  $effect(() => {
    conn?.setEditable(canEdit && mode === "edit");
  });

  async function copyMarkdown(): Promise<boolean> {
    if (!view) return false;
    try {
      // Lazy-load prosemirror-markdown — it bundles markdown-it for the
      // parser side that we don't use here, ~50k gzipped. Code-split so
      // it only downloads when the user actually clicks copy.
      const { defaultMarkdownSerializer, MarkdownSerializer } = await import(
        "prosemirror-markdown"
      );
      // Extend the default serializer with rules for our custom task_list
      // / task_item nodes. GFM-style `- [ ] foo` / `- [x] foo`.
      const serializer = new MarkdownSerializer(
        {
          ...defaultMarkdownSerializer.nodes,
          task_list(state, node) {
            state.renderList(node, "  ", () => "");
          },
          task_item(state, node) {
            const marker = node.attrs.checked ? "- [x] " : "- [ ] ";
            state.write(marker);
            state.renderContent(node);
          },
        },
        defaultMarkdownSerializer.marks,
      );
      const md = serializer.serialize(view.state.doc);
      await navigator.clipboard.writeText(md);
      return true;
    } catch {
      return false;
    }
  }

  onDestroy(() => {
    unsub?.();
    conn?.close();
  });
</script>

<div class="datasette-paper-app" class:view-mode={mode === "view"}>
  <DocHeader {docId} {users} bind:mode {canEdit} {copyMarkdown} />
  {#if status.state !== "ok"}
    <div class="status-banner status-{status.state}">{status.message}</div>
  {/if}
  {#if canEdit && mode === "edit"}
    <Toolbar {view} />
  {/if}
  <div class="editor-host" bind:this={editorEl}></div>
</div>

<style>
  .datasette-paper-app {
    max-width: 740px;
    margin: 0 auto;
    padding: 0 16px;
  }
  .status-banner {
    padding: 6px 10px;
    font-size: 13px;
    border-radius: 4px;
    margin-bottom: 8px;
  }
  .status-banner.status-delay {
    background: #fff5d4;
    color: #5a4a00;
  }
  .status-banner.status-fail {
    background: #ffd6d6;
    color: #5a0000;
  }
  /* In fullscreen layout the host gets flex:1; make the ProseMirror
   * surface stretch to fill it instead of capping at min-height: 60vh. */
  .editor-host {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .editor-host :global(.ProseMirror) {
    flex: 1;
    min-height: 60vh;
    padding: 8px 0;
    border: none;
    outline: none;
    font-size: 16px;
    line-height: 1.65;
    color: #1a1a1a;
  }
  .editor-host :global(.ProseMirror p) {
    margin: 0 0 0.75em;
  }
  .editor-host :global(.ProseMirror h1) {
    font-size: 1.9em;
    line-height: 1.25;
    margin: 0.6em 0 0.3em;
  }
  .editor-host :global(.ProseMirror h2) {
    font-size: 1.4em;
    line-height: 1.3;
    margin: 0.8em 0 0.3em;
  }
  /* Heading-fold chevron (rendered as a Decoration.widget by foldHeadings.ts).
   * Sits in the heading's left gutter via a negative absolute offset; the
   * heading itself is the positioning ancestor. Hidden until hover for
   * unfolded sections so it doesn't clutter, but always shown when folded
   * so users can see something is collapsed. */
  .editor-host :global(.ProseMirror h1),
  .editor-host :global(.ProseMirror h2),
  .editor-host :global(.ProseMirror h3),
  .editor-host :global(.ProseMirror h4),
  .editor-host :global(.ProseMirror h5),
  .editor-host :global(.ProseMirror h6) {
    position: relative;
  }
  .editor-host :global(.pm-fold-toggle) {
    position: absolute;
    left: -22px;
    top: 0.45em;
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: #999;
    cursor: pointer;
    padding: 0;
    opacity: 0;
    transition: opacity 0.1s, background 0.1s;
  }
  .editor-host :global(h1:hover .pm-fold-toggle),
  .editor-host :global(h2:hover .pm-fold-toggle),
  .editor-host :global(h3:hover .pm-fold-toggle),
  .editor-host :global(h4:hover .pm-fold-toggle),
  .editor-host :global(h5:hover .pm-fold-toggle),
  .editor-host :global(h6:hover .pm-fold-toggle),
  .editor-host :global(.pm-fold-toggle:focus) {
    opacity: 1;
  }
  /* Always-visible chevron when the section is folded — the icon then
   * points right (▸), making the folded state legible at a glance. */
  .editor-host :global(.pm-fold-toggle[aria-label="Unfold section"]) {
    opacity: 1;
    color: #666;
  }
  .editor-host :global(.pm-fold-toggle:hover) {
    background: #f0f3f6;
    color: #333;
  }
  /* Blocks hidden under a folded heading. */
  .editor-host :global(.pm-folded) {
    display: none;
  }

  /* Datasette's base app.css resets `ol, ul { list-style: none }`. Restore
   * bullets/numbers inside the editor so prosemirror-schema-list's bullet_list
   * and ordered_list render correctly. */
  .editor-host :global(.ProseMirror ul) {
    list-style: disc;
    padding-left: 1.5em;
  }
  .editor-host :global(.ProseMirror ul ul) { list-style: circle; }
  .editor-host :global(.ProseMirror ul ul ul) { list-style: square; }
  .editor-host :global(.ProseMirror ol) {
    list-style: decimal;
    padding-left: 1.5em;
  }
  /* Tighten vertical rhythm inside list items. ProseMirror wraps each item's
   * text in a <p>, which inherits the global `.ProseMirror p` 0.75em bottom
   * margin and makes `- ` / `[ ] ` stacks look airy. Zero it out here; the
   * 1.65 line-height already gives adequate visual separation. */
  .editor-host :global(.ProseMirror li > p),
  .editor-host :global(.ProseMirror .task-item-content > p) {
    margin: 0;
  }
  /* Task lists draw their own checkbox; keep them marker-less and override
   * the bullet rule above. */
  .editor-host :global(ul[data-task-list]) {
    list-style: none;
    padding-left: 1.5em;
  }
  .editor-host :global(li[data-task-item]) {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
  }
  .editor-host :global(li[data-task-item] > input[type="checkbox"]) {
    margin-top: 0.45em;
    flex-shrink: 0;
    cursor: pointer;
  }
  .editor-host :global(li[data-task-item] > .task-item-content) {
    flex: 1;
    min-width: 0;
  }
  .editor-host :global(li[data-task-item][data-checked="true"] > .task-item-content) {
    text-decoration: line-through;
    color: #888;
  }
</style>
