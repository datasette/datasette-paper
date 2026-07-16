import { mount } from "svelte";
import TodosPage from "../../lib/TodosPage.svelte";
import "../../app.css";

mount(TodosPage, {
  target: document.getElementById("app-root")!,
  props: {},
});
