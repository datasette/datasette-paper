// Signed ds_actor cookie for an actor id. itsdangerous has no maintained Node
// port, so shell out to the same one-liner the e2e helpers use. Cached per id.
import { execFileSync } from "node:child_process";
import { SECRET } from "./config.mjs";

const _signed = new Map();

export function signActorCookie(actorId) {
  let v = _signed.get(actorId);
  if (!v) {
    const out = execFileSync(
      "uv",
      [
        "run",
        "--prerelease=allow",
        "python",
        "-c",
        "import sys, json; from itsdangerous import URLSafeSerializer; " +
          'print(URLSafeSerializer(sys.argv[1]).dumps(json.loads(sys.argv[2]), salt="actor"))',
        SECRET,
        JSON.stringify({ a: { id: actorId } }),
      ],
      { encoding: "utf-8" },
    );
    v = out.trim();
    _signed.set(actorId, v);
  }
  return v;
}
