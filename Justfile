DEV_PORT := "5173"
INTERNAL_DEV_DB := "/tmp/datasette-paper-dev-internal.db"

# --- Frontend build & dev ---

frontend *flags:
    npm run build --prefix frontend {{flags}}

frontend-dev *flags:
    npm run dev --prefix frontend -- --port {{DEV_PORT}} {{flags}}

# Regenerate the committed doc screenshots in docs/screenshots/. Self-contained:
# the script boots a throwaway datasette, seeds papers, drives Playwright, then
# tears it down. Builds the bundle first so shots reflect the current frontend.
# Pass shot names to regenerate a subset, e.g. `just shots editor tables`.
shots *names:
    just frontend
    npm --prefix frontend exec -- playwright install chromium
    node frontend/scripts/screenshots.mjs {{names}}

# --- Formatting ---
# Frontend formatting (prettier) deferred — `just lint-frontend` covers it
# for now via eslint rules.

format-backend *flags:
    uv run --prerelease=allow ruff format {{flags}}

format-backend-check *flags:
    uv run --prerelease=allow ruff format --check {{flags}}

format:
    just format-backend

format-check:
    just format-backend-check

# --- Type / static checks ---

check-frontend:
    npm run check --prefix frontend

# Svelte-only type check. Faster than `check-frontend` while iterating.
check-frontend-app:
    cd frontend && npx svelte-check --tsconfig ./tsconfig.app.json

check-backend:
    uv run --prerelease=allow ruff check

check:
    just check-backend
    just check-features
    just check-telemetry-docs-fresh
    just check-frontend

# --- Lint ---

lint-frontend *flags:
    npm run lint --prefix frontend {{flags}}

lint-frontend-fix *flags:
    npm run lint:fix --prefix frontend {{flags}}

# --- API types ---

# Regenerate frontend/api.d.ts from the Python router's OpenAPI document.
# Run after route signature changes.
types-routes:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp=$(mktemp)
    trap "rm -f $tmp" EXIT
    uv run --prerelease=allow python -c \
        'from datasette_paper.router import router; import datasette_paper.routes; import json; print(json.dumps(router.openapi_document_json()))' \
        > "$tmp"
    npx --prefix frontend openapi-typescript "$tmp" > frontend/api.d.ts

types:
    just types-routes

# --- Codegen: SQL queries ---

# Regenerate datasette_paper/sql/_queries.py from queries.sql.
#
# Pipeline: migrations.py is the single source of truth for schema.
# We apply it to an ephemeral sqlite file with `sqlite-utils migrate`,
# then point `solite codegen` at that .db so it can resolve column
# types + nullability from the post-migration state. The JSON IR is
# checked in so PR diffs show what changed at the generator boundary;
# `tools/gen_queries.py` turns the IR into Python helpers that take a
# `sqlite3.Connection` as their first arg (to slot into PaperDB's
# `execute_write_fn` closures).
# Regenerate fixtures/markdown/*.doc.json from their .md sources
# (verifies each .md is in canonical serialized form first). Run after
# adding or editing a golden markdown fixture.
gen-markdown-fixtures:
    uv run --prerelease=allow python tools/markdown_fixtures.py

codegen-queries:
    #!/usr/bin/env bash
    set -euo pipefail
    # solite --schema keys off file extension; mktemp -u returns
    # an extensionless path so we append .db.
    tmp_db=$(mktemp -u).db
    trap "rm -f $tmp_db" EXIT
    uv run --prerelease=allow sqlite-utils migrate "$tmp_db" datasette_paper/migrations.py >/dev/null
    uv run solite codegen \
        --schema "$tmp_db" \
        datasette_paper/sql/queries.sql \
        > datasette_paper/sql/_queries.sql.json
    uv run --prerelease=allow python tools/gen_queries.py \
        datasette_paper/sql/_queries.sql.json \
        > datasette_paper/sql/_queries.py
    just format-backend datasette_paper/sql/_queries.py

# CI gate: regenerate into tmp files and diff against the checked-in
# copies. Fails if `just codegen-queries` hasn't been run after an
# edit to queries.sql / migrations.py / tools/gen_queries.py.
check-queries-fresh:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp_db=$(mktemp -u).db
    tmp_ir=$(mktemp)
    tmp_py=$(mktemp)
    trap "rm -f $tmp_db $tmp_ir $tmp_py" EXIT
    uv run --prerelease=allow sqlite-utils migrate "$tmp_db" datasette_paper/migrations.py >/dev/null
    uv run solite codegen \
        --schema "$tmp_db" \
        datasette_paper/sql/queries.sql \
        > "$tmp_ir"
    uv run --prerelease=allow python tools/gen_queries.py "$tmp_ir" > "$tmp_py"
    uv run --prerelease=allow ruff format --quiet "$tmp_py"
    diff -u datasette_paper/sql/_queries.sql.json "$tmp_ir" || {
        echo "::error:: _queries.sql.json is stale — run \`just codegen-queries\`"
        exit 1
    }
    diff -u datasette_paper/sql/_queries.py "$tmp_py" || {
        echo "::error:: _queries.py is stale — run \`just codegen-queries\`"
        exit 1
    }

# --- Codegen: telemetry reference ---

# Regenerate docs/TELEMETRY.md from datasette_paper/telemetry_registry.py.
# Run after any registry change (new span/metric/attribute, renamed entry,
# edited description). CI gate is `just check-telemetry-docs-fresh`.
telemetry-docs:
    uv run --prerelease=allow python tools/telemetry_doc.py

# CI gate: render to a temp file and diff against the checked-in copy.
check-telemetry-docs-fresh:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp=$(mktemp)
    trap "rm -f $tmp" EXIT
    uv run --prerelease=allow python tools/telemetry_doc.py "$tmp" >/dev/null
    diff -u docs/TELEMETRY.md "$tmp" || {
        echo "::error:: docs/TELEMETRY.md is stale — run \`just telemetry-docs\`"
        exit 1
    }

# Validate that the FEATURES.md registry and the in-code `@feat` markers
# stay in sync: no orphan/empty markers, every feature has a test marker,
# the start file is real, and schema-lockstep features touch all four
# mirror files. Both sides are hand-authored — this only checks, never
# generates. tools/features_check.py is project-agnostic; the flags below
# carry the datasette-paper specifics (scan roots + the schema lock-step
# mirror set from CLAUDE.md).
check-features:
    uv run --prerelease=allow python tools/features_check.py \
        --scan datasette_paper --scan frontend/src --scan tests \
        --ext .sql \
        --lockstep frontend/src/lib/schema.ts,datasette_paper/pm_schema.py,datasette_paper/markdown.py,datasette_paper/markdown_parser.py \
        --lockstep-exempt task-assign
# task-assign is not a schema feature (adds no nodes/marks) but reads the
# `date`/`mention` atoms in markdown.py's extract_tasks, so it touches one
# lock-step file without needing the other three. Exempt, not fake markers.

# --- Tests ---

test *flags:
    uv run --prerelease=allow pytest {{flags}}

test-frontend *flags:
    npm run test --prefix frontend -- {{flags}}

test-frontend-watch *flags:
    npm run test:watch --prefix frontend -- {{flags}}

test-e2e *flags:
    cd frontend && npx playwright test {{flags}}

# Pre-commit sanity for frontend work: tests + type-check + lint +
# format-check. Skips the Playwright e2e suite (slow, needs backend).
verify-frontend:
    just test-frontend
    just check-frontend
    just lint-frontend

test-all *flags:
    just test {{flags}}
    just test-frontend
    just test-e2e

# --- Dev server ---

# Run datasette with the local plugin loaded, plus the dev-only sibling
# plugins (sidebar, user-profiles, debug-gotham, llm-openrouter). Those
# live in the `dev` dependency group in pyproject.toml, which `uv run`
# installs by default — no `--with` flags needed here.
#
# Papers live in Datasette's internal DB; pass `--internal <path>` so they
# persist across restarts. No user database needs to be attached.
#
# Only `create` is granted globally (listing is ungated) — `view` and `edit`
# are resolved per-paper by datasette-acl grants on the doc. Granting
# `view`/`edit` globally would bypass the share-role gating and let everyone
# edit anyone's paper. (The e2e config grants view+edit because playwright runs
# as anonymous and exercises only the read-only path.)
dev *flags:
    DATASETTE_SECRET=abc123 uv run --prerelease=allow \
        datasette \
            --internal {{INTERNAL_DEV_DB}} \
            --plugins-dir tests/sample-plugin \
            -s permissions.datasette-paper-create true \
            -s permissions.datasette-sidebar-access true \
            -s permissions.profile_access true \
            -s settings.max_post_body_bytes 13631488 \
            {{flags}}

# The dev server with OpenTelemetry export to a local Jaeger, via the
# datasette-otel-otlp plugin (sibling checkout, unreleased — pulled in
# with `--with` so it never touches the runtime deps or the test env,
# where its import-time TracerProvider would fight the test fixtures).
# No `opentelemetry-instrument`, no OTEL_* env vars: the plugin's whole
# point is that one `-s plugins.datasette-otel-otlp.endpoint` flag.
#
# Flow: `just jaeger` in one terminal, `just dev-otel` in another, then
# open a doc and type — the POST /events trace (paper.events.submit →
# write_lock.wait / validate_steps / db.query with
# `datasette.callback: insert_steps` / broadcast / reindex ×3) shows up
# at http://localhost:16686 under service "datasette-paper".
#
# Traces only: the plugin installs a TracerProvider, not a MeterProvider,
# and Jaeger ingests traces only — paper's paper.* metrics stay no-op
# here. To collect metrics too, run under `opentelemetry-instrument` with
# an OTLP metrics backend instead (see docs/TELEMETRY.md).
dev-otel *flags:
    DATASETTE_SECRET=abc123 uv run --prerelease=allow \
        --with ../datasette-otel-otlp \
        --with ../datasette-sidebar \
        --with ../datasette-user-profiles \
        --with ../datasette-debug-gotham \
        --with llm-openrouter \
        datasette \
            --internal {{INTERNAL_DEV_DB}} \
            --plugins-dir tests/sample-plugin \
            -s plugins.datasette-otel-otlp.endpoint http://localhost:4318 \
            -s plugins.datasette-otel-otlp.service_name datasette-paper \
            -s permissions.datasette-paper-create true \
            -s permissions.datasette-sidebar-access true \
            -s permissions.profile_access true \
            -s settings.max_post_body_bytes 13631488 \
            {{flags}}

# Jaeger from its own binary — no Docker. UI on http://localhost:16686
jaeger:
    @command -v jaeger >/dev/null || { echo "No jaeger binary on PATH. Grab one from https://www.jaegertracing.io/download/"; exit 1; }
    @echo "UI: http://localhost:16686 — the OTLP ingest port :4318 has no UI"
    jaeger

dev-with-hmr *flags:
    watchexec \
        --stop-signal SIGKILL \
        -e py,html \
        --ignore '*.db' \
        --restart \
        --clear -- \
        just dev \
            -s plugins.datasette-vite.dev_paths.datasette_paper "http://localhost:{{DEV_PORT}}/-/static-plugins/datasette_paper/" \
            {{flags}}

# Wipe the dev internal DB. Useful when iterating on schema during
# development (migrations are append-only in production).
clean-dev-db:
    rm -f {{INTERNAL_DEV_DB}}
