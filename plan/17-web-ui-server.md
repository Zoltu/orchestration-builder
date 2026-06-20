# Step 17 — Web UI server + static assets

## Goal

Add a plain HTML/JS web UI served by `Bun.serve` that displays the active run, tails `log.jsonl`, and lets the operator answer pending `ask_human` questions. No external dependencies; no build step.

## Context

Read `docs/executor.md` ("Web UI") and [`16-web-human-backend.md`](16-web-human-backend.md) (the backend state machine is in place). The server is a leaf factory `createWebServer(port)`; it reads run state to render the UI and posts answers back to the step-16 backend. Static assets are plain files under `source/web/static/`.

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

None for code. A live UI test against a real run is part of step 18's handoff.
