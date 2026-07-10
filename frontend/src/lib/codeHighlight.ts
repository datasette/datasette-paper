/**
 * Tier-0 static syntax highlighting for the three code-carrying block types
 * (`code_block`, `sql_block`, `source`) — see plans/codemirror/02-design.md
 * §3. A single ProseMirror plugin decorates code with `tok-*` inline classes
 * so viewers (and editors not focused on a block) get colored code at
 * near-zero cost: nothing from `@codemirror/*` is on this path, only
 * `@lezer/highlight` plus the one lazy grammar chunk per language actually
 * present in the doc.
 *
 * The classes come from `@lezer/highlight`'s `classHighlighter` — the exact
 * same `tok-*` classes CodeMirror emits in tier 1 (T05), which is what keeps
 * the static↔CM mode swap color-stable. They resolve to the `--pp-code-*`
 * semantic palette via the token map in editor.css.
 *
 * Grammars load lazily and asynchronously: a block whose grammar isn't
 * resolved yet renders plain, the memoized `highlight()` loader is kicked
 * off, and on resolve a `grammar-ready` meta transaction recomputes every
 * block. First paint never blocks on a grammar. Decorations are mapped
 * through transactions and only blocks whose text actually changed are
 * re-parsed; blocks over 50k chars are skipped entirely (CM parses them
 * incrementally when focused, so tier 1 still works there).
 */
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import type { Parser } from "@lezer/common";
import { resolveLanguage, type PaperLanguage } from "./languages";

// Blocks larger than this many characters are left un-highlighted at tier 0.
const MAX_HIGHLIGHT_CHARS = 50_000;

const CODE_CARRYING = new Set(["code_block", "sql_block", "source"]);

interface GrammarReadyMeta {
  type: "grammar-ready";
  language: string;
}

interface CodeHighlightState {
  decorations: DecorationSet;
}

export const codeHighlightKey = new PluginKey<CodeHighlightState>(
  "codeHighlight",
);

/** The registry entry a code-carrying node highlights against, if any. */
function languageFor(node: PMNode): PaperLanguage | undefined {
  const name = node.type.name;
  if (name === "code_block") return resolveLanguage(node.attrs.language);
  // sql_block / source are always SQL, regardless of any stored token.
  if (name === "sql_block" || name === "source") return resolveLanguage("sql");
  return undefined;
}

/**
 * Collect the changed ranges of a doc-changing transaction, in coordinates of
 * the resulting document, so we can re-parse only the blocks they touch.
 */
function changedRanges(tr: Transaction): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const maps = tr.mapping.maps;
  for (let i = 0; i < maps.length; i++) {
    maps[i].forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const rest = tr.mapping.slice(i + 1);
      ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
    });
  }
  return ranges;
}

function overlapsChanged(
  from: number,
  to: number,
  ranges: Array<[number, number]>,
): boolean {
  return ranges.some(([a, b]) => from <= b && a <= to);
}

/**
 * Build a fresh plugin. Each editor gets its own loaded-parser cache and view
 * handle (no module-level state, so instances and tests stay isolated).
 */
// @feat code-highlight: PM decoration plugin — lezer-parses each code-carrying
// block and emits classHighlighter `tok-*` inline decorations, async grammar
// loading with grammar-ready recompute, incremental per-block re-parse, 50k valve
export function codeHighlightPlugin(): Plugin<CodeHighlightState> {
  // Resolved parsers, keyed by language id — the synchronous view of the
  // languages registry's async `highlight()` loaders.
  const loaded = new Map<string, Parser>();
  // Language ids whose load is in flight, so we attach one recompute per load.
  const requested = new Set<string>();
  let view: EditorView | null = null;

  function scheduleLoad(entry: PaperLanguage): void {
    if (loaded.has(entry.id) || requested.has(entry.id)) return;
    requested.add(entry.id);
    entry.highlight().then(
      ({ parser }) => {
        loaded.set(entry.id, parser);
        requested.delete(entry.id);
        if (view && !view.isDestroyed) {
          const meta: GrammarReadyMeta = {
            type: "grammar-ready",
            language: entry.id,
          };
          view.dispatch(view.state.tr.setMeta(codeHighlightKey, meta));
        }
      },
      () => {
        // Failed load: drop the flag so a later pass can retry.
        requested.delete(entry.id);
      },
    );
  }

  /** Inline decorations for one code-carrying block, or `[]` (plain). */
  function decosForBlock(node: PMNode, pos: number): Decoration[] {
    const entry = languageFor(node);
    if (!entry) return [];
    const text = node.textContent;
    if (!text || text.length > MAX_HIGHLIGHT_CHARS) return [];
    const parser = loaded.get(entry.id);
    if (!parser) {
      scheduleLoad(entry);
      return [];
    }
    const tree = parser.parse(text);
    // Character offset 0 in `textContent` sits at pos + 1 (just inside the
    // block node); a textblock's content is a flat run of text.
    const start = pos + 1;
    const out: Decoration[] = [];
    highlightTree(tree, classHighlighter, (from, to, cls) => {
      out.push(Decoration.inline(start + from, start + to, { class: cls }));
    });
    return out;
  }

  function buildAll(doc: PMNode): DecorationSet {
    const decos: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (!CODE_CARRYING.has(node.type.name)) return true;
      decos.push(...decosForBlock(node, pos));
      return false;
    });
    return DecorationSet.create(doc, decos);
  }

  return new Plugin<CodeHighlightState>({
    key: codeHighlightKey,
    state: {
      init(_config, state) {
        return { decorations: buildAll(state.doc) };
      },
      apply(tr, prev, _oldState, newState) {
        const meta = tr.getMeta(codeHighlightKey) as
          | GrammarReadyMeta
          | undefined;
        // A newly loaded grammar can affect blocks anywhere — full rebuild.
        if (meta?.type === "grammar-ready") {
          return { decorations: buildAll(newState.doc) };
        }
        // No doc change → positions and text are stable; keep the set as-is.
        if (!tr.docChanged) return prev;
        // Map the existing set forward, then re-parse only touched blocks.
        let decos = prev.decorations.map(tr.mapping, tr.doc);
        const changed = changedRanges(tr);
        newState.doc.descendants((node, pos) => {
          if (!CODE_CARRYING.has(node.type.name)) return true;
          const from = pos;
          const to = pos + node.nodeSize;
          if (overlapsChanged(from, to, changed)) {
            decos = decos.remove(decos.find(from, to));
            const fresh = decosForBlock(node, pos);
            if (fresh.length) decos = decos.add(tr.doc, fresh);
          }
          return false;
        });
        return { decorations: decos };
      },
    },
    view(editorView) {
      view = editorView;
      return {
        destroy() {
          view = null;
        },
      };
    },
    props: {
      decorations(state: EditorState) {
        return codeHighlightKey.getState(state)?.decorations;
      },
    },
  });
}
