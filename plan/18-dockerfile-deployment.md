# Step 18 — Dockerfile + deployment docs

## Goal

Package the system as a single small Docker image and document secure deployment. This step also closes the `run_shell` safety debt tracked from step 04 (no shell allowlist in v1) by documenting that strong isolation comes from the container, not the executor.

## Context

Read `docs/security.md` ("Container and network isolation", "Shell tool policy") and [`04-run-shell-tool.md`](04-run-shell-tool.md) (tracked debt: no shell allowlist in v1). The image uses the official Bun base image, copies the project, and runs the executor — no `npm install` because there are no dependencies. Recommended container flags: no network egress for the executor, non-root user, read-only filesystem except the workspace volume.

## Deliverables

1. `Dockerfile` — official Bun base image, copy the project, default command surfaces the web UI on a configurable port (`ENV PORT=8080`, `EXPOSE 8080`, `CMD ["bun","source/main.ts","--serve","$PORT","--human-backend","web"]`). No install step. Run as a non-root user.
2. `.dockerignore` — exclude `node_modules/`, `data/`, `.git/`, and plan/docs where appropriate to keep the image small.
3. `docs/deployment.md` — deployment guidance:
   - Recommended `docker run` flags: `--network none` (or a restricted network) for the executor process, `--read-only` filesystem with a writable volume mounted at `data/`, `--user` non-root, optional `--cap-drop ALL` / seccomp.
   - How to pass API keys via environment variables (never in the Guild or image).
   - How to mount a Guild and benchmark workspace as volumes.
   - The explicit note that v1 has **no shell allowlist**: `run_shell` runs arbitrary commands inside the workspace; the container boundary is the primary isolation. Document an optional future allowlist as a deferred enhancement (and, if concrete, insert a follow-up step).
4. Update `docs/architecture.md`'s execution-model note ("Single Dockerfile for the final product") to reference the new `Dockerfile` and `docs/deployment.md`.
5. Remove the step-04 tracked-debt row from [`README.md`](README.md#tracked-technical-debt) once the documentation lands (the debt was "no allowlist"; the resolution is documented container isolation + an optional future allowlist step).

## Module boundaries

- The Dockerfile and `.dockerignore` are build configuration.
- `docs/deployment.md` is documentation.
- No executor code changes expected (unless a small port/env wiring fix surfaces during build).

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` still pass (no code regressions).
- [ ] `Dockerfile` and `.dockerignore` exist and are consistent with the no-dependencies design.
- [ ] `docs/deployment.md` documents the recommended container flags, API-key handling, volume mounts, and the v1 shell-isolation caveat.
- [ ] The step-04 tracked-debt row is resolved in `README.md`.

## End-of-step evaluation

Confirm the Dockerfile does not add dependencies or an install step. Ensure `docs/deployment.md` is auditable by a reviewer who is not the author. Re-read `docs/security.md` and confirm deployment docs are consistent with the threat model.

## Estimated effort

Small to medium — mostly configuration and documentation.

## Operator handoff

Build and run the image **outside this environment** (Docker is not available here):
```
docker build -t adaptive-orchestrator .
docker run --rm -p 8080:8080 -v "$PWD/guild:/guild:ro" -v "$PWD/data:/data" \
  -e ORCHESTRATOR_API_KEY=... adaptive-orchestrator \
  bun source/main.ts --serve 8080 --human-backend web --guild /guild --workspace /benchmarks/hello_001 --task "..."
```
Confirm: the image builds small (no install step); the web UI is reachable; a smoke run completes. Report the image size and any build/runtime errors; the agent fixes in-environment. Also confirm the container runs as non-root and that a `--read-only` run succeeds with only `data/` writable.
