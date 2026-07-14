/**
 * @feat link-graph: colorblind-safe categorical palette for the link graph's
 * "Color by Tag / Kind" facet (T06).
 *
 * The Okabe–Ito qualitative set — eight hues chosen to stay distinguishable
 * under the common forms of colour-vision deficiency. The eighth entry
 * (`#999999`, a neutral grey) is deliberately the LAST slot: it doubles as the
 * "everything else" bucket — the colour handed to categories beyond the seven
 * distinct hues AND to untagged / stateless nodes. So the seven leading
 * entries are the real category hues and grey is the overflow/untagged marker.
 *
 * The hues are fixed literals rather than `--pp-*` tokens on purpose: they sit
 * on SVG node fills and read acceptably on both the light and dark canvas.
 * Any surrounding chrome (legend swatches, toolbar) is themed with `--pp-*`
 * tokens by the component; only the fills themselves use these constants.
 */

/** The full 8-hue Okabe–Ito array; index 7 (`#999999`) is the overflow grey. */
export const OKABE_ITO = [
  "#0072B2", // blue
  "#E69F00", // orange
  "#009E73", // bluish green
  "#CC79A7", // reddish purple
  "#56B4E9", // sky blue
  "#D55E00", // vermillion
  "#F0E442", // yellow
  "#999999", // neutral grey — overflow / untagged bucket
] as const;

/**
 * Neutral grey used for the overflow bucket (the 8th+ category) and for
 * untagged / stateless nodes. Same value as `OKABE_ITO[7]`.
 */
export const GRAPH_OVERFLOW_COLOR = "#999999";

/**
 * The seven distinct category hues (the palette minus the overflow grey).
 * A category is assigned `CATEGORY_COLORS[i]` for its sort position `i`;
 * positions ≥ 7 fall back to {@link GRAPH_OVERFLOW_COLOR}.
 */
export const CATEGORY_COLORS = OKABE_ITO.slice(0, 7);

/**
 * Deterministically assign a colour to each category key. Keys are
 * de-duplicated and sorted (stable, lexicographic) so a given key always lands
 * on the same hue regardless of insertion order or counts — colours never
 * shuffle between reloads. The first seven keys take the distinct hues; any
 * beyond that share the neutral overflow grey.
 *
 * Pure and importable so both the legend derivation and `colorFor` can share
 * one source of truth.
 */
export function assignCategoryColors(keys: Iterable<string>): Map<string, string> {
  const sorted = [...new Set(keys)].sort();
  const assignment = new Map<string, string>();
  sorted.forEach((key, i) => {
    assignment.set(key, i < CATEGORY_COLORS.length ? CATEGORY_COLORS[i] : GRAPH_OVERFLOW_COLOR);
  });
  return assignment;
}
