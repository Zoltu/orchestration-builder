# Step 13 — Long-running service mode (backend)

## Goal

Turn the executor from a one-run-per-process invocation into a long-running HTTP service backend: one task at a time per container, no queue, task submission via a JSON API. This is the deployment substrate the Docker image (step 15) runs as PID 1, and the API the Foundry (steps 23+) submits runs to. It fixes the server-side halves of the step-12 tracked debt (instant teardown on run completion; `SIGTERM` unhandled). The multi-run web UI rewrite is step 14; this step keeps the existing UI functional via a backward-compatible `GET /api/run` alias.

## Context

Read [`12-main-serve-wiring.md`](12-main-serve-wiring.md) (the transitional `--serve` shape this step supersedes — note its tracked debt), [`10-web-human-backend.md`](10-web-human-backend.md) and [`11-web-ui-server.md`](11-web-ui-server.md) (the per-run backend + server), and `docs/executor.md` ("Web UI", "Sequential scheduling").

Product constraints (from the realignment):

- **One container = one project.** The project (git repository) is mounted into the container at a fixed path (`/workspace`) at deploy/run time. The service does not receive a workspace path per task — the workspace is fixed for the life of the container.
- **One task at a time, no queue.** If a task is running and another is submitted, the API rejects it. (Future parallelism is out of scope; the design must not preclude it, but it is not built.)
- **Long-lived.** The process runs indefinitely as PID 1. `SIGINT`/`SIGTERM` (the latter is what `docker stop` sends) trigger graceful shutdown: stop accepting new tasks, let the active run finish or be interrupted per the run-interrupt channel (step 19), then exit.
- **Foundry is a client.** The same JSON API the UI uses is the API the Foundry (step 26) submits runs through. No bespoke executor coupling.

The step-12 bugs this step removes: (a) the server is torn down the instant `runExecutor` resolves, so a fast run leaves the UI stuck; (b) only `SIGINT` is handled, not the `SIGTERM` `docker stop` sends. The third step-12 bug — `app.js` swallows fetch errors silently, leaving the page at `loading…` when the server is unreachable — is a client-side concern and is fixed in step 14's UI rewrite; this step does not touch `app.js`.

## Deliverables

1. `source/main-args.ts` (extend) — in serve mode, `--workspace` is no longer a submission flag (the workspace is fixed at `/workspace`); `--task` becomes optional at startup (a task may be submitted later via the API, but `--task` at startup still bootstraps the first run for backward compatibility with the step-12 smoke-test path). Add `--workspace-root <path>` (optional, defaults to `/workspace`) so serve mode knows the fixed project mount. Update `usage()` and the arg tests. The pure parser stays pure.
2. `source/executor/run-state.ts` (extend) / a new per-run state holder — today `WebHumanBackend`, `RunState`, and `readRunSnapshot` close over a single run id. Lift them to be keyed by the active run id so the server can serve the one active run and future runs without re-deriving closures. Keep the single-run invariant (at most one active run) enforced at the submission layer, not inside the backend.
3. `source/web/server.ts` (extend) — add `POST /api/runs` (body: `{ task }`) that starts a run against the fixed workspace; returns `{ runId }` or `409 { ok: false, error: 'run_in_progress' }` when a run is active. Add `GET /api/runs/:id` returning the run view for a specific run. Add `GET /api/runs` listing known runs (read from `data/runs/`). Keep the existing `GET /api/run` as an active-run convenience alias so the step-12 UI keeps working until step 14 rewrites it. Reject a second `POST /api/runs` while a run is active.
4. `source/main.ts` (extend) — in serve mode, start the server, then block on a shutdown promise resolved by `SIGINT`/`SIGTERM`. Do **not** stop the server when a run completes; the server outlives every run. On shutdown signal: stop accepting new submissions, await the active run (or interrupt it via the step-19 channel if available; until step 19 lands, await completion), stop the server, exit with the active run's status code if one was in flight (mid-run interrupt → `130`; idle shutdown → `0`). The error path (server bind failure, fatal run error) still tears down and exits non-zero.
5. `source/web/server.test.ts` (extend) — cover `POST /api/runs` (accepted → returns runId; second submit while active → `409`), `GET /api/runs/:id`, `GET /api/runs` list, and the `GET /api/run` alias still returning the active run.
6. `README.md` — replace the step-12 "Web UI (human-in-the-loop)" subsection: serve mode is now the long-running service; document `POST /api/runs` for programmatic submission (Foundry-facing) and the one-task-at-a-time contract.

## Module boundaries

- `main.ts` is the only place assembling the service (server + backend + run submission). It holds no run logic.
- `server.ts` is a thin HTTP leaf; run-state and snapshot reading are injected.
- The submission→execution boundary is a small orchestration function (start run, track active run, reject while active) that is testable with a fake executor. The `runExecutor` call itself stays a leaf-wrapper dependency.
- This step does not modify `source/web/static/app.js` or `source/web/static/index.html` — the multi-run UI is step 14.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including extended server tests and arg tests.
- [ ] `POST /api/runs { task }` starts a run and returns its id; a second submit while a run is active returns `409 run_in_progress`.
- [ ] `GET /api/runs/:id` and `GET /api/runs` return the correct shapes.
- [ ] `GET /api/run` still returns the active run (backward-compat alias; the step-12 UI keeps working).
- [ ] The server stays up after a run completes; a completed run's view is still reachable.
- [ ] `SIGTERM` triggers graceful shutdown (testable via the shutdown-promise seam if exposed, or documented as operator-verified).
- [ ] The step-12 tracked-debt row is updated in `plan/README.md` to record that the server-side parts (teardown, `SIGTERM`) are removed here; the client-side part (dead-server UX) is removed in step 14.

## Tracked technical debt

- **Removes the server-side parts of** the step-12 debt: "server torn down on run completion" and "`SIGTERM` unhandled." After this step the server is long-lived and handles both `SIGINT` and `SIGTERM`. The third part of the step-12 debt (dead-server UX: `app.js` swallows fetch errors, leaving the page at `loading…`) is a client-side concern removed in step 14's UI rewrite; the debt row stays in `plan/README.md` until step 14 lands.

## End-of-step evaluation

Confirm `main.ts` did not acquire run logic — it assembles the service and wires signals only. Confirm the one-task-at-a-time invariant is enforced at the submission layer (a pure decision: "is a run active?"), not scattered through the server. Confirm `--task` at startup still works as a bootstrap (submit the first run immediately) for backward compatibility with the step-12 smoke-test path. Confirm `app.js` and `index.html` were not modified (the UI rewrite is step 14).

## Estimated effort

Medium — the run-state lifting, the new API surface, and the signal-driven lifecycle are each non-trivial but cohesive (all TypeScript, all tested). The UI rewrite — a different kind of work (plain browser JS, untested) — is split out to step 14 so this step stays session-sized.

## Operator handoff

Run the service and exercise the API: `bun source/main.ts --serve 8080 --guild guild` (workspace defaults to `/workspace`; for local testing mount or symlink a project there, or pass `--workspace-root benchmarks/hello_001`). Open `http://localhost:8080` — the step-12 UI should still render the active run via the `GET /api/run` alias. Submit a task via `curl -X POST http://localhost:8080/api/runs -d '{"task":"..."}'`, confirm the run completes and the server stays up (no teardown). Submit a second task while the first is running and confirm a `409`. Send `SIGTERM` (`kill -TERM <pid>`) and confirm graceful shutdown. Report any plumbing bugs; the agent fixes them in-environment. (The full multi-run UI — run list, create form, switching — lands in step 14; do not judge the UI here.)
