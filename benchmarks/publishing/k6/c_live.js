// k6 alternative for scenario C (live published page — static HTML + the
// hydrator's K per-viewer data XHRs). Pass the block queries as a JSON array.
// Usage: BASE=… DOC=13 QUERIES='["select ...","select ..."]' k6 run c_live.js
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE || "http://localhost:8487";
const DOC = __ENV.DOC || "1";
const QUERIES = JSON.parse(__ENV.QUERIES || "[]");
const DB = __ENV.DB || "data";

export const options = {
  stages: [
    { duration: "10s", target: 50 },
    { duration: "20s", target: 200 },
    { duration: "10s", target: 0 },
  ],
};

export default function () {
  check(http.get(`${BASE}/-/paper/doc/${DOC}/publish`), {
    "page 200": (r) => r.status === 200,
  });
  for (const sql of QUERIES) {
    const url = `${BASE}/${DB}/-/query.json?sql=${encodeURIComponent(
      sql,
    )}&_shape=arrays&_extra=columns`;
    check(http.get(url), { "xhr 200": (r) => r.status === 200 });
  }
}
