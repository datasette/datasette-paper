// k6 alternative for scenario B (frozen published page — one cheap read).
// Usage: BASE=http://localhost:8487 DOC=12 k6 run benchmarks/publishing/k6/b_frozen.js
//   Ramps VUs and records the http_req_duration percentiles. See bench.py for
//   the self-contained Python driver (no k6 install required).
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE || "http://localhost:8487";
const DOC = __ENV.DOC || "1";

export const options = {
  stages: [
    { duration: "10s", target: 50 },
    { duration: "20s", target: 500 },
    { duration: "10s", target: 0 },
  ],
  thresholds: { http_req_duration: ["p(95)<50"] },
};

export default function () {
  const r = http.get(`${BASE}/-/paper/doc/${DOC}/publish`);
  check(r, { "200": (res) => res.status === 200 });
}
