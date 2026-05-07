import { Step } from "prosemirror-transform";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Slice } from "prosemirror-model";
import type { ResolvedPos } from "prosemirror-model";
import { history } from "prosemirror-history";
import {
  collab,
  receiveTransaction,
  sendableSteps,
  getVersion,
} from "prosemirror-collab";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark, chainCommands } from "prosemirror-commands";
import { buildKeymap, buildInputRules } from "prosemirror-example-setup";
import { InputRule, inputRules } from "prosemirror-inputrules";
import { findWrapping } from "prosemirror-transform";
import {
  wrapInList,
  splitListItem,
  sinkListItem,
  liftListItem,
} from "prosemirror-schema-list";
import type { Command } from "prosemirror-state";
import type { MarkType } from "prosemirror-model";

import { schema } from "./schema";
import { foldHeadingsPlugin } from "./foldHeadings";
import { Reporter } from "./reporter";
import { TaskItemView } from "./taskItemView";
import {
  cursorReporterPlugin,
  remoteCursorsPlugin,
  setRemoteUsers,
  type RemoteUser,
} from "./cursors";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BootstrapPermissions {
  canView: boolean;
  canEdit: boolean;
  canManage: boolean;
  isOwner: boolean;
  visibility: "private" | "link-view" | "link-edit";
}

export interface ConnectionOpts {
  /** Document ID (used in API URL path). */
  docId: string;
  /** Host element for the ProseMirror EditorView. */
  place: HTMLElement;
  /** CSRF token sent with mutating requests. */
  csrfToken?: string;
  /**
   * Called whenever a fresh EditorView is created (initial bootstrap and
   * after any restart). Receives the new view, or null if the connection
   * is closing. Use this to wire toolbars/headers that need a view ref.
   */
  onView?: (view: EditorView | null) => void;
  /**
   * Called when the server-reported users-online count changes (from
   * bootstrap and from each SSE update). Useful for the doc header.
   */
  onUsers?: (count: number) => void;
  /**
   * Called once per bootstrap with the permissions block from the
   * server. Use this to flip the editor read-only when canEdit is
   * false.
   */
  onPermissions?: (perms: BootstrapPermissions) => void;
}

type CommState =
  | "start"
  | "loaded"
  | "send"
  | "recover"
  | "detached"
  | null;

interface BootstrapData {
  doc: Record<string, unknown>;
  version: number;
  snapshotVersion?: number;
  steps?: Array<Record<string, unknown>>;
  clientIDs?: Array<number | string>;
  users?: number;
  selfActor?: string | null;
  permissions?: BootstrapPermissions;
}

interface SendableResult {
  steps: Step[];
  clientID: number | string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function repeat<T>(val: T, n: number): T[] {
  const result: T[] = [];
  for (let i = 0; i < n; i++) result.push(val);
  return result;
}

/**
 * Input rule: typing `[ ] ` or `[x] ` at the start of a paragraph wraps
 * it in a task_list with one task_item, checked iff the marker was [x].
 *
 * We can't use wrappingInputRule directly because its getAttrs targets
 * the outer wrapping node (task_list), not the inner task_item where the
 * `checked` attr lives. Build the transaction manually: delete the
 * marker, wrap the block, then patch the task_item's attrs.
 */
function taskListInputRule(): InputRule {
  return new InputRule(/^\s*\[([ xX])\]\s$/, (state, match, start, end) => {
    const checked = /[xX]/.test(match[1]);
    const tr = state.tr.delete(start, end);
    const $start = tr.doc.resolve(start);
    const range = $start.blockRange();
    if (!range) return null;
    const wrapping = findWrapping(range, schema.nodes.task_list);
    if (!wrapping) return null;
    tr.wrap(range, wrapping);
    if (checked) {
      // After wrapping, exactly one task_item exists at the wrap site;
      // descend the new doc to find it and patch its `checked` attr.
      let itemPos: number | null = null;
      tr.doc.descendants((node, pos) => {
        if (itemPos !== null) return false;
        if (node.type === schema.nodes.task_item) {
          itemPos = pos;
          return false;
        }
        return true;
      });
      if (itemPos !== null) {
        tr.setNodeMarkup(itemPos, undefined, { checked: true });
      }
    }
    return tr;
  });
}

/**
 * Generic delimiter-style mark input rule: matches `<open>text<close>` at
 * the cursor and replaces it with `text` carrying `markType`. The opening
 * delimiter must be at the start of the textblock or follow whitespace, so
 * `**foo**` matches but the inner `*` of `***x***` does not.
 *
 * `delimiterLen` is the length of one delimiter (1 for `*` / `` ` ``, 2 for
 * `**`); both delimiters must be the same length. The captured group
 * `match[1]` is the inner text — kept verbatim, no leading/trailing
 * whitespace allowed.
 */
function delimiterMarkRule(
  regex: RegExp,
  markType: MarkType,
  delimiterLen: number,
): InputRule {
  return new InputRule(regex, (state, match, start, end) => {
    const text = match[1];
    const leadingLen = match[0].length - text.length - delimiterLen * 2;
    const innerStart = start + leadingLen + delimiterLen;
    const innerEnd = innerStart + text.length;
    const tr = state.tr;
    // Right-to-left so positions stay valid through deletes.
    tr.delete(innerEnd, end);
    tr.addMark(innerStart, innerEnd, markType.create());
    tr.delete(start + leadingLen, innerStart);
    return tr.removeStoredMark(markType);
  });
}

/** `**text**` → strong. */
function strongInputRule(): InputRule {
  return delimiterMarkRule(
    /(?:^|\s)\*\*([^\s*][^*]*?[^\s*]|[^\s*])\*\*$/,
    schema.marks.strong,
    2,
  );
}

/** `*text*` → em. The `(?:^|\s)` prefix prevents firing on the inner `*`s of `**…**`. */
function emInputRule(): InputRule {
  return delimiterMarkRule(
    /(?:^|\s)\*([^\s*][^*]*?[^\s*]|[^\s*])\*$/,
    schema.marks.em,
    1,
  );
}

/** `` `text` `` → code. */
function codeInputRule(): InputRule {
  return delimiterMarkRule(
    /(?:^|\s)`([^\s`][^`]*?[^\s`]|[^\s`])`$/,
    schema.marks.code,
    1,
  );
}

/** `[text](url)` → link. Fires on the closing `)`. URL can't contain spaces or `)`.
 *
 * Mirrors `delimiterMarkRule`'s strategy: add the mark in place, then delete
 * the surrounding delimiters. Rebuilding the inner range as a fresh
 * `schema.text(match[1], …)` would discard any existing marks on the inner
 * text — e.g. an inline-code span produced by `` `code` `` autoformatting just
 * before the link was closed.
 */
function linkInputRule(): InputRule {
  return new InputRule(
    /\[([^\]]+)\]\(([^)\s]+)\)$/,
    (state, match, start, end) => {
      const [, text, href] = match;
      const linkType = schema.marks.link;
      const innerStart = start + 1;
      const innerEnd = innerStart + text.length;
      const tr = state.tr;
      // Right-to-left so positions stay valid through deletes.
      tr.delete(innerEnd, end);
      tr.addMark(innerStart, innerEnd, linkType.create({ href }));
      tr.delete(start, innerStart);
      return tr.removeStoredMark(linkType);
    },
  );
}

/**
 * On Enter: when the cursor is at the end of a `code_block` that is the
 * last block in the doc and the previous character is a newline (i.e. the
 * user just pressed Enter once already), strip that trailing newline,
 * append an empty paragraph after the block, and move the cursor into it.
 *
 * This unblocks the "stuck inside a code block at end of doc" UX —
 * without it, the only way out is to navigate up and add a paragraph
 * manually. We don't apply this mid-doc because the user can already
 * arrow-down past the block; restricting to the last-block case keeps
 * "Enter twice to escape" from surprising people who legitimately want
 * a blank trailing line in their code.
 */
function exitCodeBlockAtDocEnd(): Command {
  return (state, dispatch) => {
    const { $from, empty } = state.selection;
    if (!empty) return false;
    const block = $from.parent;
    if (block.type !== schema.nodes.code_block) return false;
    if ($from.parentOffset !== block.content.size) return false;
    if ($from.after() !== state.doc.content.size) return false;
    if (block.textContent.slice(-1) !== "\n") return false;
    if (!dispatch) return true;
    let tr = state.tr.delete($from.pos - 1, $from.pos);
    const paragraph = schema.nodes.paragraph.create();
    tr = tr.insert(tr.doc.content.size, paragraph);
    // Cursor sits one position inside the new paragraph (past its open token).
    const cursor = tr.doc.content.size - paragraph.nodeSize + 1;
    tr = tr.setSelection(TextSelection.create(tr.doc, cursor));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * Wraps a sink / lift command so that Tab always feels "trapped" inside a
 * list. When the cursor is inside a `list_item` / `task_item`, run the
 * inner command but always report it handled — otherwise the user's Tab
 * leaks to the browser and shifts focus once they hit the indent ceiling
 * (e.g. an only-child item with no preceding sibling to nest under).
 *
 * Outside any list item, returns false so Tab falls through to the
 * browser default — keeps the editor reachable from the keyboard.
 */
function consumeTabInList(inner: Command): Command {
  return (state, dispatch, view) => {
    const { $from } = state.selection;
    let inList = false;
    for (let d = $from.depth; d > 0; d--) {
      const t = $from.node(d).type;
      if (t === schema.nodes.task_item || t === schema.nodes.list_item) {
        inList = true;
        break;
      }
    }
    if (!inList) return false;
    inner(state, dispatch, view);
    return true;
  };
}

/**
 * Mod-K link toggle. With a non-empty selection: if it's already linked,
 * remove the mark; otherwise prompt() for a URL and apply. Empty selection
 * is a no-op so the user doesn't get a prompt while just navigating.
 */
function toggleLinkCommand(): Command {
  const linkType = schema.marks.link;
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (empty) return false;
    const has = state.doc.rangeHasMark(from, to, linkType);
    if (has) {
      return toggleMark(linkType)(state, dispatch);
    }
    if (!dispatch) return true;
    // Prompts are synchronous; jsdom returns null which we treat as cancel.
    const href = typeof window !== "undefined" ? window.prompt("Link URL") : null;
    if (!href) return false;
    return toggleMark(linkType, { href })(state, dispatch);
  };
}

// ─── Markdown clipboard parser ───────────────────────────────────────────────

// `prosemirror-markdown` is lazy-loaded (load-bearing quirk: it pulls
// markdown-it ~50k gzipped). Cmd+V parses pasted text as markdown when this
// module is ready; first paste before the chunk lands falls through to
// ProseMirror's default plain-text behavior. Cmd+Shift+V (`plain=true`)
// always falls through.
type MarkdownParser = import("prosemirror-markdown").MarkdownParser;
let mdParser: MarkdownParser | null = null;
let mdParserLoading: Promise<void> | null = null;

export function preloadMarkdownParser(): Promise<void> {
  if (mdParser) return Promise.resolve();
  if (!mdParserLoading) {
    mdParserLoading = import("prosemirror-markdown").then(
      (m) => {
        mdParser = m.defaultMarkdownParser;
      },
      () => {
        mdParserLoading = null;
      },
    );
  }
  return mdParserLoading;
}

function clipboardMarkdownParser(
  text: string,
  _$context: ResolvedPos,
  plain: boolean,
  _view: EditorView,
): Slice | null {
  if (plain || !mdParser) return null;
  let parsed;
  try {
    parsed = mdParser.parse(text);
  } catch {
    return null;
  }
  if (!parsed) return null;
  // The default parser is bound to prosemirror-markdown's own schema. Round-
  // trip through JSON to rebuild against ours — node names line up; extra
  // attrs like `code_block.params` / list `tight` are silently dropped by
  // `computeAttrs`.
  let ourDoc;
  try {
    ourDoc = schema.nodeFromJSON(parsed.toJSON());
  } catch {
    return null;
  }
  return Slice.maxOpen(ourDoc.content);
}

// ─── EditorConnection ────────────────────────────────────────────────────────

/**
 * Manages a single collaborative editing session.
 *
 * Upstream: HTTP POST  /-/paper/api/docs/<docId>/events
 * Downstream: SSE      /-/paper/api/docs/<docId>/events?version=…
 *
 * State machine: start → loaded (streaming) → send → loaded
 *                                                   ↘ recover → loaded
 */
export class EditorConnection {
  private opts: ConnectionOpts;
  readonly report: Reporter;

  // ProseMirror editor
  view: EditorView | null = null;

  // Communication state
  private comm: CommState = "start";

  // SSE stream
  private eventSource: EventSource | null = null;

  // Backoff (ms) for recover(); starts at 200, doubles up to 60_000
  backOff: number = 0;

  // Tracks in-flight send so we don't double-send
  private sending: boolean = false;

  // Unique client ID for this session (random integer)
  private clientID: number;

  // Current viewer's actor id, captured from the bootstrap response.
  // Used to suppress this user's own presence cursor across other tabs.
  private selfActor: string | null = null;

  // Whether the editor is currently editable. View mode flips this off;
  // persists across view rebuilds (e.g. 410 → restart).
  private editable: boolean = true;

  constructor(opts: ConnectionOpts, report?: Reporter) {
    this.opts = opts;
    this.report = report ?? new Reporter();
    this.clientID = Math.floor(Math.random() * 0xffffffff);
    this.start();
  }

  // ── URL helper ─────────────────────────────────────────────────────────────

  private apiUrl(path: string): string {
    return "/-/paper/api/docs/" + this.opts.docId + path;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Fetch the bootstrap data, construct EditorState + EditorView, then open
   * the SSE stream.
   */
  async start(): Promise<void> {
    this.comm = "start";
    try {
      const resp = await fetch(this.apiUrl(""), { method: "GET" });
      if (!resp.ok) {
        const err = new Error("Bootstrap fetch failed: " + resp.status);
        (err as Error & { status: number }).status = resp.status;
        throw err;
      }
      const boot: BootstrapData = await resp.json();
      this.report.success();
      this.backOff = 0;
      this._loaded(boot);
    } catch (err) {
      this.report.failure(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private _loaded(boot: BootstrapData): void {
    this.selfActor = boot.selfActor ?? null;
    // Build head doc by applying all steps from the bootstrap
    let doc = schema.nodeFromJSON(boot.doc);
    for (const stepJson of boot.steps ?? []) {
      const result = Step.fromJSON(schema, stepJson).apply(doc);
      if (result.doc) doc = result.doc;
    }

    const state = EditorState.create({
      doc,
      plugins: [
        buildInputRules(schema),
        inputRules({
          rules: [
            taskListInputRule(),
            strongInputRule(),
            emInputRule(),
            codeInputRule(),
            linkInputRule(),
          ],
        }),
        history(),
        keymap({
          "Mod-k": toggleLinkCommand(),
          "Mod-Shift-7": wrapInList(schema.nodes.task_list),
          // Enter handlers, tried in order:
          //   1. Escape a code_block at the end of the doc on the second Enter.
          //   2. Inside a task_item, split into a fresh unchecked item.
          // Both return false outside their target context, so buildKeymap's
          // generic list_item / paragraph Enter handlers still get a turn.
          Enter: chainCommands(
            exitCodeBlockAtDocEnd(),
            splitListItem(schema.nodes.task_item, { checked: false }),
          ),
          // Tab / Shift-Tab indent / outdent the current list item. Wrapped
          // in `consumeTabInList` so the key is always swallowed inside a
          // list — even when sink / lift can't make progress — and falls
          // through to browser focus-navigation when the cursor is not in
          // any list item.
          Tab: consumeTabInList(
            chainCommands(
              sinkListItem(schema.nodes.task_item),
              sinkListItem(schema.nodes.list_item),
            ),
          ),
          "Shift-Tab": consumeTabInList(
            chainCommands(
              liftListItem(schema.nodes.task_item),
              liftListItem(schema.nodes.list_item),
            ),
          ),
        }),
        keymap(buildKeymap(schema)),
        keymap(baseKeymap),
        collab({ version: boot.version, clientID: this.clientID }),
        cursorReporterPlugin({
          apiUrl: (path) => this.apiUrl(path),
          clientID: this.clientID,
        }),
        remoteCursorsPlugin(),
        foldHeadingsPlugin,
      ],
    });

    // Destroy any existing view
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }

    this.view = new EditorView(this.opts.place, {
      state,
      editable: () => this.editable,
      nodeViews: {
        task_item: (node, view, getPos) =>
          new TaskItemView(node, view, getPos as () => number | undefined),
      },
      // Returning null falls through to ProseMirror's default; the cast
      // exists because the upstream type insists on `Slice`.
      clipboardTextParser: clipboardMarkdownParser as unknown as (
        text: string,
        $context: ResolvedPos,
        plain: boolean,
        view: EditorView,
      ) => Slice,
      dispatchTransaction: (tr) => this.dispatchTransaction(tr),
    });

    // Fire-and-forget — markdown paste works after the chunk lands.
    void preloadMarkdownParser();

    this.opts.onView?.(this.view);
    if (typeof boot.users === "number") this.opts.onUsers?.(boot.users);
    if (boot.permissions) this.opts.onPermissions?.(boot.permissions);

    this.comm = "loaded";
    this.openStream();
  }

  /**
   * Open (or reopen) the SSE stream at the current version.
   */
  openStream(): void {
    this.closeStream();

    if (!this.view) return;

    const version = getVersion(this.view.state);
    const url =
      this.apiUrl("/events") +
      "?version=" +
      version +
      "&clientID=" +
      encodeURIComponent(String(this.clientID));

    const es = new EventSource(url);
    this.eventSource = es;

    const handleMessage = (evt: MessageEvent) => {
      if (!this.view) return;
      try {
        const data: {
          steps: Array<Record<string, unknown>>;
          clientIDs: Array<number | string>;
          users?: number;
        } = JSON.parse(evt.data);

        if (typeof data.users === "number") {
          this.opts.onUsers?.(data.users);
        }

        if (data.steps && data.steps.length > 0) {
          const steps = data.steps.map((s) => Step.fromJSON(schema, s));
          const tr = receiveTransaction(
            this.view.state,
            steps,
            data.clientIDs
          );
          this.view.dispatch(tr);
        }
      } catch {
        // Malformed message — ignore
      }
    };

    es.addEventListener("message", handleMessage);
    es.addEventListener("update", handleMessage as EventListener);

    const handlePresence = (evt: MessageEvent) => {
      if (!this.view) return;
      try {
        const data = JSON.parse(evt.data) as { users: RemoteUser[] };
        if (Array.isArray(data.users)) {
          setRemoteUsers(this.view, data.users, this.clientID, this.selfActor);
        }
      } catch {
        // ignore malformed
      }
    };
    es.addEventListener("presence", handlePresence as EventListener);

    es.addEventListener("error", () => {
      this.closeStream();
      if (this.comm !== "detached") {
        this.recover(new Error("SSE stream error"));
      }
    });
  }

  private closeStream(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  // ── Transaction dispatch ───────────────────────────────────────────────────

  /**
   * Called by EditorView on every transaction.
   */
  dispatchTransaction(tr: Parameters<EditorView["dispatch"]>[0]): void {
    if (!this.view) return;
    const newState = this.view.state.apply(tr);
    this.view.updateState(newState);

    // If there are pending steps and we're not already sending, kick off send
    if (
      sendableSteps(newState) &&
      !this.sending &&
      this.comm !== "detached"
    ) {
      this._send();
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  private async _send(): Promise<void> {
    if (!this.view || this.sending) return;

    const sendable = sendableSteps(this.view.state) as SendableResult | null;
    if (!sendable) return;

    this.sending = true;
    this.comm = "send";

    const body = JSON.stringify({
      version: getVersion(this.view.state),
      clientID: sendable.clientID,
      steps: sendable.steps.map((s) => s.toJSON()),
    });

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.opts.csrfToken) {
        headers["X-CSRFToken"] = this.opts.csrfToken;
      }

      const resp = await fetch(this.apiUrl("/events"), {
        method: "POST",
        headers,
        body,
      });

      this.sending = false;

      if (resp.ok) {
        // 200 — clear unconfirmed buffer
        this.report.success();
        this.backOff = 0;
        if (this.view) {
          const tr = receiveTransaction(
            this.view.state,
            sendable.steps,
            repeat(sendable.clientID, sendable.steps.length)
          );
          this.view.dispatch(tr);
          this.comm = "loaded";

          // If more steps queued up while we were sending, send again
          if (sendableSteps(this.view.state)) {
            this._send();
          }
        }
      } else if (resp.status === 409) {
        // Version conflict — reopen stream to catch up. Retry send on the
        // next animation frame: by then prior in-flight SSE broadcasts will
        // have applied (advancing local version), so the retried POST sends
        // at the correct version. Without this, broadcasts that arrived
        // during the in-flight POST were skipped (sending=true), leaving
        // the unconfirmed steps stuck after 409 fired.
        this.backOff = 0;
        this.comm = "loaded";
        this.openStream();
        if (this.view && sendableSteps(this.view.state)) {
          // Defer one tick so any pending SSE messages flush first.
          setTimeout(() => {
            if (this.view && sendableSteps(this.view.state)) this._send();
          }, 0);
        }
      } else if (resp.status === 410) {
        // Document replaced — full restart
        this.restart();
      } else {
        // Other server error — backoff
        const err = new Error("Send failed: " + resp.status);
        (err as Error & { status: number }).status = resp.status;
        this.recover(err);
      }
    } catch (err) {
      this.sending = false;
      this.recover(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ── Recover ───────────────────────────────────────────────────────────────

  /**
   * Exponential backoff, then reopen the SSE stream.
   */
  recover(err: Error): void {
    const newBackOff = this.backOff ? Math.min(this.backOff * 2, 6e4) : 200;
    if (newBackOff > 1000 && this.backOff < 1000) {
      this.report.delay(err);
    }
    this.backOff = newBackOff;
    this.comm = "recover";
    this.closeStream();

    setTimeout(() => {
      if (this.comm === "recover") {
        this.comm = "loaded";
        this.backOff = 0;
        this.report.success();
        this.openStream();
      }
    }, this.backOff);
  }

  // ── Restart ───────────────────────────────────────────────────────────────

  restart(): void {
    this.closeStream();
    this.sending = false;
    if (this.view) {
      this.view.destroy();
      this.view = null;
      this.opts.onView?.(null);
    }
    this.start();
  }

  // ── Mode ────────────────────────────────────────────────────────────────

  /** Flip read-only state. Reuses the same EditorView so collab state stays. */
  setEditable(editable: boolean): void {
    this.editable = editable;
    if (this.view) this.view.setProps({ editable: () => editable });
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  /** Tear down cleanly. Idempotent. */
  close(): void {
    this.comm = "detached";
    this.closeStream();
    if (this.view) {
      this.view.destroy();
      this.view = null;
      this.opts.onView?.(null);
    }
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  /**
   * Persist a snapshot to the server.
   * Call on a timer or from `beforeunload`.
   */
  async snapshot(): Promise<void> {
    if (!this.view) return;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.opts.csrfToken) {
      headers["X-CSRFToken"] = this.opts.csrfToken;
    }
    await fetch(this.apiUrl("/snapshot"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: getVersion(this.view.state),
        doc: this.view.state.doc.toJSON(),
      }),
    });
  }
}
