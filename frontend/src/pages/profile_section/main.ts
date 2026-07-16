/**
 * @feat profile-papers: the `<profile-papers>` light-DOM custom element that
 * datasette-user-profiles instantiates on a profile page. On connect it reads
 * the `actor-id` / `is-own-profile` attributes, fetches the profile-docs
 * endpoint, and renders a loading / list / empty / error state. Plain
 * TypeScript — no Svelte, no `#app-root` mount; the host page owns the section
 * heading, so every state renders something. All interpolated strings reach
 * the DOM via `textContent` (the host page does not escape `actor-id`, so
 * every attribute and payload field is treated as untrusted).
 */
import "./profile.css";
import { ActorResolver } from "../../lib/actorResolver";
import { iconMarkup } from "../../lib/icons";
import { dueChip } from "../../lib/todos";
import type { TodoRow, TodosResponse } from "../../lib/todos";

interface ProfileDoc {
  id: number;
  name: string;
  url: string;
  created: boolean;
  last_edited_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProfileDocsResponse {
  docs: ProfileDoc[];
}

/** Tiny "3d ago" style relative-time formatter — no dependency. */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 45) return "just now";
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(day / 365)}y ago`;
}

/** "Created" / "Edited" / "Created · edited" from the two activity signals. */
function badgeLabel(doc: ProfileDoc): string {
  if (doc.created && doc.last_edited_at) return "Created · edited";
  if (doc.created) return "Created";
  return "Edited";
}

class ProfilePapers extends HTMLElement {
  private isOwnProfile = false;

  connectedCallback() {
    this.isOwnProfile = this.getAttribute("is-own-profile") === "true";
    const actorId = this.getAttribute("actor-id");
    if (!actorId) {
      // No actor to look up — render a quiet line and never fetch.
      this.renderMessage("No papers to show.");
      return;
    }
    this.renderMessage("Loading papers…");
    void this.loadDocs(actorId);
  }

  private async loadDocs(actorId: string) {
    try {
      const resp = await fetch(
        `/-/paper/api/profile/${encodeURIComponent(actorId)}/docs`,
      );
      if (!resp.ok) {
        this.renderMessage("Could not load papers.");
        return;
      }
      const data = (await resp.json()) as ProfileDocsResponse;
      this.renderDocs(data.docs ?? []);
    } catch {
      this.renderMessage("Could not load papers.");
    }
  }

  /** Replace content with a single status/empty/error line. */
  private renderMessage(text: string) {
    this.replaceChildren(this.makeMessage(text));
  }

  private makeMessage(text: string): HTMLParagraphElement {
    const p = document.createElement("p");
    p.className = "paper-profile-message";
    p.textContent = text;
    return p;
  }

  private renderDocs(docs: ProfileDoc[]) {
    if (docs.length === 0) {
      this.renderMessage(
        this.isOwnProfile
          ? "You haven't created any papers yet."
          : "No papers yet.",
      );
      return;
    }

    const list = document.createElement("ul");
    list.className = "paper-profile-list";
    for (const doc of docs) {
      list.appendChild(this.makeRow(doc));
    }
    this.replaceChildren(list);
  }

  private makeRow(doc: ProfileDoc): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "paper-profile-item";

    const link = document.createElement("a");
    link.className = "paper-profile-link";
    // Set href as an attribute (never navigated here); name via textContent.
    link.setAttribute("href", doc.url);
    link.textContent = doc.name;
    li.appendChild(link);

    const badge = document.createElement("span");
    badge.className = "paper-profile-badge";
    badge.textContent = badgeLabel(doc);
    li.appendChild(badge);

    const when = relativeTime(doc.last_edited_at ?? doc.created_at);
    if (when) {
      const time = document.createElement("span");
      time.className = "paper-profile-time";
      time.textContent = when;
      li.appendChild(time);
    }

    return li;
  }
}

// The host page re-appends this module per profile view (and bfcache can
// re-run it), so guard the one-time registration.
if (!customElements.get("profile-papers")) {
  customElements.define("profile-papers", ProfilePapers);
}

/**
 * @feat task-assign: the `<profile-todos>` light-DOM custom element — a sibling
 * of `<profile-papers>` on the same profile page, same untrusted-input contract
 * (every field reaches the DOM via `textContent`; the host page owns the
 * heading so every state renders something). Fetches the actor's open TODOs
 * from the cross-doc `/todos` endpoint, renders a capped flat list of rows
 * (checkbox glyph · text · due chip · doc badge), and links out to the full
 * `/-/paper/todos` page. Read-only: a row navigates to its doc, never mutates.
 */
class ProfileTodos extends HTMLElement {
  private isOwnProfile = false;
  private resolver = new ActorResolver();
  private unsubscribes: Array<() => void> = [];

  connectedCallback() {
    this.isOwnProfile = this.getAttribute("is-own-profile") === "true";
    const actorId = this.getAttribute("actor-id");
    if (!actorId) {
      this.renderMessage("No TODOs to show.");
      return;
    }
    this.renderMessage("Loading TODOs…");
    void this.loadTodos(actorId);
  }

  disconnectedCallback() {
    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];
    this.resolver.dispose();
  }

  private async loadTodos(actorId: string) {
    try {
      const resp = await fetch(
        `/-/paper/api/profile/${encodeURIComponent(actorId)}/todos?status=open`,
        { headers: { "Content-Type": "application/json" } },
      );
      if (!resp.ok) {
        this.renderMessage("Could not load TODOs.");
        return;
      }
      const data = (await resp.json()) as TodosResponse;
      this.renderTodos(actorId, data.todos ?? []);
    } catch {
      this.renderMessage("Could not load TODOs.");
    }
  }

  private renderMessage(text: string) {
    const p = document.createElement("p");
    p.className = "paper-profile-message";
    p.textContent = text;
    this.replaceChildren(p);
  }

  private renderTodos(actorId: string, todos: TodoRow[]) {
    if (todos.length === 0) {
      this.renderMessage("No open TODOs.");
      return;
    }

    const CAP = 10;
    const shown = todos.slice(0, CAP);
    const now = new Date();

    const list = document.createElement("ul");
    list.className = "paper-profile-list paper-todos-list";
    for (const row of shown) list.appendChild(this.makeRow(row, now));

    const frag = document.createDocumentFragment();
    frag.appendChild(list);

    // Footer always links to the full page (where the count, buckets, and
    // done tasks live) — labelled with the overflow when the list was capped.
    const footer = document.createElement("a");
    footer.className = "paper-todos-more";
    footer.setAttribute("href", `/-/paper/todos?actor=${encodeURIComponent(actorId)}`);
    footer.textContent =
      todos.length > CAP ? `All ${todos.length} TODOs →` : "All TODOs →";
    frag.appendChild(footer);

    this.replaceChildren(frag);
  }

  private makeRow(row: TodoRow, now: Date): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "paper-profile-item paper-todos-item";
    li.tabIndex = 0;
    li.setAttribute("role", "link");
    const navigate = () => window.location.assign(row.doc_url);
    li.addEventListener("click", (event) => {
      if ((event.target as Element).closest("a, input, button")) return;
      if (window.getSelection()?.toString()) return;
      navigate();
    });
    li.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigate();
    });

    // Static checkbox affordance — a real but disabled checkbox (the same
    // control the editor uses), so checking off clearly happens in the doc.
    const box = document.createElement("input");
    box.type = "checkbox";
    box.disabled = true;
    box.checked = row.checked;
    box.className = "paper-todos-check";
    box.setAttribute("aria-hidden", "true");
    box.addEventListener("click", (event) => event.stopPropagation());
    li.appendChild(box);

    const link = document.createElement("a");
    link.className = "paper-profile-link paper-todos-text";
    link.setAttribute("href", row.doc_url);
    link.textContent = row.text || "(untitled task)";
    if (row.checked) link.classList.add("paper-todos-done");
    li.appendChild(link);

    // On one's own profile a solo chip is redundant. On another person's
    // profile, an inherited solo assignment is meaningful context and keeps
    // its muted/tooltip treatment.
    if (row.assignees.length > 1 || (!this.isOwnProfile && row.assignees_inherited)) {
      for (const id of row.assignees) {
        li.appendChild(this.makeAssigneeChip(id, row.assignees_inherited));
      }
    }

    const chip = dueChip(row.due, now);
    if (chip) {
      const due = document.createElement("span");
      due.className = "paper-todos-due";
      if (chip.tint) due.classList.add(`paper-todos-due-${chip.tint}`);
      const glyph = document.createElement("span");
      glyph.className = "paper-todos-due-icon";
      glyph.innerHTML = iconMarkup("calendarEvent"); // bundled icon, trusted
      due.appendChild(glyph);
      const label = document.createElement("span");
      label.textContent = chip.label;
      due.appendChild(label);
      li.appendChild(due);
    }

    const badge = document.createElement("span");
    badge.className = "paper-profile-badge paper-todos-doc";
    badge.textContent = row.doc_name;
    li.appendChild(badge);

    return li;
  }

  private makeAssigneeChip(actorId: string, inherited: boolean): HTMLSpanElement {
    const chip = document.createElement("span");
    chip.className = "paper-todos-assignee";
    if (inherited) {
      chip.classList.add("paper-todos-assignee-inherited");
      chip.title = "Inherited from a parent task";
    }
    // Show the id until resolved, then swap in the name — exactly like
    // mentionView. All via textContent (untrusted).
    chip.textContent = `@${actorId}`;
    const off = this.resolver.request(actorId, (status) => {
      if (status.status === "ok") chip.textContent = `@${status.name}`;
    });
    this.unsubscribes.push(off);
    return chip;
  }
}

if (!customElements.get("profile-todos")) {
  customElements.define("profile-todos", ProfileTodos);
}
