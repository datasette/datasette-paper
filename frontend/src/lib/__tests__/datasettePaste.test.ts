/**
 * Tests for context-aware Datasette URL paste: ref parsing, surface choice,
 * and the paste handler's inline-vs-block insertion.
 */
import { describe, it, expect, afterEach } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { schema } from "../schema";
import {
  parseDatasetteRef,
  matchExternalRef,
  matchManifestRef,
  chooseDatasetteSurface,
  handleDatasettePaste,
} from "../datasettePaste";
import { embedRegistry, _resetEmbedRegistryForTest } from "../embedRegistry";
import { setProviderManifest, _resetProvidersForTest } from "../embedProviders";

const ORIGIN = "http://localhost";
const ctx = { origin: ORIGIN };

describe("parseDatasetteRef", () => {
  it("accepts same-origin db / table / row paths", () => {
    expect(parseDatasetteRef(`${ORIGIN}/fixtures`, ctx)).toBe("/fixtures");
    expect(parseDatasetteRef(`${ORIGIN}/fixtures/facetable`, ctx)).toBe(
      "/fixtures/facetable",
    );
    expect(parseDatasetteRef(`${ORIGIN}/fixtures/facetable/42`, ctx)).toBe(
      "/fixtures/facetable/42",
    );
  });

  it("accepts an absolute path (no origin)", () => {
    expect(parseDatasetteRef("/fixtures/facetable", ctx)).toBe(
      "/fixtures/facetable",
    );
  });

  it("strips a query string and trailing slash", () => {
    expect(parseDatasetteRef(`${ORIGIN}/fixtures/facetable/?_facet=x`, ctx)).toBe(
      "/fixtures/facetable",
    );
  });

  it("rejects external origins", () => {
    expect(parseDatasetteRef("https://evil.com/fixtures/facetable", ctx)).toBeNull();
  });

  it("rejects plain words and non-url text", () => {
    expect(parseDatasetteRef("facetable", ctx)).toBeNull();
    expect(parseDatasetteRef("just some text", ctx)).toBeNull();
    expect(parseDatasetteRef("", ctx)).toBeNull();
  });

  it("rejects tooling / plugin / static paths", () => {
    expect(parseDatasetteRef(`${ORIGIN}/-/paper/doc/1`, ctx)).toBeNull();
    expect(parseDatasetteRef(`${ORIGIN}/_internal/x`, ctx)).toBeNull();
  });

  it("rejects paths deeper than a row (4+ segments)", () => {
    expect(parseDatasetteRef(`${ORIGIN}/a/b/c/d`, ctx)).toBeNull();
  });

  it("honours a non-root base_url", () => {
    expect(
      parseDatasetteRef(`${ORIGIN}/data/fixtures/facetable`, {
        origin: ORIGIN,
        baseUrl: "/data/",
      }),
    ).toBe("/fixtures/facetable");
  });
});

// --- third-party provider URL claiming -----------------------------------

describe("matchExternalRef", () => {
  afterEach(() => {
    _resetEmbedRegistryForTest();
  });

  it("lets a registered provider claim a same-origin plugin URL", () => {
    embedRegistry().register({
      kind: "place-list",
      matchUrl: (url) => {
        const m = url.pathname.match(/^\/-\/places\/list\/(\d+)$/);
        return m ? `/-/places/list/${m[1]}` : null;
      },
      mount: () => {},
    });
    expect(matchExternalRef(`${ORIGIN}/-/places/list/5`, ORIGIN)).toBe(
      "/-/places/list/5",
    );
  });

  it("rejects external origins even when a provider would claim the path", () => {
    embedRegistry().register({
      kind: "place-list",
      matchUrl: () => "/-/places/list/5",
      mount: () => {},
    });
    expect(matchExternalRef("https://evil.com/-/places/list/5", ORIGIN)).toBeNull();
  });

  it("returns null when no provider claims the URL", () => {
    expect(matchExternalRef(`${ORIGIN}/-/places/list/5`, ORIGIN)).toBeNull();
  });
});

// --- surface choice -------------------------------------------------------

function emptyParaState(): EditorState {
  const doc = schema.node("doc", null, [schema.node("paragraph")]);
  const s = EditorState.create({ doc });
  return s.apply(s.tr.setSelection(TextSelection.atStart(s.doc)));
}

function midTextState(): EditorState {
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("hello world")]),
  ]);
  const s = EditorState.create({ doc });
  return s.apply(s.tr.setSelection(TextSelection.create(s.doc, 4)));
}

function listItemState(): EditorState {
  const doc = schema.node("doc", null, [
    schema.node("bullet_list", null, [
      schema.node("list_item", null, [schema.node("paragraph")]),
    ]),
  ]);
  const s = EditorState.create({ doc });
  return s.apply(s.tr.setSelection(TextSelection.atStart(s.doc)));
}

describe("chooseDatasetteSurface", () => {
  it("empty top paragraph + table ref → block", () => {
    expect(chooseDatasetteSurface(emptyParaState(), "/d/t")).toBe("block");
  });
  it("mid-text → inline", () => {
    expect(chooseDatasetteSurface(midTextState(), "/d/t")).toBe("inline");
  });
  it("database ref is always inline, even in an empty block", () => {
    expect(chooseDatasetteSurface(emptyParaState(), "/d")).toBe("inline");
  });
  it("nested context (list item) → inline", () => {
    expect(chooseDatasetteSurface(listItemState(), "/d/t")).toBe("inline");
  });
});

// --- paste handler --------------------------------------------------------

function fakeView(state: EditorState): {
  view: EditorView;
  getDoc: () => EditorState;
} {
  let current = state;
  const view = {
    get state() {
      return current;
    },
    dispatch(tr: import("prosemirror-state").Transaction) {
      current = current.apply(tr);
    },
  } as unknown as EditorView;
  return { view, getDoc: () => current };
}

function pasteEvent(text: string): ClipboardEvent {
  return {
    clipboardData: { getData: () => text },
  } as unknown as ClipboardEvent;
}

describe("handleDatasettePaste", () => {
  it("inserts a block embed when pasting a table URL in an empty block", () => {
    const { view, getDoc } = fakeView(emptyParaState());
    const claimed = handleDatasettePaste(view, pasteEvent("/fixtures/facetable"), ctx);
    expect(claimed).toBe(true);
    expect(getDoc().doc.firstChild!.type.name).toBe("block_embed");
    expect(getDoc().doc.firstChild!.attrs.ref).toBe("/fixtures/facetable");
  });

  it("inserts an inline ref when pasting a table URL mid-text", () => {
    const { view, getDoc } = fakeView(midTextState());
    const claimed = handleDatasettePaste(view, pasteEvent("/fixtures/facetable"), ctx);
    expect(claimed).toBe(true);
    const para = getDoc().doc.firstChild!;
    const types = [] as string[];
    para.forEach((n) => types.push(n.type.name));
    expect(types).toContain("inline_embed");
  });

  it("inserts an inline ref for a row URL mid-text", () => {
    const { view, getDoc } = fakeView(midTextState());
    handleDatasettePaste(view, pasteEvent("/fixtures/vendors/42"), ctx);
    let found = false;
    getDoc().doc.firstChild!.forEach((n) => {
      if (n.type.name === "inline_embed" && n.attrs.ref === "/fixtures/vendors/42") {
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it("falls through (returns false) for a non-Datasette URL", () => {
    const { view, getDoc } = fakeView(emptyParaState());
    const claimed = handleDatasettePaste(
      view,
      pasteEvent("https://example.com/page"),
      ctx,
    );
    expect(claimed).toBe(false);
    // Doc untouched (still an empty paragraph).
    expect(getDoc().doc.firstChild!.type.name).toBe("paragraph");
    expect(getDoc().doc.firstChild!.content.size).toBe(0);
  });

  it("inserts a provider-claimed plugin URL as a block embed", () => {
    embedRegistry().register({
      kind: "place-list",
      matchUrl: (url) =>
        url.pathname.startsWith("/-/places/list/") ? url.pathname : null,
      mount: () => {},
    });
    try {
      const { view, getDoc } = fakeView(emptyParaState());
      const claimed = handleDatasettePaste(
        view,
        pasteEvent(`${ORIGIN}/-/places/list/5`),
        ctx,
      );
      expect(claimed).toBe(true);
      expect(getDoc().doc.firstChild!.type.name).toBe("block_embed");
      expect(getDoc().doc.firstChild!.attrs.ref).toBe("/-/places/list/5");
    } finally {
      _resetEmbedRegistryForTest();
    }
  });
});

describe("handleDatasettePaste with a filtered table URL", () => {
  const FILTERED = `${ORIGIN}/fixtures/facetable?state__contains=CA&_sort_desc=pop&_col=name`;

  it("carries filters / sort / columns into the block embed's config", () => {
    const { view, getDoc } = fakeView(emptyParaState());
    const claimed = handleDatasettePaste(view, pasteEvent(FILTERED), ctx);
    expect(claimed).toBe(true);
    const node = getDoc().doc.firstChild!;
    expect(node.type.name).toBe("block_embed");
    expect(node.attrs.ref).toBe("/fixtures/facetable");
    expect(node.attrs.config).toEqual({
      filters: [{ column: "state", op: "contains", value: "CA" }],
      sort: { column: "pop", desc: true },
      columns: ["name"],
    });
  });

  it("keeps the {} config default for a plain URL (no query)", () => {
    const { view, getDoc } = fakeView(emptyParaState());
    handleDatasettePaste(view, pasteEvent(`${ORIGIN}/fixtures/facetable`), ctx);
    const node = getDoc().doc.firstChild!;
    expect(node.type.name).toBe("block_embed");
    expect(node.attrs.config).toEqual({});
  });

  it("drops the params on a mid-text paste (inline surface has no config)", () => {
    const { view, getDoc } = fakeView(midTextState());
    const claimed = handleDatasettePaste(view, pasteEvent(FILTERED), ctx);
    expect(claimed).toBe(true);
    let found = false;
    getDoc().doc.firstChild!.forEach((n) => {
      if (n.type.name === "inline_embed" && n.attrs.ref === "/fixtures/facetable") {
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it("drops the params on a database URL (always inline)", () => {
    const { view, getDoc } = fakeView(emptyParaState());
    const claimed = handleDatasettePaste(
      view,
      pasteEvent(`${ORIGIN}/fixtures?state__exact=CA&_sort=name`),
      ctx,
    );
    expect(claimed).toBe(true);
    let found = false;
    getDoc().doc.firstChild!.forEach((n) => {
      if (n.type.name === "inline_embed" && n.attrs.ref === "/fixtures") {
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it("drops the params on a row URL (3 segments take no filters)", () => {
    const { view, getDoc } = fakeView(emptyParaState());
    handleDatasettePaste(
      view,
      pasteEvent(`${ORIGIN}/fixtures/vendors/42?state__exact=CA`),
      ctx,
    );
    const node = getDoc().doc.firstChild!;
    expect(node.type.name).toBe("block_embed");
    expect(node.attrs.ref).toBe("/fixtures/vendors/42");
    expect(node.attrs.config).toEqual({});
  });

  it("still strips a non-root base_url before parsing ref and params", () => {
    const { view, getDoc } = fakeView(emptyParaState());
    handleDatasettePaste(
      view,
      pasteEvent(`${ORIGIN}/data/fixtures/facetable?state__exact=CA`),
      { origin: ORIGIN, baseUrl: "/data/" },
    );
    const node = getDoc().doc.firstChild!;
    expect(node.attrs.ref).toBe("/fixtures/facetable");
    expect(node.attrs.config).toEqual({
      filters: [{ column: "state", op: "exact", value: "CA" }],
    });
  });
});

describe("matchManifestRef (lazy provider, bundle not yet loaded)", () => {
  afterEach(() => _resetProvidersForTest());

  it("claims a same-origin URL whose path is under a manifest ref prefix", () => {
    setProviderManifest([{ kind: "places", ref_prefixes: ["/-/places/"] }]);
    expect(matchManifestRef(`${ORIGIN}/-/places/list/5`, ctx)).toBe(
      "/-/places/list/5",
    );
  });

  it("ignores URLs no manifest provider claims, and other origins", () => {
    setProviderManifest([{ kind: "places", ref_prefixes: ["/-/places/"] }]);
    expect(matchManifestRef(`${ORIGIN}/data/vendors`, ctx)).toBeNull();
    expect(matchManifestRef("https://evil.test/-/places/list/5", ctx)).toBeNull();
  });

  it("strips a non-root base_url before matching the prefix", () => {
    setProviderManifest([{ kind: "places", ref_prefixes: ["/-/places/"] }]);
    expect(
      matchManifestRef(`${ORIGIN}/app/-/places/list/5`, {
        origin: ORIGIN,
        baseUrl: "/app/",
      }),
    ).toBe("/-/places/list/5");
  });

  it("the paste handler falls back to the manifest for an unloaded provider", () => {
    setProviderManifest([{ kind: "places", ref_prefixes: ["/-/places/"] }]);
    const { view, getDoc } = fakeView(emptyParaState());
    const claimed = handleDatasettePaste(
      view,
      pasteEvent(`${ORIGIN}/-/places/list/5`),
      ctx,
    );
    expect(claimed).toBe(true);
    expect(getDoc().doc.firstChild!.type.name).toBe("block_embed");
    expect(getDoc().doc.firstChild!.attrs.ref).toBe("/-/places/list/5");
  });
});
