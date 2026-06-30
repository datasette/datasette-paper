/**
 * NodeView for `task_item`: renders a real <input type="checkbox"> next to
 * the paragraph contentDOM. Toggling the checkbox dispatches a
 * setNodeMarkup transaction so the change rides the same collab pipeline
 * as any other edit — peers see the strike-through appear in real time.
 */
import type { Node as PMNode } from "prosemirror-model";
import type { EditorView, NodeView, ViewMutationRecord } from "prosemirror-view";

// @feat task-list: NodeView — real checkbox dispatches setNodeMarkup over collab
export class TaskItemView implements NodeView {
  dom: HTMLLIElement;
  contentDOM: HTMLDivElement;
  private checkbox: HTMLInputElement;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.dom = document.createElement("li");
    this.dom.dataset.taskItem = "true";
    this.dom.dataset.checked = String(node.attrs.checked);

    this.checkbox = document.createElement("input");
    this.checkbox.type = "checkbox";
    this.checkbox.checked = !!node.attrs.checked;
    this.checkbox.contentEditable = "false";
    this.checkbox.addEventListener("mousedown", (e) => {
      // Prevent the editor from treating this as a selection click.
      e.stopPropagation();
    });
    this.checkbox.addEventListener("change", () => {
      const pos = getPos();
      if (pos === undefined) return;
      const tr = view.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        checked: this.checkbox.checked,
      });
      view.dispatch(tr);
    });
    this.dom.appendChild(this.checkbox);

    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "task-item-content";
    this.dom.appendChild(this.contentDOM);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== "task_item") return false;
    const checked = !!node.attrs.checked;
    this.dom.dataset.checked = String(checked);
    if (this.checkbox.checked !== checked) this.checkbox.checked = checked;
    return true;
  }

  // Keep PM's selection logic away from the checkbox itself; we want
  // clicks on the checkbox to toggle, not place the caret.
  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return mutation.target === this.checkbox || this.checkbox.contains(mutation.target as Node);
  }

  stopEvent(event: Event): boolean {
    return event.target === this.checkbox;
  }
}
