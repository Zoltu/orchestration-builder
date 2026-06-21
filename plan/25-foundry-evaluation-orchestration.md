# Step 25 — Foundry per-run container orchestration leaf

## Goal

Deliver the leaf that submits a single run to the executor service from the Foundry: copy the benchmark/project to a temporary location, start a dedicated container with that temp mounted at the conventional `/workspace` path, poll the service for completion, return the run record, then tear down the container and delete the temp. This is the per-run leaf; step 26 composes it into the branch-evaluation loop.

## Context

Read [`13-long-running-service-mode.md`](13-long-running-service-mode.md) (the service API this leaf talks to — `POST /api/runs`, `GET /api/runs/:id`), [`15-dockerfile-deployment.md`](15-dockerfile-deployment.md) (the container image each run lives in), and `docs/foundry.md` ("Evaluation", "Separation from the executor").

Deployment model (from the realignment):

- **One container = one project/benchmark.** Each Foundry benchmark run gets its own container so a benchmark that installs global packages or downloads tooling cannot pollute another benchmark's environment.
- **The project is mounted at `/workspace`.** The executor service inside the container treats `/workspace` as the fixed workspace (step 13), so no workspace flag is passed — the container sees the project at the conventional path.
- **Foundry parallelism = N containers.** When the Foundry runs benchmarks in parallel, it spins up N containers, one per benchmark. This leaf handles one container's lifecycle; step 26's loop decides how many to run concurrently.
- **Temp copy + teardown.** The Foundry copies the benchmark's source into a temp directory, mounts it into the container (read-write, since the run mutates the workspace), starts the container, polls the service `GET /api/runs/:id` until the run is terminal, captures the result + final workspace, then stops the container and deletes the temp. The copy is necessary so repeated runs (repetitions, multiple branches) start from a clean source.

## Deliverables

1. `source/foundry/run-submitter.ts` — leaf factory `createRunSubmitter(config)` returning `{ submitRun, awaitRunResult }`:
   - `submitRun({ benchmarkPath, task, guildPath }): { runId }` — copies `benchmarkPath` to a temp dir under `os.tmpdir()`, starts a container (`docker run` via `Bun.spawn`) with the temp dir mounted at `/workspace`, the branch Guild mounted read-only, the service port exposed locally, and the task submitted via `POST /api/runs { task }` to the container's service. Returns the run id.
   - `awaitRunResult(runId): RunRecord` — polls `GET /api/runs/:id` until the run is terminal (`success`/`error`/`needs_clarification`), then captures the final workspace (copy out of the container or read from the mounted temp), the `meta.json`, and the `log.jsonl`. Returns a `RunRecord` (status, tokens, ask count, context events, errors, wall time, runId, finalWorkspacePath).
   - Teardown: stops the container (`docker stop`) and deletes the temp dir. Teardown must run on success and on error (a `finally` around the await is appropriate here — container cleanup is a genuine resource-release concern, not control flow).
2. `source/foundry/run-submitter.test.ts` — in-memory tests with a fake container-runner (injected dependency that stubs `docker run`/`docker stop` and the HTTP polling) covering: a successful run returns the expected `RunRecord`; a failed run still tears down the container and temp; a poll that never terminates hits a configurable timeout and tears down. The real `docker` invocation is not tested (it is the leaf's external boundary); only the orchestration over the injected runner is tested.
3. The container-runner (the thing that actually spawns `docker`) is a thin leaf inside `run-submitter.ts`, not separately exported; the factory accepts an injectable runner so tests fake it and the real assembly happens in the Foundry entry point (step 29).

## Module boundaries

- `run-submitter.ts` is a leaf factory (subprocess + HTTP + filesystem). The container orchestration logic is thin; the temp-copy and teardown sequencing is the substance.
- The injected container-runner abstraction is the testability seam: the orchestration (copy → start → poll → capture → teardown) is testable with a fake runner; the real `docker` spawning is not.
- This leaf knows nothing about branches, scoring, or repetitions — that is step 26. It submits one run and returns one `RunRecord`.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the run-submitter tests with the fake runner.
- [ ] `submitRun` copies the benchmark to a temp dir, and `awaitRunResult` tears down the container and temp on both success and failure.
- [ ] A run that does not terminate hits a configurable timeout and is torn down (no leaked containers).
- [ ] The leaf does not call `runExecutor` or import the executor directly — it talks to the service over HTTP only.

## End-of-step evaluation

Confirm the temp-copy-then-mount design is sound (repeated runs do not mutate the benchmark source; the temp is always cleaned up). Confirm the timeout path kills the container before deleting the temp (order matters — a running container holding the mount cannot have its temp deleted reliably). Confirm no `as` casts. Re-read against `docs/foundry.md` to confirm the `RunRecord` shape matches what step 26's scoring expects.

## Estimated effort

Medium — the orchestration is straightforward but the container lifecycle (start, poll, teardown, timeout) has edge cases. The real `docker` path is operator-verified.

## Operator handoff

The leaf's real `docker` path cannot be exercised in-environment. Operator verifies: a real `submitRun` against a built image (step 15) starts a container, the service accepts the task, the run completes, the container stops, and the temp dir is gone. Report any container-startup failures, mount issues, or teardown leaks; the agent fixes the orchestration in-environment and re-hands off. A real end-to-end evaluation run is part of the loop in step 29.
