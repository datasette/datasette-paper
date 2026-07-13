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
