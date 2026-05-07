import { mount } from "svelte";
import PaperIndex from "../../lib/PaperIndex.svelte";
import "../../app.css";

mount(PaperIndex, {
  target: document.getElementById("app-root")!,
  props: {},
});
