import { mount } from "svelte";
import PaperApp from "../../lib/PaperApp.svelte";
import { loadPageData } from "../../lib/pageData";
import {
  setProviderManifest,
  type ProviderManifestEntry,
} from "../../lib/embedProviders";
import "../../app.css";
import "./paper_layout.css";

const { doc_id, embed_providers } = loadPageData<{
  doc_id: number;
  embed_providers?: ProviderManifestEntry[];
}>();

// Third-party embed providers are lazy-loaded from this manifest on demand
// (when the doc uses one / the author picks one), not injected up front.
setProviderManifest(embed_providers);

mount(PaperApp, {
  target: document.getElementById("app-root")!,
  props: { docId: String(doc_id) },
});
