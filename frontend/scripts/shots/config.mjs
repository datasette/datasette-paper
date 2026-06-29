// Shared constants for the screenshot harness. Imported by every other
// shots/*.mjs module and by each shot in shots/defs/.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const PORT = Number(process.env.SHOTS_PORT || 8486);
export const BASE = `http://localhost:${PORT}`;
export const PAPER = `${BASE}/-/paper`;
// Fixed signing secret — lets us mint a signed actor cookie so seeded papers
// are owned (mirrors the e2e harness's hard-coded secret). NOT a real secret.
export const SECRET = "screenshots-secret-not-for-prod";
export const DB = "/tmp/datasette-paper-shots-internal.db";
// A small user database attached so datasette_ref / datasette_embed have a
// real resource to resolve + render. The directory name makes the Datasette
// database name "data", so refs read `/data/vendors` (mirrors the e2e setup).
export const DATA_DIR = "/tmp/datasette-paper-shots-data";
export const DATA_DB = `${DATA_DIR}/data.db`;
// The browsing actor (owns the rich doc → full owner / manager UI).
export const ACTOR = "alice";

const HERE = dirname(fileURLToPath(import.meta.url)); // frontend/scripts/shots
export const PLUGINS_DIR = resolve(HERE, "../shot-plugins");
export const OUT = resolve(HERE, "../../../docs/screenshots");

export const VIEWPORT = { width: 1200, height: 780 };

// Absolute path of a shot's output PNG.
export const out = (name) => resolve(OUT, `${name}.png`);
