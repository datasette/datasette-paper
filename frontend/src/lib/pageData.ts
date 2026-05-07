/**
 * Read the JSON page-data blob the server emits inside the base template:
 *   <script type="application/json" id="pageData">{...}</script>
 */
export function loadPageData<T>(): T {
  const script = document.querySelector<HTMLScriptElement>("#pageData");
  if (!script) throw new Error("Page data script not found");
  return JSON.parse(script.textContent || "{}") as T;
}
