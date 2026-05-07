// Shared openapi-fetch client for the datasette-paper backend.
//
// Sets `Content-Type: application/json` as a default header so Datasette's
// built-in `skip_csrf` hook waives CSRF enforcement for our API. Without
// it, bodyless POSTs (e.g. delete endpoints) get no Content-Type and
// asgi_csrf returns UNKNOWN_CONTENT_TYPE → 403.
import createClient from "openapi-fetch";
import type { paths } from "../../api.d.ts";

export const client = createClient<paths>({
  baseUrl: "/",
  headers: { "Content-Type": "application/json" },
});
