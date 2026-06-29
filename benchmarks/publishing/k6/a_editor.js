// k6 alternative for scenario A (status quo — the live editor). Approximates a
// read-only viewer: the editor page + the bootstrap document + the K data XHRs.
// (A full SSE hold is left to the Python driver / a dedicated SSE load tool.)
// Usage: BASE=… DOC=13 QUERIES='[...]' k6 run a_editor.js
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE || "http://localhost:8487";
const DOC = __ENV.DOC || "1";
const QUERIES = JSON.parse(__ENV.QUERIES || "[]");
const DB = __ENV.DB || "data";

export const options = {
  stages: [
    { duration: "10s", target: 25 },
    { duration: "20s", target: 100 },
    { duration: "10s", target: 0 },
  ],
};

export default function () {
  check(http.get(`${BASE}/-/paper/doc/${DOC}`), { "page 200": (r) => r.status === 200 });
  check(http.get(`${BASE}/-/paper/api/docs/${DOC}/document`), {
    "bootstrap 200": (r) => r.status === 200,
  });
  for (const sql of QUERIES) {
    const url = `${BASE}/${DB}/-/query.json?sql=${encodeURIComponent(
      sql,
    )}&_shape=arrays&_extra=columns`;
    check(http.get(url), { "xhr 200": (r) => r.status === 200 });
  }
}
