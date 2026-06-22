# Step 15 — Dockerfile + deployment docs

## Goal

Package the system as a single small Docker image that runs the long-running executor service (step 13) as PID 1, and document secure deployment. (Per-run benchmark isolation and `run_shell` containment are handled by step 16; this step packages the deployment container that hosts the executor service and, in deployment, the per-run isolation layer.)

## Context

Read `docs/security.md` ("Container and network isolation", "Shell tool policy"), [`13-long-running-service-mode.md`](13-long-running-service-mode.md) (the service the image runs), [`16-environment-isolation.md`](16-environment-isolation.md) (per-run isolation, the layer inside this container), and [`17-run-shell-tool.md`](17-run-shell-tool.md) (`run_shell` ships only after step 16 lands). The image uses the official Bun base image, copies the project, and runs the executor service — no `npm install` because there are no dependencies. Recommended container flags: no network egress for the executor (except the model endpoint), non-root user, read-only filesystem except the workspace volume.

The deployment model (from the realignment): **one container = one project.** The project (git repository) is mounted into the container at the fixed `/workspace` path at run time; the executor service inside treats `/workspace` as its fixed workspace (step 13), so the `CMD` carries no `--task` and no `--workspace` — tasks are submitted at runtime via the service API (`POST /api/runs`) or the web UI.

## Deliverables

1. `Dockerfile` — official Bun base image, copy the project, default command runs the long-running service on a configurable port (`ENV PORT=8080`, `EXPOSE 8080`, `CMD ["bun","source/main.ts","--serve","$PORT","--human-backend","web"]`). No `--task` and no `--workspace` — the project is mounted at `/workspace` and tasks are submitted via the API/UI at runtime. No install step. Run as a non-root user.
2. `.dockerignore` — exclude `node_modules/`, `data/`, `.git/`, and plan/docs where appropriate to keep the image small.
3. `docs/deployment.md` — deployment guidance:
   - Recommended `docker run` flags: restricted network (the model endpoint must be reachable; all other egress denied), `--read-only` filesystem with a writable volume mounted at `data/` and the project mounted read-write at `/workspace`, `--user` non-root, optional `--cap-drop ALL` / seccomp.
   - How to pass API keys via environment variables (never in the Guild or image).
   - How to mount the Guild (read-only) and the project (read-write at `/workspace`) as volumes.
   - How tasks are submitted (web UI at the exposed port, or `POST /api/runs { task }`) — no `--task` CLI flag in the service `CMD`.
   - The explicit note that v1's `run_shell` (step 17) runs arbitrary commands inside the per-run isolated workspace (step 16); the container boundary (this step) is the outer isolation layer, with step 16 providing per-run containment inside it. Document an optional future in-tool allowlist as a deferred defense-in-depth enhancement (and, if concrete, insert a follow-up step).
4. Update `docs/architecture.md`'s execution-model note ("Single Dockerfile for the final product") to reference the new `Dockerfile` and `docs/deployment.md`, and to describe the one-container-per-project deployment model.
5. The `run_shell` containment debt is owned by step 16 (environment isolation), not this step; do not remove a debt row here. Confirm the deployment docs are consistent with step 16's per-run isolation running inside this container.

## Module boundaries

- The Dockerfile and `.dockerignore` are build configuration.
- `docs/deployment.md` is documentation.
- No executor code changes expected (unless a small port/env wiring fix surfaces during build).

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` still pass (no code regressions).
- [x] `Dockerfile` and `.dockerignore` exist and are consistent with the no-dependencies design.
- [x] `docs/deployment.md` documents the recommended container flags, API-key handling, volume mounts (project at `/workspace`, Guild read-only, `data/` writable), task submission via API/UI, and the `run_shell`/isolation caveat (per-run isolation is step 16's layer inside this container).

## End-of-step evaluation

Confirmed the Dockerfile adds no dependencies and no install step (only `oven/bun:1-debian` + `COPY` + a non-root-user `RUN`). `docs/deployment.md` is structured so a reviewer who is not the author can follow build → run → hardening without tribal knowledge. Re-read `docs/security.md` ("Container and network isolation", "Shell tool policy") and confirmed the deployment docs implement those mitigations (non-root, restricted egress, read-only fs, confined writes). The `run_shell` containment debt row in `plan/README.md` is left intact — it is owned by step 16, not this step; `docs/deployment.md` describes this container as the outer isolation layer with step 16's per-run isolation running inside it.

## Estimated effort

Small to medium — mostly configuration and documentation.

## Operator handoff

Build and run the image **outside this environment** (Docker is not available here):
```
docker build -t adaptive-orchestrator .
docker run --rm -p 8080:80 -v orchestrator-data:/data \
  -v "$PWD/benchmarks/hello_001:/workspace" \
  -e ORCHESTRATOR_API_KEY=... adaptive-orchestrator
```
Then submit a task via the UI (`http://localhost:8080`) or `curl -X POST http://localhost:8080/api/runs -d '{"task":"Write a file called output.txt containing the text hello world"}'`. Confirm: the image builds small (no install step); the web UI is reachable; a smoke run completes; the server stays up after the run completes (long-lived service, not one-shot). Report the image size and any build/runtime errors; the agent fixes in-environment. Also confirm the container runs as non-root and that a `--read-only --cap-drop ALL --cap-add NET_BIND_SERVICE` run succeeds with only `data/` (and the mounted `/workspace`) writable.

## Closeout (2026-06-22)

In-environment work complete; Docker build/run is operator handoff (Docker is not available in this environment). `bun run typecheck` is clean and `bun test source/` passes (368 tests across 31 files).

Delivered:

- `Dockerfile` — `FROM oven/bun:1.3.14-debian@sha256:431b37ce1acfed987e4f5b6c86a9f210ff63285a912fc5f21e18aeac0cb067ef` (official Bun image, Debian variant, pinned by manifest-index digest verified via the Docker Hub API; the base image is the only third-party artifact the build fetches, so its digest is the supply-chain boundary). `WORKDIR /app`. Explicit `COPY` of the four paths the runtime and build-time checks need: `source/`, `guild/`, `package.json`, `bun.lock`, `tsconfig.json` (an allowlist, not a `COPY .` + `.dockerignore` blacklist). `COPY --chown=orchestrator:orchestrator` so files are orchestrator-owned at copy time. A `RUN` HEREDOC creates a non-root `orchestrator` user with a fixed `uid:gid` of `1000:1000` (`groupadd`/`useradd`; the minimal Debian image ships the `passwd`/`shadow` tools, not the `adduser`/`addgroup` perl wrappers) and the `/workspace` mount point. `USER orchestrator`. The build `RUN` runs `bun install --frozen-lockfile`, `bun run typecheck`, `bun test --randomize --concurrent source/`, `rm -rf node_modules` in a single `set -e` HEREDOC, with `--mount=type=cache,target=/tmp/.bun/install/cache,uid=1000,gid=1000` persisting Bun's install cache across builds without landing it in the image, and `export HOME=/tmp` scoped to that RUN (Bun's cache lives at `$HOME/.bun/install/cache` and the account has no home). `EXPOSE 80`. `VOLUME /workspace` declares the single path operators must mount (the project, which the executor modifies in place; run bookkeeping goes under `/workspace/.orchestration/`). `ENTRYPOINT ["bun","source/serve.ts"]` — exec-form JSON, no shell, so `bun` is PID 1 directly and receives `SIGTERM`/`SIGINT` with no signal-forwarding gap. The `Dockerfile` sets no `ENV`: all configuration lives in `source/serve.ts` with production defaults, so the image runs with an empty environment.
- `.dockerignore` — removed. The `Dockerfile` uses an explicit `COPY` allowlist instead (see the `Dockerfile` entry above).
- `source/serve.ts` (renamed from `source/main.ts`) — the server entry point, now env-only and serve-only. Reads `PORT` (default `80`), `WORKSPACE_ROOT` (default `/workspace`), and `ORCHESTRATOR_API_KEY` (optional) from `Bun.env`. The guild path is hardcoded `guild` (resolved relative to the working directory: `/app` in the image, the repo root in development) — its location is an implementation detail, not a deployment variable. The runs base dir is derived as `<WORKSPACE_ROOT>/.orchestration/runs` so the operator mounts a single volume; `RUNS_BASE_DIR` is no longer a separate env var. Removed the one-shot `run()` path, the `--task` bootstrap, and all CLI flag handling. Per the testing policy this integration shell is not unit-tested.
- `source/main-args.ts` and `source/main-args.test.ts` — deleted. CLI argument parsing is gone; configuration is environment-only.
- `source/executor/executor.ts` — removed `copyWorkspace` and `snapshotWorkspace` from `ExecutorDependencies` and their calls in `runExecutor`. The executor now modifies the workspace in place; the copy/snapshot machinery was the old "copy to per-run dir" model.
- `source/executor/persistence.ts` — removed `createCopyWorkspace`, `createSnapshotWorkspace`, and their `CopyWorkspace`/`SnapshotWorkspace` types. `copyRecursively` kept (the Foundry's `branches.ts` uses it). The remaining factories (`createRunDirectory`, `createAppendLog`, `createWriteMeta`, `createReadRunSnapshotById`, `createListRunIds`) are unchanged.
- `source/executor/human-backend.ts` — removed the `stub` backend, the `stubBackend` constant, `createHumanBackend`, and `HumanBackendConfig`. The web backend is the only backend (`createWebHumanBackend`); the stub/foundry/backend-config surface was unnecessary. `human-backend.test.ts` updated to drop the stub tests. `executor/index.ts` exports updated.
- `source/executor/executor.test.ts` — dropped the `copyWorkspace`/`snapshotWorkspace` fakes and their assertions (no longer in `ExecutorDependencies`).
- `source/executor/integration.test.ts` — restructured for the in-place model: copies the benchmark to a temp dir, runs the executor with that temp dir as the workspace, asserts `output.txt` materialized in place in the temp dir, and checks run artifacts under `<temp>/.orchestration/runs/<run-id>/`. This mirrors how the Foundry will hand the executor a throwaway copy of each benchmark.
- `CONTRIBUTING.md` (new) — holds the development setup (`bun install`/`typecheck`/`test`, smoke benchmark, architecture summary, design-doc index, plan pointer) moved out of `README.md` so `README.md` is user-facing only.
- `README.md` — rewritten user-facing and Docker-only: build, run (single `-v "$PWD/my-project:/workspace"` mount, read-write since the executor modifies the project in place), configuration table (3 env vars; `RUNS_BASE_DIR` gone), API surface, pointer to `docs/deployment.md` and `CONTRIBUTING.md`. Removed the host-run `bun source/serve.ts` instructions and the local-dev env-var override example.
- `docs/deployment.md` — rewritten: single `/workspace` mount (read-write), `.orchestration/` layout, `/data` removed, `RUNS_BASE_DIR` removed from the config table, hardening recipe (`--read-only` + `tmpfs /tmp` + `--cap-drop ALL --cap-add NET_BIND_SERVICE`), file-ownership for the in-place model, `run_shell`/isolation caveat.
- `docs/architecture.md` — "Data flow: a single run" rewritten for in-place workspace; "Single Dockerfile" note updated (build gates, single `/workspace` mount, in-place modification).
- `docs/executor.md` — run lifecycle and persistence sections rewritten for in-place workspace (no copy step; `<workspace>/.orchestration/runs/<run-id>/meta.json` + `log.jsonl`).
- `docs/security.md` — "Per-run workspace isolation" rewritten as "Workspace isolation" for the in-place model; container-isolation and file-traversal references updated to the single mounted workspace.
- `docs/benchmarks.md` and `docs/guild.md` — stale `data/runs/<run_id>/workspace/` references updated to the in-place model.
- `benchmarks/README.md` — single-benchmark instructions rewritten as `docker run` with a throwaway copy mounted at `/workspace` (read-write), `curl` submit, validation via a throwaway container mounting the same dir.

Deviations from the plan wording (authoritative):

- **The executor modifies the workspace in place; the per-run copy and snapshot are gone.** The plan's run-lifecycle step 1 ("copies the workspace into `data/runs/<run_id>/workspace/`") is superseded. Operator direction: the executor is a tool for working on code in a specific folder, so it should modify that folder directly — writing the work somewhere else would be confusing. The Foundry protects its benchmarks by handing the executor a throwaway copy. `createCopyWorkspace`, `createSnapshotWorkspace`, and their types are removed from `persistence.ts`; `copyWorkspace`/`snapshotWorkspace` are removed from `ExecutorDependencies` and `runExecutor`. The `workspace.snapshot` directory was dead code anyway (nothing read it — `ReadRunSnapshotById` only returns `meta.json`+`log.jsonl`).
- **Run bookkeeping moves to `<workspace>/.orchestration/runs/`.** The plan's `data/runs/` is superseded. With the executor operating in place on the single mounted volume, run artifacts (meta/log) live alongside the project under `.orchestration/`, so the operator mounts a single writable volume and everything the orchestrator produces is co-located with the project. `RUNS_BASE_DIR` is no longer a separate env var; `serve.ts` derives it as `<WORKSPACE_ROOT>/.orchestration/runs`.
- **The Dockerfile declares `VOLUME /workspace` only (no `/data`).** The plan's two-mount model (`/workspace` project + `/data` runs) is superseded by the single-mount in-place model.
- **`CONTRIBUTING.md` created; `README.md` is user-facing only.** The plan put dev setup in `README.md`. Operator direction: `README.md` is for users; developer docs moved to `CONTRIBUTING.md`. `README.md` now assumes the user is always working with the Docker image.
- **Env-only configuration; no CLI flags at all.** The plan (and the first revisions of this step) kept CLI flags (`--serve`, `--guild`, `--human-backend`, `--workspace-root`, `--task`, `--run-id`) and threaded `PORT` from `ENV` through a shell-form entrypoint. Operator feedback refactored this to environment-only: every option has a production default in `source/serve.ts`, the `Dockerfile` sets no `ENV` and uses `ENTRYPOINT ["bun","source/serve.ts"]`, and there is no shell in the PID 1 chain. This removed the need for the shell-form/`exec`/`JSONArgsRecommended` workaround entirely — `bun` is PID 1 directly.
- **One-shot run mode removed; entry point renamed `main.ts` → `serve.ts`.** The plan's `main.ts` had two modes (serve and one-shot). Operator direction: the entry point is the server entry point, so it is renamed `serve.ts` and one-shot mode is removed. The Foundry's `run-suite` uses its own `StartRun` and never called `main.ts`, so nothing in the suite breaks.
- **Stub human backend and backend config removed.** The `stub` backend (canned `ask_human` reply) and the `HumanBackendConfig`/`createHumanBackend` dispatch existed only to give the one-shot CLI a non-interactive backend. With one-shot gone, the web backend is the only backend. `foundry` was already a non-functional placeholder.
- **Guild location is not configurable.** The plan made `--guild` a required flag. Operator feedback: the guild is bundled into the image, so its location is an implementation detail. It is hardcoded `guild` (relative to the working directory) and not overridable; operators who want a different guild mount it read-only at `/app/guild` (where `COPY` places it under `WORKDIR /app`).
- **The base image is pinned by digest at a specific patch (`1.3.14-debian@sha256:...`).** The plan said only "official Bun base image." Pinning the manifest-index digest makes the build reproducible and supply-chain-resilient: a re-pull of the tag cannot substitute a different image. Bumping to a newer patch is a deliberate edit to the version and digest together.
- **Port 80 default, in the script not the Dockerfile.** The service listens on port 80 by default (set in `source/serve.ts`, not `ENV PORT=80`); the host publishes it wherever with `-p <host>:80`. Binding to port 80 (< 1024) as a non-root process requires `CAP_NET_BIND_SERVICE`, which Docker's default cap set includes, so the minimal run works without extra flags. The hardened `--cap-drop ALL` recipe must add it back (`--cap-add NET_BIND_SERVICE`), documented in `docs/deployment.md`.
- **The build runs typecheck and tests; `node_modules` is removed in the same `RUN`.** The build-stage `RUN` runs `bun install --frozen-lockfile`, `bun run typecheck`, `bun test source/`, then `rm -rf node_modules` in a single `set -e` HEREDOC. A failed typecheck or test fails the build; the image that ships has passed both. `rm -rf node_modules` in the same layer means the production image's filesystem has no `node_modules`.
- **`HOME` scoped to the build `RUN`; `--mount=type=cache` for Bun's install cache.** `export HOME=/tmp` is inside the build heredoc, not `ENV HOME` image-wide (nothing in `source/` reads `HOME` at runtime; the per-run workspace is the cwd for all subprocesses). `--mount=type=cache,target=/tmp/.bun/install/cache,uid=1000,gid=1000` persists Bun's install cache across builds without landing it in the image. This required fixing the orchestrator user's uid/gid to `1000:1000` so the non-root user can write to the cache mount.
- **`groupadd`/`useradd`, not `addgroup`/`adduser`.** The initial `Dockerfile` used `addgroup`/`adduser`, which failed at build time with `addgroup: not found`: the oven/bun Debian image is minimal and ships the low-level `passwd`/`shadow` tools (`groupadd`/`useradd`) but not the `adduser`/`addgroup` perl wrappers. Switched to `groupadd`/`useradd`. `docs/deployment.md`'s base-image rationale records this so a future reader does not regress to the wrapper commands.

The `run_shell` containment debt row in `plan/README.md` is intentionally left in place; step 16 owns its removal. No new technical debt introduced.
