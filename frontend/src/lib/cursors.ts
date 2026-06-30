/**
 * Live cursor / presence plugins for ProseMirror.
 *
 * - `cursorReporterPlugin(opts)` — watches selection changes and POSTs the
 *   anchor/head to `/api/docs/:id/presence` (debounced).
 * - `remoteCursorsPlugin()` — maintains a DecorationSet from incoming
 *   presence updates dispatched via meta. Renders each remote caret as
 *   a 2px-wide widget plus a subtle inline-range highlight if the
 *   selection spans more than zero chars.
 *
 * Color is deterministic per client/actor id so the same person shows
 * up the same color across reconnects.
 */
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { sendableSteps } from "prosemirror-collab";

const PALETTE = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231",
  "#911eb4", "#46f0f0", "#f032e6", "#bcf60c",
  "#fabebe", "#008080", "#9a6324", "#800000",
];

export function colorFor(key: string | number): string {
  const s = String(key);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

// ── reporter plugin (outbound) ───────────────────────────────────────────────

export const cursorReporterKey = new PluginKey("cursorReporter");

export interface CursorReporterOpts {
  apiUrl: (path: string) => string;
  clientID: number;
  debounceMs?: number;
}

// @feat presence: watch selection, POST presence; remote cursors decorate, self-filtered
export function cursorReporterPlugin(opts: CursorReporterOpts): Plugin {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSent = "";
  const debounce = opts.debounceMs ?? 150;

  // Send `(anchor, head)` to the server. Pulled out so the
  // "sendable cleared, fire deferred report" path can call it without
  // duplicating the fetch/headers boilerplate.
  function postPresence(anchor: number, head: number) {
    lastSent = `${anchor}:${head}`;
    void fetch(opts.apiUrl("/presence"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientID: opts.clientID,
        anchor,
        head,
      }),
    }).catch(() => {
      /* network blips are harmless — reporter retries on next move */
    });
  }

  return new Plugin({
    key: cursorReporterKey,
    view() {
      return {
        update(view, prevState) {
          // Suppress presence broadcasts when the view is read-only —
          // view-mode users shouldn't show carets to active editors.
          if (!view.editable) return;
          const selectionChanged = !view.state.selection.eq(prevState.selection);
          // When there are unconfirmed local steps, ``anchor`` / ``head``
          // are positions in the local doc, which includes those
          // pending steps. The server (and every other client) sees the
          // CONFIRMED doc — those same integers point at different
          // content. Reporting them here is what makes remote carets
          // visibly drift / "swap" while two people are typing.
          //
          // Defer until the batch confirms: when ``sendableSteps``
          // flips from non-null back to null (post-200 receiveTransaction),
          // this `update` runs without a selection change, and we fire
          // a single fresh report against the now-confirmed positions.
          const pending = sendableSteps(view.state);
          if (pending) {
            if (selectionChanged && timer) {
              clearTimeout(timer);
              timer = null;
            }
            return;
          }
          if (!selectionChanged) {
            // No selection change AND no pending steps — but if the
            // previous tick had pending steps, our deferred report
            // never went out. Fire it now so other clients catch up.
            const prevPending = sendableSteps(prevState);
            if (!prevPending) return;
          }
          const { anchor, head } = view.state.selection;
          const sig = `${anchor}:${head}`;
          if (sig === lastSent) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            postPresence(anchor, head);
          }, debounce);
        },
        destroy() {
          if (timer) clearTimeout(timer);
        },
      };
    },
  });
}

// ── remote cursors plugin (inbound) ──────────────────────────────────────────

export interface RemoteUser {
  clientID: number;
  actorID: string | null;
  // Resolved display name (datasette-user-profiles); falls back to the
  // actor id server-side, so it's null only for anonymous clients.
  name?: string | null;
  anchor: number;
  head: number;
}

export const remoteCursorsKey = new PluginKey<DecorationSet>("remoteCursors");

/**
 * Dispatch this from the SSE handler to feed the plugin a fresh presence
 * snapshot. The plugin reads the meta and rebuilds its DecorationSet.
 */
export function setRemoteUsers(
  view: import("prosemirror-view").EditorView,
  users: RemoteUser[],
  selfClientID: number,
  selfActor: string | null,
) {
  const tr = view.state.tr.setMeta(remoteCursorsKey, {
    users,
    selfClientID,
    selfActor,
  });
  view.dispatch(tr);
}

export function remoteCursorsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: remoteCursorsKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, old, _oldState, newState) {
        const meta = tr.getMeta(remoteCursorsKey) as
          | { users: RemoteUser[]; selfClientID: number; selfActor: string | null }
          | undefined;
        if (!meta) {
          // Map existing decorations through the document change so they
          // stay attached to the correct positions.
          return old.map(tr.mapping, tr.doc);
        }
        const docSize = newState.doc.content.size;
        const decos: Decoration[] = [];
        for (const u of meta.users) {
          if (u.clientID === meta.selfClientID) continue;
          if (meta.selfActor !== null && u.actorID === meta.selfActor) continue;
          // Colour keys off the stable actor/client id; only the label text
          // prefers the resolved display name.
          const color = colorFor(u.actorID ?? u.clientID);
          const label =
            u.name ?? u.actorID ?? `user ${u.clientID.toString(36).slice(0, 4)}`;
          const head = clampPos(u.head, docSize);
          const anchor = clampPos(u.anchor, docSize);
          // Selection range highlight (only if spanning at least one char)
          if (anchor !== head) {
            decos.push(
              Decoration.inline(
                Math.min(anchor, head),
                Math.max(anchor, head),
                {
                  style: `background: ${color}33;`,
                  class: "remote-selection",
                },
              ),
            );
          }
          // Caret widget — a 2px vertical bar at `head` with a small label
          decos.push(
            Decoration.widget(head, () => buildCaret(color, label), {
              key: `caret-${u.clientID}`,
              side: -1,
            }),
          );
        }
        return DecorationSet.create(newState.doc, decos);
      },
    },
    props: {
      decorations(state) {
        return remoteCursorsKey.getState(state);
      },
    },
  });
}

function clampPos(pos: number, max: number): number {
  if (pos < 0) return 0;
  if (pos > max) return max;
  return pos;
}

function buildCaret(color: string, label: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "remote-caret";
  wrap.style.borderLeft = `2px solid ${color}`;
  wrap.style.height = "1.2em";
  wrap.style.marginLeft = "-1px";
  wrap.style.position = "relative";
  wrap.style.display = "inline-block";
  wrap.style.verticalAlign = "text-bottom";

  const tag = document.createElement("span");
  tag.className = "remote-caret-label";
  tag.textContent = label;
  tag.style.position = "absolute";
  tag.style.top = "-1.2em";
  tag.style.left = "0";
  tag.style.background = color;
  tag.style.color = "#fff";
  tag.style.fontSize = "10px";
  tag.style.padding = "0 4px";
  tag.style.borderRadius = "3px";
  tag.style.whiteSpace = "nowrap";
  tag.style.pointerEvents = "none";
  wrap.appendChild(tag);

  return wrap;
}
