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

- [ ] `bun run typecheck` and `bun test source/` still pass (no code regressions).
- [ ] `Dockerfile` and `.dockerignore` exist and are consistent with the no-dependencies design.
- [ ] `docs/deployment.md` documents the recommended container flags, API-key handling, volume mounts (project at `/workspace`, Guild read-only, `data/` writable), task submission via API/UI, and the `run_shell`/isolation caveat (per-run isolation is step 16's layer inside this container).

## End-of-step evaluation

Confirm the Dockerfile does not add dependencies or an install step. Ensure `docs/deployment.md` is auditable by a reviewer who is not the author. Re-read `docs/security.md` and confirm deployment docs are consistent with the threat model.

## Estimated effort

Small to medium — mostly configuration and documentation.

## Operator handoff

Build and run the image **outside this environment** (Docker is not available here):
```
docker build -t adaptive-orchestrator .
docker run --rm -p 8080:8080 -v "$PWD/guild:/guild:ro" -v "$PWD/data:/data" \
  -v "$PWD/benchmarks/hello_001:/workspace" \
  -e ORCHESTRATOR_API_KEY=... adaptive-orchestrator
```
Then submit a task via the UI (`http://localhost:8080`) or `curl -X POST http://localhost:8080/api/runs -d '{"task":"Write a file called output.txt containing the text hello world"}'`. Confirm: the image builds small (no install step); the web UI is reachable; a smoke run completes; the server stays up after the run completes (long-lived service, not one-shot). Report the image size and any build/runtime errors; the agent fixes in-environment. Also confirm the container runs as non-root and that a `--read-only` run succeeds with only `data/` (and the mounted `/workspace`) writable.
