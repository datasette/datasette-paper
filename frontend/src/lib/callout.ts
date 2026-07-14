/**
 * ProseMirror commands for the `callout` block (GitHub-style admonitions).
 *
 * `callout` has a required first child (`callout_title`), which is exactly why
 * the stock `wrapIn(callout)` can't be used: `findWrapping` never fits a node
 * whose content spec starts with a mandatory node it can't synthesize. Every
 * command here builds the callout (or its inverse) explicitly and splices it in
 * with `replaceRangeWith` / `replaceWith`.
 *
 * Callouts are top-level-only (the `doc` content override in schema.ts keeps
 * them out of every other container), so all the ancestor walks below stop at
 * depth 1 — a callout / blockquote deeper than that is structurally impossible.
 *
 * @feat callout: PM commands — insert / wrap / upgrade-from-quote / to-quote /
 * unwrap, plus the title Enter + empty-title Backspace keymap handlers.
 */
import {
  TextSelection,
  Selection,
  type Command,
  type Transaction,
} from "prosemirror-state";
import { Fragment, type Node as PMNode, type ResolvedPos } from "prosemirror-model";
import { schema, type CalloutKind } from "./schema";

/** The top-level callout (or blockquote) enclosing `$pos`, with its outer
 * bounds. Returns null when `$pos` isn't inside one. Callouts only ever live at
 * depth 1, so the walk requires exactly that depth. */
function findAncestor(
  $pos: ResolvedPos,
  type: PMNode["type"],
): { node: PMNode; before: number; after: number } | null {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type === type) {
      // Nesting is forbidden, so only a depth-1 match is a real callout/quote.
      if (d !== 1) return null;
      return { node: $pos.node(d), before: $pos.before(d), after: $pos.after(d) };
    }
  }
  return null;
}

/** Build a callout node wrapping `body` (already `block+`) with an empty (or
 * given) title. */
function buildCallout(kind: CalloutKind, body: readonly PMNode[], title?: PMNode): PMNode {
  return schema.nodes.callout.create({ kind }, [
    title ?? schema.nodes.callout_title.create(),
    ...body,
  ]);
}

/** Content position just inside a freshly-inserted callout's title, given the
 * callout's outer start position (the position directly before it). */
function titlePos(calloutStart: number): number {
  // +1 into the callout (before the title), +1 into the title's content.
  return calloutStart + 2;
}

/**
 * At an empty top-level paragraph, replace it with
 * `callout(callout_title, paragraph)` and drop the cursor in the (empty) title.
 * Refuses (returns false) anywhere else — the slash menu only offers it in an
 * empty top-level block, and there's nothing sensible to do otherwise.
 */
export function insertCallout(kind: CalloutKind): Command {
  return (state, dispatch) => {
    const { $from, empty } = state.selection;
    if (!empty || $from.depth !== 1) return false;
    const para = $from.parent;
    if (para.type !== schema.nodes.paragraph || para.content.size !== 0) return false;
    if (!dispatch) return true;
    const node = buildCallout(kind, [schema.nodes.paragraph.create()]);
    const start = $from.before(1);
    const end = $from.after(1);
    let tr = state.tr.replaceRangeWith(start, end, node);
    tr = tr.setSelection(TextSelection.create(tr.doc, titlePos(start)));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * Wrap the selected top-level block range in a callout (empty title, the blocks
 * as body). Enabled only when the selection's shared depth is 0 (top level) and
 * the range holds no existing callout — a callout can't nest, and its body is
 * `block+`, which every non-callout top-level block satisfies. Cursor lands in
 * the empty title so the wrap can be named immediately.
 */
export function wrapSelectionInCallout(kind: CalloutKind): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    const range = $from.blockRange($to);
    if (!range || range.depth !== 0) return false;
    const body: PMNode[] = [];
    for (let i = range.startIndex; i < range.endIndex; i++) {
      const child = range.parent.child(i);
      if (child.type === schema.nodes.callout) return false;
      body.push(child);
    }
    if (!body.length) return false;
    if (!dispatch) return true;
    const node = buildCallout(kind, body);
    let tr = state.tr.replaceRangeWith(range.start, range.end, node);
    tr = tr.setSelection(TextSelection.create(tr.doc, titlePos(range.start)));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * Replace a depth-1 blockquote (the input rule's target) with a callout that
 * carries the quote's children as its body and an empty title — on `tr`, in
 * place. Returns true when it applied. Shared by the `upgradeBlockquote` command
 * and the `[!kind] ` input rule so both build the identical shape.
 */
export function upgradeBlockquoteInTr(
  tr: Transaction,
  $pos: ResolvedPos,
  kind: CalloutKind,
): boolean {
  const found = findAncestor($pos, schema.nodes.blockquote);
  if (!found) return false;
  const { node: bq, before, after } = found;
  const body: PMNode[] = [];
  bq.forEach((child) => body.push(child));
  if (!body.length) return false;
  const node = buildCallout(kind, body);
  tr.replaceRangeWith(before, after, node);
  // Land the cursor at the start of the first body block (where the marker
  // text used to be), using Selection.near so a non-textblock first child
  // still resolves to a valid selection.
  const afterTitle = before + 1 + node.child(0).nodeSize;
  tr.setSelection(Selection.near(tr.doc.resolve(afterTitle), 1));
  return true;
}

/** Command form of the in-place blockquote → callout upgrade. */
export function upgradeBlockquote(kind: CalloutKind): Command {
  return (state, dispatch) => {
    if (!findAncestor(state.selection.$from, schema.nodes.blockquote)) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    upgradeBlockquoteInTr(tr, tr.doc.resolve(state.selection.$from.pos), kind);
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Split a callout's children into `[title, ...body]`. */
function calloutParts(callout: PMNode): { title: PMNode; body: PMNode[] } {
  const body: PMNode[] = [];
  for (let i = 1; i < callout.childCount; i++) body.push(callout.child(i));
  return { title: callout.child(0), body };
}

/** A non-empty title becomes a leading paragraph; an empty one is dropped. */
function titleAsParagraph(title: PMNode): PMNode[] {
  return title.content.size > 0 ? [schema.nodes.paragraph.create(null, title.content)] : [];
}

/**
 * Turn the callout around the selection back into a blockquote. A non-empty
 * title is preserved as the quote's first paragraph so nothing is lost.
 */
export const calloutToQuote: Command = (state, dispatch) => {
  const found = findAncestor(state.selection.$from, schema.nodes.callout);
  if (!found) return false;
  if (!dispatch) return true;
  const { node: callout, before, after } = found;
  const { title, body } = calloutParts(callout);
  const quote = schema.nodes.blockquote.create(null, [...titleAsParagraph(title), ...body]);
  const tr = state.tr.replaceRangeWith(before, after, quote);
  tr.setSelection(Selection.near(tr.doc.resolve(before + 1), 1));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Dissolve the callout around the selection, lifting its body blocks to the top
 * level. A non-empty title becomes a leading paragraph; an empty one is dropped.
 */
export const unwrapCallout: Command = (state, dispatch) => {
  const found = findAncestor(state.selection.$from, schema.nodes.callout);
  if (!found) return false;
  if (!dispatch) return true;
  const { node: callout, before, after } = found;
  const { title, body } = calloutParts(callout);
  const blocks = [...titleAsParagraph(title), ...body];
  const tr = state.tr.replaceWith(before, after, Fragment.fromArray(blocks));
  tr.setSelection(Selection.near(tr.doc.resolve(before + 1), 1));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Enter inside a `callout_title`: move the cursor to the start of the first
 * body block instead of splitting (a split would try to split the callout,
 * which its content spec forbids). Returns false outside a title so the normal
 * Enter chain still runs.
 */
export const enterInCalloutTitle: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.parent.type !== schema.nodes.callout_title) return false;
  const calloutDepth = $from.depth - 1;
  if ($from.node(calloutDepth).type !== schema.nodes.callout) return false;
  if (!dispatch) return true;
  const before = $from.before(calloutDepth);
  const afterTitle = before + 1 + $from.node(calloutDepth).child(0).nodeSize;
  const tr = state.tr.setSelection(Selection.near(state.doc.resolve(afterTitle), 1));
  dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Backspace at the very start of an *empty* `callout_title` unwraps the callout
 * (mirrors how a blockquote/list dissolves from its first position). Returns
 * false in every other case so ordinary deletion still happens.
 */
export const backspaceEmptyCalloutTitle: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  if ($from.parent.type !== schema.nodes.callout_title) return false;
  if ($from.parentOffset !== 0 || $from.parent.content.size !== 0) return false;
  return unwrapCallout(state, dispatch);
};
