# Step 11 — Web UI server + static assets

## Goal

Add a plain HTML/JS web UI served by `Bun.serve` that displays the active run, tails `log.jsonl`, and lets the operator answer pending `ask_human` questions. No external dependencies; no build step.

## Context

Read `docs/executor.md` ("Web UI") and [`10-web-human-backend.md`](10-web-human-backend.md) (the backend state machine is in place). The server is a leaf factory `createWebServer(port)`; it reads run state to render the UI and posts answers back to the step-10 backend. Static assets are plain files under `source/web/static/`.

## Deliverables

1. `source/web/server.ts` — leaf factory `createWebServer({ port, runState, humanBackend })` using `Bun.serve`. Routes: `GET /` (HTML), `GET /app.js`, `GET /styles.css`, `GET /api/run` (run status + role tree + recent log lines), `GET /api/questions` (pending `ask_human` questions), `POST /api/answer` (submit an answer). SSE or short polling for live updates.
2. `source/web/static/index.html`, `source/web/static/app.js`, `source/web/static/styles.css` — minimal, dependency-free client. Displays current role/status, a tailed log view, and pending questions with an answer input.
3. `source/web/render.ts` — pure helpers that turn run state into the JSON the API returns (testable). Keep HTML construction in static files; the server returns JSON, the client renders.
4. `source/web/render.test.ts` — in-memory tests for the JSON shaping (status, role tree, recent-log truncation, pending-question list).
5. `source/web/server.test.ts` — in-memory test using `fetch` against the started server on an ephemeral port (Bun supports this) to assert: `GET /` returns HTML; `GET /api/questions` returns the pending list; `POST /api/answer` resolves the pending question in the step-16 backend. Clean up the server in `afterAll`.

## Module boundaries

- `server.ts` is a leaf (HTTP). Thin.
- `render.ts` is pure (tested).
- Static assets are plain files; no templating engine.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including server tests on an ephemeral port.
- [ ] The server returns HTML/JS/CSS and the JSON API.
- [ ] Submitting an answer via `POST /api/answer` resolves the pending `ask_human` question in the backend.
- [ ] No external dependencies; assets are plain files.

## End-of-step evaluation

Confirm the server is thin (routing + delegating to `render.ts` and the backend). Ensure untrusted run content (log lines, summaries) is JSON-encoded (no HTML injection via the JSON API; the client must escape when injecting into the DOM — verify `app.js` uses `textContent`/escaping). Confirm the server test cleans up the port.

## Estimated effort

Medium — UI is intentionally simple; the plumbing is the work.

## Operator handoff

None for code. A live UI test against a real run is part of step 12's handoff.

## Closeout (complete)

Delivered:

- `source/web/render.ts` — pure helpers: `parseLogEvents` (tolerant JSONL tail parsing), `parseRunSnapshot` (raw text → `{ meta, logEvents }`), `deriveRoleActivity` (per-role summary from log events), `renderRunView` (status + role activity + truncated recent log), and `renderPendingQuestions` (stable API shape with `context` omitted when undefined).
- `source/web/render.test.ts` — in-memory coverage of log parsing (valid, malformed-line-skip, bad-shape-skip, empty), snapshot parsing (present/absent/malformed meta), role-activity derivation (counts, first/last seen, distinct tools in first-use order, role-less events ignored), run-view shaping (completed run, in-progress `unknown` status, recent-log truncation, missing result), and pending-question shaping.
- `source/web/server.ts` — leaf factory `createWebServer({ port, runState, readRunSnapshot })` built on `Bun.serve`. Routes: `GET /` (HTML), `GET /app.js`, `GET /styles.css`, `GET /api/run`, `GET /api/questions`, `POST /api/answer`. Unknown routes return `404 { ok: false, error: 'not_found' }`. Returns `{ port, stop }`; binding failure throws.
- `source/web/static/{index.html,app.js,styles.css}` — plain, dependency-free client. Short-polls the JSON API every second; renders entirely with `createElement`/`textContent` (no `innerHTML`), so untrusted run content cannot break out of the DOM.
- `source/web/server.test.ts` — in-memory `fetch` test against the server on an ephemeral port (`port: 0`), cleaned up in `afterAll`. Covers static assets, `GET /api/run`, `GET /api/questions`, `POST /api/answer` resolving a real parked `ask_human` question end-to-end, and the 404/400 error paths.
- `source/executor/persistence.ts` extended with `createReadRunSnapshot(runId, baseDir)` — the filesystem leaf that reads `meta.json` (null while a run is in progress) and `log.jsonl` (empty when absent) as raw text. The server delegates parsing to `render.ts`, keeping the leaf thin.

Deviations / decisions (authoritative):

1. The factory signature is `createWebServer({ port, runState, readRunSnapshot })`, not the plan's `{ port, runState, humanBackend }`. `runState` already wraps the web human backend (step 10's `createRunState`), so `humanBackend` would be redundant. The plan listed the `GET /api/run` route (run status + role tree + recent log lines) but did not specify how the server obtains that data; the executor exposes no live run view, so a read leaf (`createReadRunSnapshot`) reading `meta.json` + `log.jsonl` from disk is the source, and `render.ts` derives the view purely. This keeps the HTTP leaf thin and the shaping fully testable.
2. "Role tree" is rendered as a **role activity summary** (per role: event count, LLM/tool call counts, first/last seen, distinct tools called). The executor does not persist a live parent-child role tree — `agent` tool-call log events record only the parent role and the tool name, not the spawned child role or depth, so a strict tree is not recoverable from the log. A true tree requires the executor to log agent-spawn events with parent, child, and depth; tracked in the plan README's debt table, to be removed by step 22 (executor role-tree log events). The activity summary is a faithful rendering of the data the log actually contains.
3. `meta.json` is written atomically only at run completion, so during a run `readRunSnapshot` returns `metaText: null` and the view reports `status: 'unknown'` (the UI labels this "in progress"). A present-but-malformed `meta` is treated as null (torn read mid-write) rather than crashing the UI.
4. `log.jsonl` is parsed line-by-line and lines that fail to parse or do not satisfy the `LogEvent` shape are skipped. The log is append-only and read concurrently with writes, so a partial final line is the expected failure mode and must not abort the whole tail. This is covered by tests.
5. Live updates use short polling (1s) rather than SSE. Polling keeps the server stateless per request and the client trivial; SSE would add a long-lived-connection lifecycle for no functional gain at this scope.

`bun run typecheck` and `bun test source/` pass (314 tests, +29). No `as` casts introduced. No new dependencies.
