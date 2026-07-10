/**
 * Standalone CodeMirror SQL field for form drafts whose text lives OUTSIDE
 * the ProseMirror doc — today the Sources panel's SQL input
 * (SourcesPanel.svelte). Unlike `CmTextSurface` (which mirrors a PM node and
 * leaves undo/redo to PM history), this field owns its document outright, so
 * it installs CM's own history and simply reports changes to the host via
 * `onChange`; the host keeps its draft state and only commits on Save.
 *
 * Everything CM comes through the `cmCore.ts` chokepoint plus the registry's
 * lazy `sql` loader (SQLite dialect + keyword completion), so mounting this
 * field pulls in the same single lazy chunk the in-doc editors use — no new
 * `@codemirror/*` import sites.
 */
import { loadCmCore, type CmCore, type EditorView as CmView, type LanguageSupport } from "./cmCore";
import { resolveLanguage } from "./languages";

export interface CmSqlFieldConfig {
  /** Element the editor mounts into. */
  parent: HTMLElement;
  /** Initial document text. */
  doc: string;
  /** Fires with the full document after every user edit (not after `setValue`). */
  onChange: (doc: string) => void;
  /** Mod-Enter handler (the panel binds its Test probe). */
  onSubmit?: () => void;
}

// @feat source: standalone CM SQL field (SQLite highlight + keyword
// completion + CM-owned history) backing the Sources panel's draft editor
export class CmSqlField {
  private cm: CmView;
  /** Re-entrancy guard so a host-driven `setValue` doesn't echo `onChange`. */
  private updating = false;

  private constructor(core: CmCore, support: LanguageSupport | null, cfg: CmSqlFieldConfig) {
    const keymap = cfg.onSubmit
      ? [
          {
            key: "Mod-Enter",
            run: (): boolean => {
              cfg.onSubmit?.();
              return true;
            },
          },
        ]
      : [];
    const state = core.EditorState.create({
      doc: cfg.doc,
      extensions: [
        support ? support : [],
        core.baseExtensions({
          keymap,
          // fixedTooltips: the panel flyout scrolls (overflow-y: auto), which
          // would crop an in-editor completion popup at the card edge.
          extra: [...core.completion(), ...core.history(), core.fixedTooltips()],
        }),
        core.EditorView.updateListener.of((u) => {
          if (u.docChanged && !this.updating) cfg.onChange(u.state.doc.toString());
        }),
      ],
    });
    this.cm = new core.EditorView({ state, parent: cfg.parent });
  }

  /** Resolve the CM core + SQL support (one shared lazy chunk), then mount.
   * Callers racing an unmount should `destroy()` the resolved field if their
   * host is gone by the time this settles. */
  static async create(cfg: CmSqlFieldConfig): Promise<CmSqlField> {
    const sqlEntry = resolveLanguage("sql");
    const [core, sql] = await Promise.all([
      loadCmCore(),
      sqlEntry ? sqlEntry.cm() : Promise.resolve(null),
    ]);
    return new CmSqlField(core, sql?.support ?? null, cfg);
  }

  getValue(): string {
    return this.cm.state.doc.toString();
  }

  /** Replace the whole document (host-driven, e.g. switching the edited
   * source) without echoing `onChange`. */
  setValue(next: string): void {
    const current = this.cm.state.doc.toString();
    if (next === current) return;
    this.updating = true;
    this.cm.dispatch({ changes: { from: 0, to: current.length, insert: next } });
    this.updating = false;
  }

  focus(): void {
    this.cm.focus();
  }

  destroy(): void {
    this.cm.destroy();
  }
}
