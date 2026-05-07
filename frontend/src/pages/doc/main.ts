import { mount } from "svelte";
import PaperApp from "../../lib/PaperApp.svelte";
import { loadPageData } from "../../lib/pageData";
import "../../app.css";
import "./paper_layout.css";

const { doc_id } = loadPageData<{ doc_id: number }>();

mount(PaperApp, {
  target: document.getElementById("app-root")!,
  props: { docId: String(doc_id) },
});
