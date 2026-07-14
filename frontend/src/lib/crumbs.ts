/**
 * Header-breadcrumb updater.
 *
 * The crumb ("Papers / <name>") is server-rendered by paper_base.html's
 * crumbs block and lives in Datasette's own <header class="hd">, outside
 * #app-root — so no Svelte component owns it and updates are imperative.
 * Called on our own rename commit (DocHeader) and on a collaborator's
 * rename arriving over SSE (PaperApp's onRenamed).
 *
 * @feat breadcrumbs: client half of the live crumb rename — also keeps
 * document.title in step with the crumb.
 */
export function setCrumbName(name: string): void {
  const el = document.getElementById("paper-crumb-current");
  if (el) el.textContent = name;
  document.title = name;
}
