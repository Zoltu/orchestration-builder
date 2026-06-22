# Step 13 — Long-running service mode (backend)

## Goal

Turn the executor from a one-run-per-process invocation into a long-running HTTP service backend: one task at a time per container, no queue, task submission via a JSON API. This is the deployment substrate the Docker image (step 15) runs as PID 1, and the API the Foundry (step 23) submits runs to. It fixes the server-side halves of the step-12 tracked debt (instant teardown on run completion; `SIGTERM` unhandled). The multi-run web UI rewrite is step 14; this step keeps the existing UI functional via a backward-compatible `GET /api/run` alias.

## Context

Read [`12-main-serve-wiring.md`](12-main-serve-wiring.md) (the transitional `--serve` shape this step supersedes — note its tracked debt), [`10-web-human-backend.md`](10-web-human-backend.md) and [`11-web-ui-server.md`](11-web-ui-server.md) (the per-run backend + server), and `docs/executor.md` ("Web UI", "Sequential scheduling").

Product constraints (from the realignment):

- **One container = one project.** The project (git repository) is mounted into the container at a fixed path (`/workspace`) at deploy/run time. The service does not receive a workspace path per task — the workspace is fixed for the life of the container.
- **One task at a time, no queue.** If a task is running and another is submitted, the API rejects it. (Future parallelism is out of scope; the design must not preclude it, but it is not built.)
- **Long-lived.** The process runs indefinitely as PID 1. `SIGINT`/`SIGTERM` (the latter is what `docker stop` sends) trigger graceful shutdown: stop accepting new tasks, let the active run finish or be interrupted per the run-interrupt channel (step 19), then exit.
- **Foundry is a client.** The same JSON API the UI uses is the API the Foundry (step 23) submits runs through. No bespoke executor coupling.

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

- [x] `bun run typecheck` and `bun test source/` pass, including extended server tests and arg tests.
- [x] `POST /api/runs { task }` starts a run and returns its id; a second submit while a run is active returns `409 run_in_progress`.
- [x] `GET /api/runs/:id` and `GET /api/runs` return the correct shapes.
- [x] `GET /api/run` still returns the active run (backward-compat alias; the step-12 UI keeps working).
- [x] The server stays up after a run completes; a completed run's view is still reachable.
- [x] `SIGTERM` triggers graceful shutdown (testable via the shutdown-promise seam if exposed, or documented as operator-verified).
- [x] The step-12 tracked-debt row is updated in `plan/README.md` to record that the server-side parts (teardown, `SIGTERM`) are removed here; the client-side part (dead-server UX) is removed in step 14.

## Tracked technical debt

- **Removes the server-side parts of** the step-12 debt: "server torn down on run completion" and "`SIGTERM` unhandled." After this step the server is long-lived and handles both `SIGINT` and `SIGTERM`. The third part of the step-12 debt (dead-server UX: `app.js` swallows fetch errors, leaving the page at `loading…`) is a client-side concern removed in step 14's UI rewrite; the debt row stays in `plan/README.md` until step 14 lands.

## End-of-step evaluation

Confirm `main.ts` did not acquire run logic — it assembles the service and wires signals only. Confirm the one-task-at-a-time invariant is enforced at the submission layer (a pure decision: "is a run active?"), not scattered through the server. Confirm `--task` at startup still works as a bootstrap (submit the first run immediately) for backward compatibility with the step-12 smoke-test path. Confirm `app.js` and `index.html` were not modified (the UI rewrite is step 14).

## Estimated effort

Medium — the run-state lifting, the new API surface, and the signal-driven lifecycle are each non-trivial but cohesive (all TypeScript, all tested). The UI rewrite — a different kind of work (plain browser JS, untested) — is split out to step 14 so this step stays session-sized.

## Operator handoff

Run the service and exercise the API: `bun source/main.ts --serve 8080 --guild guild` (workspace defaults to `/workspace`; for local testing mount or symlink a project there, or pass `--workspace-root benchmarks/hello_001`). Open `http://localhost:8080` — the step-12 UI should still render the active run via the `GET /api/run` alias. Submit a task via `curl -X POST http://localhost:8080/api/runs -d '{"task":"..."}'`, confirm the run completes and the server stays up (no teardown). Submit a second task while the first is running and confirm a `409`. Send `SIGTERM` (`kill -TERM <pid>`) and confirm graceful shutdown. Report any plumbing bugs; the agent fixes them in-environment. (The full multi-run UI — run list, create form, switching — lands in step 14; do not judge the UI here.)

## Closeout (2026-06-21)

Complete. `bun run typecheck` and `bun test source/` both pass (396 tests across 32 files). The arg parser adds 7 tests; the new `run-submission.ts` adds 9; `render.ts` adds 3 for `renderRunSummary`; `server.test.ts` is rewritten with self-contained per-test submission servers (+12 net) so the suite is stable under `--randomize --concurrent`.

Changed files:

- `source/executor/persistence.ts` — `createReadRunSnapshot(runId, baseDir)` (single-run, no-arg closure) replaced by `createReadRunSnapshotById(baseDir)` returning a `(runId) => RunSnapshotRaw` leaf, and a new `createListRunIds(baseDir)` leaf enumerating run directories (empty array when the base dir is absent). The single-active-run invariant is enforced at the submission layer, not here, so the snapshot reader serves any run by id.
- `source/executor/run-submission.ts` (new) — `createRunSubmission({ startRun, generateRunId })` is the testable submission→execution boundary. `submit(task)` enforces one-task-at-a-time (returns `{ ok: true, runId }` or `{ ok: false, error: 'run_in_progress' }`); `activeRunId`/`lastRunId` track the active and most-recent run; `awaitActive` lets the shutdown path drain the in-flight run; `awaitFatalError` lets the service tear down non-zero when `startRun` rejects. `startRun` is an injected leaf (built in `main.ts`), so the orchestration is fully exercisable with a fake executor.
- `source/executor/run-submission.test.ts` (new) — in-memory coverage: accept/reject-while-active, active slot clears on completion, `lastRunId` survives completion, `awaitActive` semantics, fatal-error normalization, and a contract-satisfaction fake.
- `source/executor/index.ts` — barrel re-exports `createRunSubmission`/`RunSubmission`/`StartRun`/`SubmitResult`/`RunSubmissionDependencies`, and swaps `createReadRunSnapshot`/`ReadRunSnapshot` for `createReadRunSnapshotById`/`ReadRunSnapshotById` plus `createListRunIds`/`ListRunIds`/`RunSnapshotRaw`.
- `source/web/render.ts` — `renderRunSummary(runId, snapshot)` added: a lightweight per-run summary (runId, status, task, start/end time) for the run-list endpoint, taking `runId` from the directory name because meta is null while a run is in progress.
- `source/web/render.test.ts` — coverage for `renderRunSummary` (completed run, in-progress `unknown`, missing `endTime`).
- `source/web/server.ts` — `WebServerConfig` now takes `runSubmission`, `readRunSnapshotById`, and `listRunIds` (the old no-arg `readRunSnapshot` is gone). Routes added: `POST /api/runs` (body `{ task }` → 201 `{ runId }`, or 409 `run_in_progress`), `GET /api/runs` (summaries, newest first), `GET /api/runs/:id` (full run view, 404 for an unknown id). `GET /api/run` is now an alias for the most recent run via `runSubmission.lastRunId()` (404 `no_run` when no run has ever been started), so the step-12 UI keeps working. JSON body parsing centralized in `readJsonBody`.
- `source/web/server.test.ts` — rewritten: read-only routes use a shared server; submission-mutating routes (alias, `POST /api/runs`) each build a fresh server + submission via `createSubmissionServer()` so tests are independent and stable under `--randomize --concurrent`. Covers all new routes and the 409/404/400 paths.
- `source/main-args.ts` — `workspacePath` and `task` are now optional (required only when `--serve` is absent); `--workspace-root` added as an optional value flag. `usage()` rewritten into run-mode / serve-mode / common-options groups. The required-flag check is conditional on serve mode but stays pure (a function of the parsed value map, no I/O).
- `source/main-args.test.ts` — serve-mode coverage: `--workspace`/`--task` optional, `--task` bootstrap, `--workspace-root` (space and `=` forms), missing `--guild` in serve mode reports only `--guild`, `--workspace-root` in `usage()`.
- `source/main.ts` — split into `run()` (one run per process, run mode) and `serve()` (long-running service, serve mode). `serve()` loads the guild and builds the LLM caller once, shares one `WebHumanBackend` across runs, wires `createStartRun` (a leaf that builds per-run executor dependencies and calls `runExecutor`) into `createRunSubmission`, starts the server, bootstraps the first run if `--task` is present, then blocks on `Promise.race([waitForShutdownSignal(), runSubmission.awaitFatalError()])`. On signal: captures `interrupted = activeRunId() !== undefined`, awaits the active run, stops the server, exits 130 (interrupted) or 0 (idle). On fatal run error: awaits the active run, stops the server, exits 1. Both `SIGINT` and `SIGTERM` resolve the shutdown promise. `--workspace`/`--run-id`/`--workspace-root` are cross-mode validated with fail-fast guards.
- `README.md` — flags list updated; "Web UI (human-in-the-loop)" replaced with a "Service mode" section documenting `POST /api/runs` (Foundry-facing), the one-task-at-a-time contract, the full API surface, and the `SIGINT`/`SIGTERM` graceful-shutdown exit codes.
- `plan/README.md` — the step-12 debt row updated to record that the server-side parts (teardown, `SIGTERM`) are removed here; the client-side part (dead-server UX) is removed in step 14.

Deviations from the plan wording (authoritative):

- **`createRunSubmission` exposes `awaitFatalError` and `takeFatalError`-equivalent behavior not foreseen in the plan.** The plan said "The error path (server bind failure, fatal run error) still tears down and exits non-zero," but did not specify how a fire-and-forget run's rejection surfaces to the service. Since `submit` does not await `startRun`, a rejection would otherwise become an unhandled rejection. `createRunSubmission` catches the rejection inside the active-promise's `then` (clearing the active slot and resolving `awaitActive` with `undefined`) and resolves `awaitFatalError` with the normalized error. `main.ts` races the shutdown signal against `awaitFatalError` so a fatal run error tears down the service non-zero. This keeps the fatal-error path testable without adding untested integration glue.
- **`GET /api/run` aliases the most recent run (active or last completed), not strictly the active run.** The plan said "GET /api/run still returns the active run." Strictly returning the active run would leave the step-12 UI blank the instant a run completes (the server no longer tears down). Tracking `lastRunId` separately from `activeRunId` lets the alias keep surfacing the completed run's result, which is the behavior the step-12 UI needs during the transitional period. When no run has ever been started, the alias returns 404 `no_run`.
- **The snapshot reader and run list are leaves taking only `baseDir`, not run-keyed closures.** The plan said "Lift them to be keyed by the active run id." Since the single-active-run invariant is enforced at the submission layer, the `WebHumanBackend` and `RunState` did not need lifting (one shared backend serves the one active run at a time). Only `readRunSnapshot` needed lifting — to `readRunSnapshotById(runId)` — so the server can read any run by id for `GET /api/runs/:id` and `GET /api/runs`. A new `listRunIds` leaf backs `GET /api/runs`.
- **`--workspace` is rejected (not silently ignored) in serve mode, and `--workspace-root` is rejected in run mode.** The plan said "--workspace is no longer a submission flag" without specifying the failure mode. Fail-fast cross-mode guards in `main.ts` (an integration shell, not unit-tested per the testing policy) make the mode-specific flag contract explicit and auditable rather than silently dropping a flag.

End-of-step grep check: `main.ts` imports from exactly three modules (`./main-args.js`, `./executor/index.js`, `./web/server.js`), unchanged from step 12. `main.ts` holds no run logic — `createStartRun` only builds per-run executor dependencies and delegates to `runExecutor`; the submission decision ("is a run active?") lives in `createRunSubmission`. `app.js` and `index.html` were not modified.

No new technical debt introduced.
