import { Step } from "prosemirror-transform";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Slice, Fragment } from "prosemirror-model";
import type { Node as PMNode, ResolvedPos } from "prosemirror-model";
import { history } from "prosemirror-history";
import {
  collab,
  receiveTransaction,
  sendableSteps,
  getVersion,
} from "prosemirror-collab";
import { tableEditing, goToNextCell } from "prosemirror-tables";
import { gapCursor } from "prosemirror-gapcursor";
import { tabOrAddRow, deleteRowOrColSelection } from "./tables";
import { tableInsertTooltipPlugin } from "./tableInsertTooltip";
import { tableRowDragPlugin } from "./tableRowDrag";
import { linkTooltipPlugin } from "./linkTooltip";
import { linkOpenPlugin } from "./linkOpen";
import {
  handleImagePaste,
  handleImageDrop,
  stripOversizedPastedImages,
} from "./image";
import {
  wikiLinkSuggestPlugin,
  wikiLinkSuggestPopupPlugin,
  wikiLinkKeymap,
} from "./wikiLinkSuggest";
import {
  mentionSuggestPlugin,
  mentionSuggestPopupPlugin,
  mentionKeymap,
} from "./mentionSuggest";
import {
  tagSuggestPlugin,
  tagSuggestPopupPlugin,
  tagKeymap,
} from "./tagSuggest";
import {
  valueSuggestPlugin,
  valueSuggestPopupPlugin,
  valueKeymap,
} from "./valueSuggest";
import { keymap } from "prosemirror-keymap";
import { lineBoundaryKeymap } from "./lineBoundary";
import { baseKeymap, toggleMark, chainCommands } from "prosemirror-commands";
import { buildKeymap } from "prosemirror-example-setup";
import {
  InputRule,
  inputRules,
  ellipsis,
  wrappingInputRule,
  textblockTypeInputRule,
} from "prosemirror-inputrules";
import {
  wrapInList,
  splitListItem,
  sinkListItem,
  liftListItem,
} from "prosemirror-schema-list";
import type { Command } from "prosemirror-state";
import type { MarkType } from "prosemirror-model";

import { schema } from "./schema";
import { isSafeHref } from "./safeHref";
import { foldHeadingsPlugin } from "./foldHeadings";
import { TocView, tocPlugin } from "./tocView";
import { Reporter } from "./reporter";
import { TaskItemView } from "./taskItemView";
import { LinkResolver } from "./linkResolver";
import { AccessChecker } from "./linkAccessCheck";
import { PaperLinkView } from "./paperLinkView";
import { ActorResolver } from "./actorResolver";
import { MentionView } from "./mentionView";
import { DatasetteResolver } from "./datasetteResolver";
import { InlineEmbedView } from "./inlineEmbedView";
import { BlockEmbedView } from "./blockEmbedView";
import { VideoEmbedView } from "./videoEmbedView";
import { SqlBlockView } from "./sqlBlockView";
import { TagView } from "./tagView";
import { SourceStore } from "./sourceStore";
import { ValueView } from "./valueView";
import { SourceBlockView } from "./sourceBlockView";
import { handleDatasettePaste } from "./datasettePaste";
import { handleYouTubePaste } from "./youtubePaste";
import {
  buildSlashCommands,
  createSlashSuggestPlugin,
  slashMenuPopupPlugin,
  slashKeymap,
  type SlashCommand,
  type EmbedKindFilter,
} from "./slashMenu";
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
  /** Read-only flag — when true, canEdit is false for everyone except
   * the owner. Lives inside permissions because flipping it is what
   * makes canEdit transition for non-owners; the SSE
   * ``permissions-changed`` event delivers the updated pair mid-session
   * with no reconnect. */
  locked: boolean;
}

export type DocState = "active" | "archived" | "trashed";

export interface DocStatePayload {
  state: DocState;
  archived_at: string | null;
  trashed_at: string | null;
  delete_at: string | null;
}

/**
 * Reported when a step in the bootstrap history or an SSE update can't
 * be applied — e.g. a malformed step that produces a node-content
 * violation. Carries the failing step's 1-based version and the
 * underlying error message. See `EditorConnectionOpts.onStepError`.
 */
export interface StepApplyError {
  /** Server-assigned version of the step that failed. */
  version: number;
  /** Where the failure happened.
   *
   * - `bootstrap`: replaying history on initial mount.
   * - `sse`: applying a step batch broadcast from the server.
   * - `send`: server rejected a POST /events with 422 (invalid_step).
   */
  phase: "bootstrap" | "sse" | "send";
  /** Error message from ProseMirror (or "StepResult.failed" text). */
  message: string;
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
  /**
   * Called with the doc's lifecycle state — once at bootstrap and
   * again whenever the server broadcasts a ``state-changed`` SSE
   * event (archive / unarchive / trash / restore). The renderer uses
   * this to show the archived pill or trashed banner.
   */
  onDocState?: (payload: DocStatePayload) => void;
  /**
   * Called once at bootstrap with the paper's ``kind``. Templates and
   * docs share the editor surface but the UI differs: templates show a
   * badge, surface the placeholder-insert affordance (slice 4), and
   * skip the "create from template" picker on their own row. There is
   * no live SSE for kind changes — the make/unmake routes are owner-
   * only and the page reloads after the mutation.
   */
  onKind?: (kind: "doc" | "template") => void;
  /**
   * Called once at bootstrap with the current actor id (``selfActor``),
   * or null when anonymous. The doc header forwards this to the
   * <datasette-acl-share-dialog> as ``actor-json`` so the dialog can mark the
   * current user's grant row "(you)".
   */
  onSelfActor?: (actorId: string | null) => void;
  /**
   * Called when a step can't be applied during bootstrap replay or an
   * SSE update. Bootstrap stops at the first bad step and renders the
   * partial doc; SSE skips the bad batch and stays connected. The host
   * uses this to render an error banner and force the editor read-only.
   */
  onStepError?: (err: StepApplyError) => void;
  /**
   * Open the image insert dialog — invoked by the `/` slash menu's "Image"
   * command (the dialog itself is a PaperApp-owned Svelte component).
   */
  onInsertImage?: () => void;
  /**
   * Open the embed picker dialog — invoked by the `/` slash menu's
   * "Embed a table" / "Embed a database" commands and any third-party provider
   * source commands (PaperApp-owned Svelte component). `sourceId` selects a
   * provider source; omitted = the core Datasette source. `filter` restricts the
   * core picker to tables/views or databases.
   */
  onInsertDatasetteEmbed?: (sourceId?: string, filter?: EmbedKindFilter) => void;
  /**
   * Create a new paper titled `title` from the `[[`-autocomplete's
   * "Create … page" row. The host owns the dialog + the
   * ``POST /-/paper/api/docs`` call (the creator becomes the new paper's
   * manager server-side); it resolves with the new doc id, or null when the
   * user cancels. When omitted, the create row is hidden and `[[` only links
   * to existing papers. The editor inserts the `paper_link` itself once it
   * has the id.
   */
  onCreatePage?: (title: string) => Promise<number | null>;
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
  state?: DocState;
  archived_at?: string | null;
  trashed_at?: string | null;
  delete_at?: string | null;
  kind?: "doc" | "template";
}

interface SendableResult {
  steps: Step[];
  clientID: number | string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Fence-language tokens that must never tag a `code_block`: they collide with
// the source / paper-embed / paper-toc / paper-table fence discriminators in
// datasette_paper/markdown_parser.py (a ```source fence parses as a `source`
// node). Kept in lock-step with RESERVED_FENCE_TOKENS in
// datasette_paper/markdown.py.
const RESERVED_FENCE_TOKENS = new Set([
  "source",
  "paper-embed",
  "paper-toc",
  "paper-table",
]);

/**
 * Normalize a fence-language token — typed into a ` ```lang ` input rule / the
 * Enter path, or carried on a pasted `code_block` — into the `language` attr.
 * Empty, reserved, and unsafe tokens (whitespace / backtick / `=`, which can't
 * round-trip through the markdown fence info string) collapse to `null`, so the
 * block is an untagged code block rather than a mis-tagged one. Mirrors the
 * `_SAFE_LANG_RE` + reserved-set guard in datasette_paper/markdown.py.
 */
function normalizeLanguageToken(raw: string): string | null {
  const token = raw.trim();
  if (!token || RESERVED_FENCE_TOKENS.has(token)) return null;
  if (/[\s`=]/.test(token)) return null;
  return token;
}

/**
 * Curated structural input rules — re-implementation of
 * `prosemirror-example-setup`'s `buildInputRules` with the typographic
 * rules pulled out so the user can keep typing `--` / straight quotes
 * verbatim. The structural rules (heading, blockquote, lists, code
 * block) are the same regexes upstream uses; lifted here so future
 * tweaks don't fight the example-setup default.
 *
 * `horizontal_rule` is wired by `horizontalRuleInputRule` instead of
 * coming from example-setup (which has no HR rule at all).
 */
function buildPaperStructuralRules(): InputRule[] {
  // Every node here is unconditionally present in the static schema, so no
  // per-node existence guard is needed.
  return [
    wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    wrappingInputRule(
      /^(\d+)\.\s$/,
      schema.nodes.ordered_list,
      (match) => ({ order: +match[1] }),
      (match, node) =>
        node.childCount + (node.attrs.order as number) === +match[1],
    ),
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list),
    // ` ```lang ` + space → a code_block tagged with `lang`. Replaces the old
    // instant ` ``` ` rule, which fired on the third backtick and made
    // ` ```python ` untypeable (the "python" landed inside the freshly-created
    // block). The Enter path is handled by `createCodeBlockOnEnter` (input
    // rules never see Enter).
    // @feat code-language: ```lang input rule tags the new code_block
    textblockTypeInputRule(
      /^```([^\s`]*)\s$/,
      schema.nodes.code_block,
      (match) => ({ language: normalizeLanguageToken(match[1]) }),
    ),
    textblockTypeInputRule(
      /^(#{1,6})\s$/,
      schema.nodes.heading,
      (match) => ({ level: match[1].length }),
    ),
  ];
}

/**
 * `---<space>` at the start of a top-level paragraph → horizontal_rule
 * + a fresh empty paragraph for the cursor to land in. Restricted to
 * doc-level paragraphs because list_item's content spec
 * (`paragraph block*`) requires a paragraph first — replacing a
 * list-item's only paragraph with an HR would violate the spec.
 *
 * Paired with the removal of the upstream `emDash` rule (`--` → `—`):
 * without that pairing, typing the second `-` would already have been
 * eaten, and the user could never get to three dashes.
 */
function horizontalRuleInputRule(): InputRule {
  return new InputRule(/^---\s$/, (state, _match, start) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type !== schema.nodes.paragraph) return null;
    // Only doc-level — see fn docstring.
    if ($start.depth !== 1) return null;
    const hrType = schema.nodes.horizontal_rule;
    const paraType = schema.nodes.paragraph;
    if (!hrType || !paraType) return null;
    const blockStart = $start.before();
    const blockEnd = $start.after();
    const hr = hrType.create();
    const newPara = paraType.create();
    const tr = state.tr.replaceWith(blockStart, blockEnd, [hr, newPara]);
    // 1 past the new paragraph's open token — the only valid cursor
    // position inside an empty paragraph.
    const cursor = blockStart + hr.nodeSize + 1;
    return tr.setSelection(TextSelection.create(tr.doc, cursor));
  });
}

/**
 * Input rule: inside a single-item bullet_list, typing `[ ] ` or `[x] `
 * at the start of the item's paragraph converts the whole list to a
 * task_list with one task_item — i.e. `- [ ] ` is the path to a TODO.
 *
 * Whatever content followed the `[ ]` marker (with marks intact) is
 * carried into the new task_item's paragraph, so the user can
 * retroactively turn `- fix branch` into `- [ ] fix branch` by typing
 * `[ ] ` at the start of the line.
 *
 * Restricted to a single-item bullet_list because peeling one item out
 * of a multi-item list crosses schema boundaries (bullet/task siblings
 * aren't allowed); leave that to a follow-up.
 */
function taskListInputRule(): InputRule {
  return new InputRule(/^\[([ xX])\]\s$/, (state, match, start, _end) => {
    const checked = /[xX]/.test(match[1]);
    const $start = state.doc.resolve(start);
    // Need depth ≥ 3: bullet_list / list_item / paragraph / text-position
    if ($start.depth < 3) return null;
    const paragraph = $start.parent;
    const listItem = $start.node($start.depth - 1);
    const list = $start.node($start.depth - 2);
    if (paragraph.type !== schema.nodes.paragraph) return null;
    if (listItem.type !== schema.nodes.list_item) return null;
    if (list.type !== schema.nodes.bullet_list) return null;
    if (list.childCount !== 1) return null;
    // Marker must start at the very beginning of the paragraph.
    if ($start.parentOffset !== 0) return null;
    // The marker length in the doc is `match[0].length - 1` — the typed
    // trailing space isn't in the doc yet. Carry the rest of the
    // paragraph (marks intact) into the new task_item's paragraph.
    const markerLen = match[0].length - 1;
    const remainder = paragraph.content.cut(markerLen);
    const newList = schema.nodes.task_list.create(
      null,
      schema.nodes.task_item.create(
        { checked },
        schema.nodes.paragraph.create(null, remainder),
      ),
    );
    const listStart = $start.before($start.depth - 2);
    const listEnd = listStart + list.nodeSize;
    const tr = state.tr.replaceWith(listStart, listEnd, newList);
    // Cursor lands at the start of the new task_item's paragraph: open
    // tokens for task_list (1) + task_item (1) + paragraph (1) = 3.
    return tr.setSelection(TextSelection.create(tr.doc, listStart + 3));
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
      // Don't create a link mark for a dangerous scheme (javascript:, etc.):
      // return null so the rule no-ops and the literal `[text](href)` stays as
      // plain text. The render sink would neutralize it anyway; this keeps the
      // poison out of the doc / step log in the first place.
      if (!isSafeHref(href)) return null;
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
 * Bare-URL autolink: typing whitespace after `http://…` / `https://…`
 * marks the URL as a link and inserts the whitespace. Trailing
 * punctuation (`.,;:!?)]'"`) is excluded from the link range so
 * "see https://example.com." links the URL but not the period.
 *
 * Skips when the URL range already carries a link mark — keeps the rule
 * from clobbering a user-set `[text](other-url)` whose visible text
 * happens to be a URL.
 *
 * Other schemes (`ftp:`, `mailto:`, etc.) are intentionally left to
 * `[text](url)` — keeps the pattern unambiguous and avoids false
 * positives on prose like `note: see file`.
 */
function autoLinkInputRule(): InputRule {
  return new InputRule(
    /(?:^|\s)(https?:\/\/\S+)\s$/,
    (state, match, start, end) => {
      const linkType = schema.marks.link;
      const raw = match[1];
      const url = raw.replace(/[.,;:!?)\]'"]+$/, "");
      if (!url) return null;
      // match[0] = (leading ws | empty) + URL + typed whitespace.
      // The leading ws (0 or 1 char) sits in the doc; the trailing
      // whitespace is what was just typed and isn't in the doc yet.
      const leadingLen = match[0].length - raw.length - 1;
      const urlStart = start + leadingLen;
      const urlEnd = urlStart + url.length;
      if (state.doc.rangeHasMark(urlStart, urlEnd, linkType)) return null;
      // Insert the typed whitespace first so it picks up the marks at
      // the cursor *before* we add the link mark — link is `inclusive:
      // false`, so even at the boundary it wouldn't extend, but doing
      // it in this order keeps the inserted char's marks independent of
      // our addMark step.
      const tr = state.tr.insertText(match[0].slice(-1), end);
      tr.addMark(urlStart, urlEnd, linkType.create({ href: url }));
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
 * On Enter: when the current textblock's entire text is ` ```lang ` (no
 * trailing space — the input rule covers the space case), turn it into an empty
 * `code_block` tagged with `lang` instead of splitting the block. Input rules
 * never see Enter, so this is the keyboard path to ` ```python `<Enter>.
 *
 * Mirrors `textblockTypeInputRule`'s `canReplaceWith` guard so it only fires
 * where a `code_block` may legally replace the current block (e.g. not as a
 * `list_item`'s required leading paragraph).
 */
function createCodeBlockOnEnter(): Command {
  return (state, dispatch) => {
    const { $from, empty } = state.selection;
    if (!empty) return false;
    const block = $from.parent;
    const codeType = schema.nodes.code_block;
    if (block.type === codeType) return false;
    if ($from.parentOffset !== block.content.size) return false;
    const match = /^```([^\s`]*)$/.exec(block.textContent);
    if (!match) return false;
    if (
      !$from
        .node(-1)
        .canReplaceWith($from.index(-1), $from.indexAfter(-1), codeType)
    )
      return false;
    if (!dispatch) return true;
    const language = normalizeLanguageToken(match[1]);
    const start = $from.start();
    const tr = state.tr.delete(start, $from.pos);
    tr.setBlockType(start, start, codeType, { language });
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
 * Move the current `list_item` / `task_item` up or down within its
 * parent list. Bound to `Alt-ArrowUp` / `Alt-ArrowDown`.
 *
 * Algorithm: walk up from the cursor's depth to find the nearest
 * list-item-ish ancestor, find its sibling index in the parent list,
 * and swap with the neighbour by replacing the two-item range with the
 * reversed pair. Cursor position is preserved relative to the moved
 * item's start, so the user keeps their place inside the moved item.
 *
 * Boundaries (first item + Up, last item + Down) return `false` so the
 * key falls through to the browser's default arrow behaviour — caret
 * moves out of the list rather than being silently swallowed.
 *
 * Multi-block selection is unsupported (returns `false`); the swap
 * would have to track and translate multiple ranges, which the issue
 * scope doesn't call for.
 */
function moveListItemCommand(direction: -1 | 1): Command {
  return (state, dispatch) => {
    const { $from, empty } = state.selection;
    let itemDepth = -1;
    for (let d = $from.depth; d > 0; d--) {
      const t = $from.node(d).type;
      if (t === schema.nodes.list_item || t === schema.nodes.task_item) {
        itemDepth = d;
        break;
      }
    }
    // Not inside a list — fall through so the editor's other Alt+Arrow
    // bindings (example-setup's joinUp / joinDown) get a turn.
    if (itemDepth < 0) return false;

    // Inside a list but the selection isn't collapsed: swallow the
    // keystroke without moving anything. The fallback joinDown/joinUp
    // would merge items in this case, which is a confusing UX for what
    // the user thinks of as a "move" gesture.
    if (!empty) return true;

    const parent = $from.node(itemDepth - 1);
    const index = $from.index(itemDepth - 1);
    const targetIndex = index + direction;
    // At the boundary, swallow as well — joinUp would happily merge the
    // first list item into a block above the list, which isn't what
    // "move up" means to the user.
    if (targetIndex < 0 || targetIndex >= parent.childCount) return true;

    if (!dispatch) return true;

    const item = $from.node(itemDepth);
    const itemStart = $from.before(itemDepth);
    const itemEnd = itemStart + item.nodeSize;
    // Offset of the cursor relative to the moved item's start position.
    // Preserved across the swap so the caret keeps its place inside the
    // moved content (works for any depth — nested paragraph, sublist
    // headings, etc., since the item's internal layout is unchanged).
    const cursorOffset = $from.pos - itemStart;

    let tr;
    let newCursor;
    if (direction === -1) {
      const prevItem = parent.child(index - 1);
      const prevStart = itemStart - prevItem.nodeSize;
      tr = state.tr.replaceWith(prevStart, itemEnd, [item, prevItem]);
      newCursor = prevStart + cursorOffset;
    } else {
      const nextItem = parent.child(index + 1);
      const nextEnd = itemEnd + nextItem.nodeSize;
      tr = state.tr.replaceWith(itemStart, nextEnd, [nextItem, item]);
      newCursor = itemStart + nextItem.nodeSize + cursorOffset;
    }
    tr = tr.setSelection(TextSelection.create(tr.doc, newCursor));
    dispatch(tr.scrollIntoView());
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
    // Reject a dangerous scheme (javascript:, vbscript:, data:…) before the
    // mark is created — the render sink neutralizes it on display anyway, but
    // refusing here keeps it out of the doc and tells the user why.
    if (!isSafeHref(href)) {
      if (typeof window !== "undefined")
        window.alert("That link URL isn't allowed (only http, https, mailto, tel, and # links).");
      return false;
    }
    return toggleMark(linkType, { href })(state, dispatch);
  };
}

// ─── Linkify (paste) ─────────────────────────────────────────────────────────

/** Bare URLs found in pasted text — same shape as the input-rule regex.
 *  Stateful (`g` flag) so callers must reset `lastIndex`. */
const PASTE_URL_RE = /https?:\/\/\S+/g;
const PASTE_TRAILING_PUNCT_RE = /[.,;:!?)\]'"]+$/;

/**
 * Walk a fragment, splitting any plain text nodes that contain bare
 * `http(s)://` URLs and applying a link mark to the URL portion. Text
 * nodes that already carry a link mark are left alone — the user
 * intentionally pasted a pre-marked link, possibly with a different href.
 *
 * Block / inline-with-content nodes recurse so URLs inside list items,
 * task items, headings, table cells, etc. all get linkified.
 */
function linkifyFragment(fragment: Fragment): Fragment {
  const linkType = schema.marks.link;
  const children: PMNode[] = [];
  fragment.forEach((node) => {
    if (node.isText) {
      if (linkType.isInSet(node.marks)) {
        children.push(node);
        return;
      }
      const text = node.text ?? "";
      const segments: { text: string; href?: string }[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      PASTE_URL_RE.lastIndex = 0;
      while ((match = PASTE_URL_RE.exec(text)) !== null) {
        const raw = match[0];
        const url = raw.replace(PASTE_TRAILING_PUNCT_RE, "");
        if (!url) continue;
        const urlStart = match.index;
        const urlEnd = urlStart + url.length;
        if (urlStart > lastIndex) {
          segments.push({ text: text.slice(lastIndex, urlStart) });
        }
        segments.push({ text: url, href: url });
        lastIndex = urlEnd;
        // The trailing punctuation we stripped is still in the source
        // text; restart scanning at urlEnd so the next iteration sees it
        // (and any further URLs that follow).
        PASTE_URL_RE.lastIndex = urlEnd;
      }
      if (segments.length === 0) {
        children.push(node);
        return;
      }
      if (lastIndex < text.length) {
        segments.push({ text: text.slice(lastIndex) });
      }
      for (const seg of segments) {
        const marks = seg.href
          ? linkType.create({ href: seg.href }).addToSet(node.marks)
          : node.marks;
        children.push(schema.text(seg.text, marks));
      }
    } else if (node.childCount === 0) {
      children.push(node);
    } else {
      children.push(node.copy(linkifyFragment(node.content)));
    }
  });
  return Fragment.fromArray(children);
}

function linkifyPastedSlice(slice: Slice): Slice {
  if (slice.size === 0) return slice;
  return new Slice(linkifyFragment(slice.content), slice.openStart, slice.openEnd);
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

// Walk parsed prosemirror-markdown JSON and copy each `code_block`'s fence
// language (kept by that schema as `attrs.params`, its first token) into our
// `attrs.language`, normalized. Without this the language is lost: our schema
// has no `params` attr, so `computeAttrs` silently drops it (see the caller).
// @feat code-language: keep the fence language when pasting markdown code blocks
function remapCodeBlockLanguage(json: unknown): void {
  if (Array.isArray(json)) {
    for (const item of json) remapCodeBlockLanguage(item);
    return;
  }
  if (!json || typeof json !== "object") return;
  const node = json as Record<string, unknown>;
  if (node.type === "code_block") {
    const attrs = (node.attrs as Record<string, unknown> | undefined) ?? {};
    const params = typeof attrs.params === "string" ? attrs.params : "";
    const first = params.split(/\s+/)[0] ?? "";
    node.attrs = { ...attrs, language: normalizeLanguageToken(first) };
  }
  for (const value of Object.values(node)) remapCodeBlockLanguage(value);
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
  // attrs like list `tight` are silently dropped by `computeAttrs`. We map
  // `code_block.params` → our `language` attr first (it would otherwise drop
  // the same way) so pasted fenced code keeps its language.
  let ourDoc;
  try {
    const json = parsed.toJSON() as unknown;
    remapCodeBlockLanguage(json);
    ourDoc = schema.nodeFromJSON(json);
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
// @feat collab-sse: client state machine: collab session lifecycle (start→send→recover)
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

  // One link resolver per connection (NOT a module singleton — multi-doc tabs + tests).
  private linkResolver: LinkResolver;
  private accessChecker: AccessChecker;
  // One actor resolver per connection (mention NodeViews subscribe to it).
  private actorResolver: ActorResolver;
  // One datasette resolver per connection (inline_embed pills subscribe).
  private datasetteResolver: DatasetteResolver;
  // One source store per connection: scans the doc for `source` nodes, runs
  // each query once (deduped), and feeds `value` chips + the source card/panel.
  // Re-synced from the doc on every change.
  private sourceStore: SourceStore;
  // The `/` slash command registry, built once with the dialog callbacks.
  private slashCommands: SlashCommand[];

  // Current viewer's actor id, captured from the bootstrap response.
  // Used to suppress this user's own presence cursor across other tabs.
  private selfActor: string | null = null;

  // Whether the editor is currently editable. View mode flips this off;
  // persists across view rebuilds (e.g. 410 → restart).
  private editable: boolean = true;

  // Set when a step from history (bootstrap) or a live broadcast (SSE)
  // could not be applied. Locks the editor read-only — editing forward
  // from a partial / out-of-sync state would corrupt later sync — and
  // short-circuits SSE step application until a refresh re-bootstraps.
  private stepError: StepApplyError | null = null;

  // Last known permissions block, captured at bootstrap and merged
  // with each ``permissions-changed`` SSE event so we can re-fire
  // ``onPermissions`` with the full shape (the SSE payload only
  // carries the fields that changed).
  private lastPermissions: BootstrapPermissions | null = null;

  // Version at which we last saved a snapshot (seeded from the bootstrap;
  // updated after each successful POST /snapshot). Used by the
  // auto-snapshot timer to decide when the local doc has drifted far
  // enough from the persisted snapshot to be worth saving.
  private lastSnapshotVersion: number = 0;
  // Pending auto-snapshot timer. Debounced so a typing burst doesn't fire
  // multiple snapshots; cleared on close.
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  // Pending backed-off bootstrap retry. Set when the initial bootstrap GET
  // fails transiently (network / 5xx) so `start()` re-runs instead of
  // leaving the editor permanently dead; cleared when a bootstrap succeeds
  // and on close() so the timer never leaks past teardown.
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;

  // navigator.onLine listeners — bound in start(), removed in close().
  // Stored as fields so we can unregister without recreating the
  // bound-fn identity. Off in non-browser tests (jsdom has `window` but
  // no real network state, so the listeners are harmless there).
  private onlineHandler: (() => void) | null = null;
  private offlineHandler: (() => void) | null = null;
  // `pagehide` flush — best-effort keepalive POST of unconfirmed steps when
  // the page is torn down (navigation / tab close). Same bind-once-in-start,
  // remove-on-close discipline as the online/offline handlers.
  private pageHideHandler: (() => void) | null = null;

  constructor(opts: ConnectionOpts, report?: Reporter) {
    this.opts = opts;
    this.report = report ?? new Reporter();
    this.clientID = Math.floor(Math.random() * 0xffffffff);
    this.linkResolver = new LinkResolver();
    // Self-gates via 403 for non-editors. Loaded lazily the first time a
    // paper_link NodeView subscribes — like LinkResolver, no fetch fires for
    // a doc with no links to check.
    this.accessChecker = new AccessChecker(opts.docId);
    this.actorResolver = new ActorResolver();
    this.datasetteResolver = new DatasetteResolver();
    this.sourceStore = new SourceStore();
    this.slashCommands = buildSlashCommands({
      openImageDialog: () => this.opts.onInsertImage?.(),
      openDatasetteEmbed: (sourceId, filter) =>
        this.opts.onInsertDatasetteEmbed?.(sourceId, filter),
    });
    this.installNetworkListeners();
    this.start();
  }

  // ── Online / offline ───────────────────────────────────────────────────────

  /**
   * Watch ``navigator.onLine`` transitions. On ``offline``, flip the
   * reporter so the user sees a sticky banner (the SSE stream and
   * subsequent POSTs will fail on their own; we just front-run the
   * "why" so they don't see a generic "Send failed: 0"). On ``online``,
   * reset backoff and tear down the (almost-certainly-dead) stream so
   * ``openStream`` reconnects immediately — much faster than waiting
   * out the exponential backoff that EventSource picked.
   */
  private installNetworkListeners(): void {
    if (typeof window === "undefined") return;
    this.offlineHandler = () => {
      this.report.offline();
    };
    this.onlineHandler = () => {
      // Reset and force a fresh stream open. If we're mid-recover the
      // setTimeout fires later and openStream is idempotent at the
      // closeStream/open level — extra reopen is harmless.
      this.backOff = 0;
      this.report.success();
      this.closeStream();
      if (this.comm !== "detached" && this.view) {
        this.comm = "loaded";
        this.openStream();
        // Flush any unconfirmed steps queued during the offline period.
        if (sendableSteps(this.view.state)) this._send();
      }
    };
    this.pageHideHandler = () => {
      this.flushPendingStepsBeacon();
    };
    window.addEventListener("offline", this.offlineHandler);
    window.addEventListener("online", this.onlineHandler);
    // Flush pending steps as the page goes away. `pagehide` fires on
    // same-tab navigation (and bfcache), which is exactly when a regular
    // in-flight POST /events would be aborted and the step lost.
    window.addEventListener("pagehide", this.pageHideHandler);
    // Pick up the initial state — opened tabs that were offline at
    // mount should show the banner immediately.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.report.offline();
    }
  }

  private removeNetworkListeners(): void {
    if (typeof window === "undefined") return;
    if (this.offlineHandler) {
      window.removeEventListener("offline", this.offlineHandler);
      this.offlineHandler = null;
    }
    if (this.onlineHandler) {
      window.removeEventListener("online", this.onlineHandler);
      this.onlineHandler = null;
    }
    if (this.pageHideHandler) {
      window.removeEventListener("pagehide", this.pageHideHandler);
      this.pageHideHandler = null;
    }
  }

  // ── URL helper ─────────────────────────────────────────────────────────────

  private apiUrl(path: string): string {
    return "/-/paper/api/docs/" + this.opts.docId + path;
  }

  /** POST a JSON body to an API path, attaching the CSRF header when present.
   * `keepalive` lets the request outlive a page teardown (see
   * flushPendingStepsBeacon). */
  private postJson(
    path: string,
    body: string,
    opts: { keepalive?: boolean } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.opts.csrfToken) {
      headers["X-CSRFToken"] = this.opts.csrfToken;
    }
    return fetch(this.apiUrl(path), {
      method: "POST",
      headers,
      body,
      keepalive: opts.keepalive,
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** True once close() has torn the connection down. Read as a method so
   * TypeScript doesn't narrow `this.comm` to a stale literal after an
   * intervening `await` (close() can flip it concurrently). */
  private isDetached(): boolean {
    return this.comm === "detached";
  }

  private reportStepError(err: StepApplyError): void {
    if (!this.stepError) {
      this.stepError = err;
      // Lock the editor immediately — even if setEditable hasn't been
      // called yet, the EditorView's `editable: () => this.editable`
      // accessor will pick this up on the next render tick.
      this.editable = false;
      if (this.view) this.view.setProps({ editable: () => false });
    }
    this.opts.onStepError?.(err);
  }

  /**
   * Fetch the bootstrap data, construct EditorState + EditorView, then open
   * the SSE stream.
   */
  async start(): Promise<void> {
    this.comm = "start";
    this.stepError = null;
    // A retry that's now running supersedes any pending one.
    if (this.bootstrapTimer !== null) {
      clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
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
      const e = err instanceof Error ? err : new Error(String(err));
      // close() raced the in-flight GET — stay torn down, don't reschedule.
      if (this.isDetached()) return;
      const status = (e as Error & { status?: number }).status;
      // 4xx (other than 408/429) are permanent client errors — not-found,
      // forbidden, bad request — so retrying just fails the same way. Surface
      // and give up. Network failures (no status) and 5xx are transient:
      // back off and retry so a flaky GET doesn't leave the editor
      // permanently dead with `this.view` null (onlineHandler is gated on a
      // live view, so it can't rescue this on its own). Mirrors the upstream
      // PM collab reference, which only recovers from status >= 500 / network.
      if (
        status !== undefined &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429
      ) {
        this.report.failure(e);
        return;
      }
      this.scheduleBootstrapRetry(e);
    }
  }

  /**
   * Schedule a backed-off `start()` retry after a transient bootstrap
   * failure. Reuses the same `backOff` accumulator / reporting as
   * `recover()` (200ms, doubling to a 60s cap; a `delay` banner once the
   * wait crosses 1s). Cancelled by the next `start()` and by `close()`.
   */
  private scheduleBootstrapRetry(err: Error): void {
    const newBackOff = this.backOff ? Math.min(this.backOff * 2, 6e4) : 200;
    if (newBackOff > 1000 && this.backOff < 1000) {
      this.report.delay(err);
    }
    this.backOff = newBackOff;
    if (this.bootstrapTimer !== null) clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = setTimeout(() => {
      this.bootstrapTimer = null;
      if (!this.isDetached()) this.start();
    }, this.backOff);
  }

  private _loaded(boot: BootstrapData): void {
    this.selfActor = boot.selfActor ?? null;
    this.opts.onSelfActor?.(this.selfActor);
    // Seed the snapshot-version baseline from the server's last
    // persisted snapshot. If the bootstrap has no snapshot field
    // (server is at version 0 or the field is missing), default to 0
    // so the threshold check fires once we accumulate enough steps.
    this.lastSnapshotVersion = boot.snapshotVersion ?? 0;
    // Build head doc by applying all steps from the bootstrap. Stop at
    // the first failure: a bad step poisons every subsequent position.
    //
    // `Step.apply` only converts `ReplaceError` into a `StepResult.failed`;
    // a content-spec violation surfaces as `Node.checkContent` throwing
    // `RangeError`, which escapes `apply`. Catch both shapes so one bad
    // step in history doesn't take the whole bootstrap down.
    let doc = schema.nodeFromJSON(boot.doc);
    const snapshotVersion = boot.snapshotVersion ?? boot.version;
    const stepJsons = boot.steps ?? [];
    for (let i = 0; i < stepJsons.length; i++) {
      const stepJson = stepJsons[i];
      const stepVersion = snapshotVersion + i + 1;
      try {
        const result = Step.fromJSON(schema, stepJson).apply(doc);
        if (result.failed) {
          this.reportStepError({
            version: stepVersion,
            phase: "bootstrap",
            message: result.failed,
          });
          break;
        }
        if (result.doc) doc = result.doc;
      } catch (err) {
        this.reportStepError({
          version: stepVersion,
          phase: "bootstrap",
          message: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }

    const state = EditorState.create({
      doc,
      plugins: [
        // Curated stand-in for prosemirror-example-setup's
        // `buildInputRules`. We drop the upstream `emDash` rule because
        // `--` → `—` collides with the markdown HR convention (`---`),
        // and inline our own `horizontalRuleInputRule` so `---<space>`
        // turns into an HR. `smartQuotes` and `ellipsis` stay (they're
        // dropped later if/when their own typography bug reports land).
        inputRules({
          rules: [
            // `smartQuotes` is intentionally absent: turning `"foo"` into
            // `“foo”` mangles code snippets, JSON, SQL, and URLs that
            // commonly appear in technical writing. `ellipsis` (`...` →
            // `…`) is benign and stays. `ellipsis` is a single rule, not
            // an array — don't spread it.
            ellipsis,
            horizontalRuleInputRule(),
            ...buildPaperStructuralRules(),
            taskListInputRule(),
            // `**text**` → strong.
            delimiterMarkRule(
              /(?:^|\s)\*\*([^\s*][^*]*?[^\s*]|[^\s*])\*\*$/,
              schema.marks.strong,
              2,
            ),
            // `*text*` → em. The `(?:^|\s)` prefix prevents firing on the
            // inner `*`s of `**…**`.
            delimiterMarkRule(
              /(?:^|\s)\*([^\s*][^*]*?[^\s*]|[^\s*])\*$/,
              schema.marks.em,
              1,
            ),
            // `` `text` `` → code.
            delimiterMarkRule(
              /(?:^|\s)`([^\s`][^`]*?[^\s`]|[^\s`])`$/,
              schema.marks.code,
              1,
            ),
            linkInputRule(),
            autoLinkInputRule(),
          ],
        }),
        history(),
        // Suggestion-popup keymaps come FIRST, ahead of the list/code Enter
        // handler, buildKeymap, and baseKeymap below. Each command returns
        // false when its popup is inactive, so normal editing keystrokes fall
        // through unaffected — but while a popup IS open they MUST win, and
        // that only works if they're registered before any other Enter/Tab
        // binding. (Registering them after buildKeymap, as before, let
        // `splitListItem` swallow Enter inside a list/task item, so the popup's
        // commit never fired — Enter would split the list instead of picking
        // the highlighted row.) The popups never open at once (distinct `[[` /
        // `@` / `#` / `${{` / `/` triggers), so ordering among them is moot.
        //   `[[`  — wiki-link page picker (Enter/Arrow/Escape, + create row).
        keymap(wikiLinkKeymap({ onCreatePage: this.opts.onCreatePage })),
        //   `@`   — mention picker.
        keymap(mentionKeymap()),
        //   `#`   — tag picker.
        keymap(tagKeymap()),
        //   `${{` — source→column value picker.
        keymap(valueKeymap()),
        //   `/`   — slash command menu (also drives Tab while open).
        keymap(slashKeymap(this.slashCommands)),
        keymap({
          "Mod-k": toggleLinkCommand(),
          "Mod-Shift-7": wrapInList(schema.nodes.task_list),
          // Move the cursor's enclosing list_item / task_item up or
          // down within its parent list. Falls through at boundaries
          // so Opt+Arrow still moves the caret out of the list.
          "Alt-ArrowUp": moveListItemCommand(-1),
          "Alt-ArrowDown": moveListItemCommand(1),
          // Enter handlers, tried in order:
          //   1. Escape a code_block at the end of the doc on the second Enter.
          //   2. Turn a ` ```lang ` marker line into an empty tagged code_block.
          //   3. Inside a task_item, split into a fresh unchecked item.
          // All return false outside their target context, so buildKeymap's
          // generic list_item / paragraph Enter handlers still get a turn.
          Enter: chainCommands(
            exitCodeBlockAtDocEnd(),
            createCodeBlockOnEnter(),
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
        // Tab navigates between cells when the cursor is inside a table.
        // At the bottom-right cell, Tab appends a new row (tabOrAddRow).
        // Shift-Tab is plain reverse navigation — we don't auto-add a
        // row before the first cell since that would be surprising.
        // Backspace/Delete on a row- or column-spanning CellSelection
        // remove the row(s) or column(s) instead of just clearing cell
        // contents (which is what baseKeymap's deleteSelection does on
        // a CellSelection). Returns false outside that case so normal
        // editing keystrokes pass through.
        // Registered separately from the indent/outdent keymap so cell
        // navigation wins inside tables; outside, both return false and
        // the indent keymap gets its turn.
        keymap({
          Tab: tabOrAddRow(),
          "Shift-Tab": goToNextCell(-1),
          Backspace: deleteRowOrColSelection(),
          Delete: deleteRowOrColSelection(),
        }),
        keymap(buildKeymap(schema)),
        // Own line-boundary motion (Cmd/Home + Left/Right). Chromium's native
        // handling breaks when a line begins with a link mark and leaks the
        // keystroke to the browser's Back shortcut; this consumes it. Ahead of
        // baseKeymap (which binds none of these) for clarity.
        keymap(lineBoundaryKeymap()),
        keymap(baseKeymap),
        collab({ version: boot.version, clientID: this.clientID }),
        cursorReporterPlugin({
          apiUrl: (path) => this.apiUrl(path),
          clientID: this.clientID,
        }),
        remoteCursorsPlugin(),
        foldHeadingsPlugin,
        // Re-renders every mounted table-of-contents block when the doc's
        // top-level heading signature changes (a TocView's own update() only
        // fires for changes to the toc node itself).
        tocPlugin,
        // In-table action bar (add/delete row/col, name input + API link)
        // — anchored above the table when the cursor is inside one. The
        // docId is baked in so the API button can build the right URL.
        tableInsertTooltipPlugin(this.opts.docId),
        // Hover-grip on each table row's left edge that drags to reorder.
        tableRowDragPlugin(),
        // Hover tooltip over plain `<a>` link marks (edit-mode only): shows the
        // URL + Open/Copy. Scoped to class-less links so embed titles are left
        // alone.
        linkTooltipPlugin(),
        // In edit mode a click on a plain `<a>` link mark opens its URL in a
        // new tab (deterministic across browsers); view mode navigates natively.
        linkOpenPlugin(),
        // `[[`-triggered wiki-link autocomplete: the state plugin tracks
        // the in-progress `[[query` span, the popup plugin renders the
        // floating result list and runs the debounced link-search fetch.
        wikiLinkSuggestPlugin({ onCreatePage: this.opts.onCreatePage }),
        wikiLinkSuggestPopupPlugin({ onCreatePage: this.opts.onCreatePage }),
        // `@`-triggered mention autocomplete: the state plugin tracks the
        // in-progress `@query` span, the popup plugin renders the floating
        // result list and runs the doc-scoped mention-search fetch.
        mentionSuggestPlugin,
        mentionSuggestPopupPlugin(this.opts.docId),
        // `#`-triggered tag autocomplete: the state plugin tracks the
        // in-progress `#query` span, the popup plugin renders the floating
        // suggestion list from the instance-wide tag vocabulary.
        tagSuggestPlugin,
        tagSuggestPopupPlugin(),
        // `${{`-triggered inline-value autocomplete: stage A lists the doc's
        // source names, stage B lists the chosen source's columns (from the
        // source store), committing a `value` node.
        valueSuggestPlugin,
        valueSuggestPopupPlugin(this.sourceStore),
        // `/`-triggered slash command menu: the state plugin tracks the
        // in-progress `/query` in an empty top-level block, the popup renders
        // the static command list and commits the chosen insert command.
        createSlashSuggestPlugin(this.slashCommands),
        slashMenuPopupPlugin(this.slashCommands),
        // gap cursor — gives ArrowDown/Right past the last block (and
        // ArrowUp/Left before the first) a place to land when no normal
        // text position exists, e.g. between two adjacent tables or after
        // a table that's the last block in the doc. Typing converts the
        // gap into a paragraph. Must come BEFORE tableEditing per the
        // prosemirror-tables README.
        gapCursor(),
        // Per upstream README, tableEditing belongs near the end of the
        // plugin chain — it handles mouse + arrow keys broadly, so other
        // plugins (gap cursor, columnResizing if we ever add it) need to
        // get a turn first.
        tableEditing(),
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
      // Turn off iOS autocorrect/-capitalize/-complete on the contenteditable.
      // Best-effort: iOS's autofill accessory bar (the key/credit-card pill
      // above the keyboard) is OS chrome that web content can't remove, but
      // these at least stop the field from being treated as autofillable.
      attributes: {
        autocorrect: "off",
        autocapitalize: "off",
        autocomplete: "off",
      },
      nodeViews: {
        task_item: (node, view, getPos) =>
          new TaskItemView(node, view, getPos as () => number | undefined),
        paper_link: (node, view, getPos) =>
          new PaperLinkView(
            node,
            view,
            getPos as () => number | undefined,
            this.linkResolver,
            this.accessChecker,
          ),
        mention: (node, view, getPos) =>
          new MentionView(
            node,
            view,
            getPos as () => number | undefined,
            this.actorResolver,
          ),
        inline_embed: (node, view, getPos) =>
          new InlineEmbedView(
            node,
            view,
            getPos as () => number | undefined,
            this.datasetteResolver,
          ),
        block_embed: (node, view, getPos) =>
          new BlockEmbedView(node, view, getPos as () => number | undefined),
        video_embed: (node) => new VideoEmbedView(node),
        toc: (node, view, getPos) =>
          new TocView(node, view, getPos as () => number | undefined),
        sql_block: (node, view, getPos) =>
          new SqlBlockView(node, view, getPos as () => number | undefined),
        tag: (node, view) => new TagView(node, view),
        value: (node, view, getPos) =>
          new ValueView(
            node,
            view,
            getPos as () => number | undefined,
            this.sourceStore,
          ),
        source: (node, view, getPos) =>
          new SourceBlockView(
            node,
            view,
            getPos as () => number | undefined,
            this.sourceStore,
          ),
      },
      // Returning null falls through to ProseMirror's default; the cast
      // exists because the upstream type insists on `Slice`.
      clipboardTextParser: clipboardMarkdownParser as unknown as (
        text: string,
        $context: ResolvedPos,
        plain: boolean,
        view: EditorView,
      ) => Slice,
      // Mirror the autoLink input rule: any bare http(s) URL in a paste
      // becomes a link, regardless of whether the source was plain text,
      // a markdown round-trip, or rich HTML. Runs after clipboardTextParser
      // so already-marked links (e.g. from a `[text](url)` paste) pass
      // through untouched. We also strip oversized inline `data:` images
      // first — a screenshot pasted as HTML lands here (not via
      // handleImagePaste, which only fires for clipboard image *files*), and
      // a multi-MB data URI would otherwise ride the step log / SSE broadcast.
      transformPasted: (slice) =>
        linkifyPastedSlice(
          stripOversizedPastedImages(slice, (count) => {
            window.alert(
              count === 1
                ? "An image was too large and was not pasted (maximum 8 MB)."
                : `${count} images were too large and were not pasted (maximum 8 MB).`,
            );
          }),
        ),
      // Image files on the clipboard / dropped in become inline data-URI
      // images. Returning false (no image files) lets the default text/HTML
      // paste path run. This is what makes image paste work in Safari, which
      // puts only the image file on the clipboard with no text/html for the
      // default parser to pick up. See image.ts.
      // Paste precedence: image files first (Safari puts only the file on the
      // clipboard), then a Datasette resource URL (auto inline-ref vs block
      // embed by cursor context), else the default text/HTML paste.
      handlePaste: (view, event) =>
        handleImagePaste(view, event) ||
        handleYouTubePaste(view, event) ||
        handleDatasettePaste(view, event),
      handleDrop: (view, event) => handleImageDrop(view, event as DragEvent),
      dispatchTransaction: (tr) => this.dispatchTransaction(tr),
    });

    // Seed the source store from the bootstrapped doc so value chips resolve
    // on first paint (the NodeViews subscribe as they mount).
    this.sourceStore.sync(this.view.state.doc);

    // Fire-and-forget — markdown paste works after the chunk lands.
    void preloadMarkdownParser();

    this.opts.onView?.(this.view);
    if (typeof boot.users === "number") this.opts.onUsers?.(boot.users);
    if (boot.permissions) {
      this.lastPermissions = boot.permissions;
      this.opts.onPermissions?.(boot.permissions);
    }
    if (boot.kind) this.opts.onKind?.(boot.kind);
    if (boot.state) {
      this.opts.onDocState?.({
        state: boot.state,
        archived_at: boot.archived_at ?? null,
        trashed_at: boot.trashed_at ?? null,
        delete_at: boot.delete_at ?? null,
      });
    }

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
      let data: {
        steps?: Array<Record<string, unknown>>;
        clientIDs?: Array<number | string>;
        version?: number;
        users?: number;
      };
      try {
        data = JSON.parse(evt.data);
      } catch {
        // Malformed envelope — drop.
        return;
      }

      // A well-formed message proves the stream reconnected and is healthy.
      // This is the confirmed-reconnect signal that clears the recover
      // backoff — `recover()` deliberately no longer resets it from its own
      // timer (the stream hadn't proven healthy yet), so a flapping server
      // that errors before delivering anything keeps backing off.
      if (this.backOff !== 0) {
        this.backOff = 0;
        this.report.success();
      }

      if (typeof data.users === "number") {
        this.opts.onUsers?.(data.users);
      }

      // Skip step application if bootstrap already failed: the local doc
      // doesn't reflect the version the server is broadcasting, so applying
      // remote steps would compound the corruption. Presence + users still
      // flow through.
      if (this.stepError) return;

      if (!data.steps || data.steps.length === 0) return;

      // `receiveTransaction` builds a single tr from all steps. Wrap the
      // whole construct + dispatch in a try so a single bad remote step
      // doesn't crash the page — surface the failure and stay subscribed.
      try {
        const steps = data.steps.map((s) => Step.fromJSON(schema, s));
        const tr = receiveTransaction(
          this.view.state,
          steps,
          data.clientIDs ?? [],
        );
        this.view.dispatch(tr);
      } catch (err) {
        // `version` in the SSE envelope is the post-batch server version.
        // Use it directly for the error report so the user / repair tool
        // can find the offending step.
        this.reportStepError({
          version:
            typeof data.version === "number"
              ? data.version
              : getVersion(this.view.state) + (data.steps.length ?? 0),
          phase: "sse",
          message: err instanceof Error ? err.message : String(err),
        });
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

    const handleStateChanged = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data) as Partial<DocStatePayload>;
        if (data.state !== "active" && data.state !== "archived" && data.state !== "trashed") {
          return;
        }
        this.opts.onDocState?.({
          state: data.state,
          archived_at: data.archived_at ?? null,
          trashed_at: data.trashed_at ?? null,
          delete_at: data.delete_at ?? null,
        });
      } catch {
        // ignore malformed
      }
    };
    es.addEventListener("state-changed", handleStateChanged as EventListener);

    const handlePermissionsChanged = (evt: MessageEvent) => {
      // Server pushes ``{canEdit, locked}`` after a lock/unlock; merge
      // into the cached full block and re-fire so PaperApp's
      // ``onPermissions`` handler flips the editor into the right mode
      // without a reconnect.
      if (!this.lastPermissions) return;
      try {
        const data = JSON.parse(evt.data) as Partial<BootstrapPermissions>;
        const merged: BootstrapPermissions = {
          ...this.lastPermissions,
          ...data,
        };
        this.lastPermissions = merged;
        this.opts.onPermissions?.(merged);
      } catch {
        // ignore malformed
      }
    };
    es.addEventListener(
      "permissions-changed",
      handlePermissionsChanged as EventListener,
    );

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

    // Keep the source store in sync so value chips react to source edits
    // (locally or via remote steps routed through dispatch). Cheap: re-runs
    // only sources whose (db, sql) actually changed.
    if (tr.docChanged) this.sourceStore.sync(newState.doc);

    // If there are pending steps and we're not already sending, kick off send
    if (
      sendableSteps(newState) &&
      !this.sending &&
      this.comm !== "detached"
    ) {
      this._send();
    }

    // Doc may have advanced (either locally via dispatch or remotely via
    // receiveTransaction routed through dispatch). Snapshot the doc once
    // we've drifted far enough from the last persisted snapshot.
    this.maybeScheduleSnapshot();
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  /** Serialize the current unconfirmed steps into a POST /events body. */
  private eventsBody(sendable: SendableResult): string {
    return JSON.stringify({
      version: getVersion(this.view!.state),
      clientID: sendable.clientID,
      steps: sendable.steps.map((s) => s.toJSON()),
    });
  }

  /**
   * Last-ditch flush when the page is being torn down (navigation / tab
   * close). A normal POST /events fired from dispatch is a plain fetch that
   * the browser ABORTS the instant navigation starts — so a step inserted
   * right before the user clicks away never reaches the server. The
   * `[[`-create flow hits this: it drops a `paper_link` into the *source*
   * doc, then the user navigates straight into the freshly created target,
   * aborting that POST — the step is lost and the backlink edge (rebuilt
   * server-side from the step) never gets indexed.
   *
   * `keepalive: true` lets the request outlive the page. Fire-and-forget: we
   * can't read the response, and we deliberately don't touch `sending` or the
   * unconfirmed buffer. If a normal in-flight POST happened to win the race,
   * this one just arrives at a stale version and the server 409s it — so it's
   * at-least-once, never a duplicate apply.
   */
  private flushPendingStepsBeacon(): void {
    if (!this.view || this.comm === "detached") return;
    const sendable = sendableSteps(this.view.state) as SendableResult | null;
    if (!sendable) return;
    try {
      void this.postJson("/events", this.eventsBody(sendable), {
        keepalive: true,
      });
    } catch {
      // Best-effort during unload; nothing actionable if the browser
      // refuses the keepalive request (e.g. body over the 64KB cap).
    }
  }

  private async _send(): Promise<void> {
    if (!this.view || this.sending) return;

    const sendable = sendableSteps(this.view.state) as SendableResult | null;
    if (!sendable) return;

    this.sending = true;
    this.comm = "send";

    const body = this.eventsBody(sendable);

    try {
      const resp = await this.postJson("/events", body);

      this.sending = false;

      if (resp.ok) {
        // 200 — clear unconfirmed buffer
        this.report.success();
        this.backOff = 0;
        if (this.view) {
          const tr = receiveTransaction(
            this.view.state,
            sendable.steps,
            new Array(sendable.steps.length).fill(sendable.clientID)
          );
          this.view.dispatch(tr);
          this.comm = "loaded";

          // If more steps queued up while we were sending, send again
          if (sendableSteps(this.view.state)) {
            this._send();
          }
        }
      // @feat collab-sse: 409 stale: reopen stream, deferred resend at new version
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
      } else if (resp.status === 422) {
        // Server rejected the batch as invalid (Instance._validate_steps
        // failed). The local doc is now ahead of what the server
        // accepted — editing forward would diverge further. Surface as
        // a stepError and stop sending: a refresh will re-bootstrap from
        // server truth.
        let info: { step_index?: number; message?: string } = {};
        try {
          info = (await resp.json()) as typeof info;
        } catch {
          // Fall through with empty info.
        }
        this.reportStepError({
          version: getVersion(this.view!.state) + (info.step_index ?? 0) + 1,
          phase: "send",
          message: info.message ?? "invalid step",
        });
        // Don't recover() — we'd just try to resend the same bad batch.
        this.report.failure(
          new Error(
            "Server rejected step: " + (info.message ?? resp.statusText),
          ),
        );
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
        // NB: do NOT reset `this.backOff` here — reopening the stream is not
        // proof it's healthy. The reset happens once a good SSE message
        // actually arrives (see `handleMessage`) or a send succeeds, so a
        // server that keeps dropping the stream backs off monotonically
        // instead of restarting at ~200ms every cycle.
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

  /** Flip read-only state. Reuses the same EditorView so collab state stays.
   *
   * A bootstrap that hit a bad step locks the editor read-only regardless
   * of caller intent — editing forward from a partial doc would produce
   * steps with stale positions on the next send.
   */
  setEditable(editable: boolean): void {
    const effective = this.stepError ? false : editable;
    this.editable = effective;
    if (this.view) this.view.setProps({ editable: () => effective });
  }

  /** The per-connection source store, so the Sources panel can read each
   *  source's column count (deduped/cached — same runs that feed value chips). */
  getSourceStore(): SourceStore {
    return this.sourceStore;
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  /** Tear down cleanly. Idempotent. */
  close(): void {
    this.comm = "detached";
    this.closeStream();
    this.removeNetworkListeners();
    if (this.snapshotTimer !== null) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (this.bootstrapTimer !== null) {
      clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
    this.linkResolver.dispose();
    this.accessChecker.dispose();
    this.actorResolver.dispose();
    this.datasetteResolver.dispose();
    if (this.view) {
      this.view.destroy();
      this.view = null;
      this.opts.onView?.(null);
    }
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  /**
   * Steps since the last snapshot at or above this count → schedule one.
   * Mirrors the server's `SNAPSHOT_THRESHOLD = 100` in `instance.py` so
   * client + server agree on the same horizon and cold-start replay
   * never has to apply more than ~threshold steps.
   */
  static readonly SNAPSHOT_STEP_THRESHOLD = 100;
  /**
   * Debounce window before the actual POST fires. A typing burst can
   * blow past the threshold in seconds; waiting a few seconds before
   * snapshotting avoids back-to-back POSTs with stale payloads.
   */
  static readonly SNAPSHOT_DEBOUNCE_MS = 5000;

  /**
   * Called after every local dispatch or accepted SSE update to check
   * whether the doc has drifted far enough from the last snapshot to
   * warrant a fresh one. Debounced — repeated calls just push the
   * scheduled fire-time forward.
   */
  private maybeScheduleSnapshot(): void {
    if (!this.view || this.stepError || this.comm === "detached") return;
    const version = getVersion(this.view.state);
    if (
      version - this.lastSnapshotVersion <
      EditorConnection.SNAPSHOT_STEP_THRESHOLD
    ) {
      return;
    }
    if (this.snapshotTimer !== null) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      // Fire-and-forget; failures are non-fatal (a later schedule will
      // retry once another threshold's worth of steps lands).
      void this.snapshot();
    }, EditorConnection.SNAPSHOT_DEBOUNCE_MS);
  }

  /**
   * Trigger a server-side snapshot.
   *
   * Called by the debounced threshold trigger (`maybeScheduleSnapshot`)
   * and exposed publicly for tests / future `beforeunload` wiring. The
   * server materializes the snapshot from its own state — we used to
   * send `{version: getVersion(state), doc: state.doc.toJSON()}`, but
   * `getVersion` is the confirmed version while `state.doc` reflects
   * unconfirmed steps, and any in-flight POST /events landed a
   * mismatched pair that corrupted future hydrates.
   *
   * `lastSnapshotVersion` is updated from the server's response so the
   * threshold check measures from the actual stored version, not what
   * the client thought it asked for.
   */
  async snapshot(): Promise<void> {
    if (!this.view) return;
    const resp = await this.postJson("/snapshot", "{}");
    if (resp.ok) {
      const data = (await resp.json().catch(() => null)) as {
        version?: number;
      } | null;
      if (data && typeof data.version === "number") {
        this.lastSnapshotVersion = data.version;
      }
    }
  }
}
