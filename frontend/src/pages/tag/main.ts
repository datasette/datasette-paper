import { mount } from "svelte";
import TagPage from "../../lib/TagPage.svelte";
import { loadPageData } from "../../lib/pageData";
import "../../app.css";

const { tag } = loadPageData<{ tag: string }>();

mount(TagPage, {
  target: document.getElementById("app-root")!,
  props: { tag },
});
