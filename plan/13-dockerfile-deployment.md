# Step 13 — Dockerfile + deployment docs

## Goal

Package the system as a single small Docker image and document secure deployment. (Per-run benchmark isolation and `run_shell` containment are handled by step 20; this step packages the deployment container that hosts the executor and, in deployment, the per-run isolation layer.)

## Context

Read `docs/security.md` ("Container and network isolation", "Shell tool policy"), [`20-environment-isolation.md`](20-environment-isolation.md) (per-run isolation, the layer inside this container), and [`21-run-shell-tool.md`](21-run-shell-tool.md) (`run_shell` ships only after step 20 lands). The image uses the official Bun base image, copies the project, and runs the executor — no `npm install` because there are no dependencies. Recommended container flags: no network egress for the executor, non-root user, read-only filesystem except the workspace volume.

## Deliverables

1. `Dockerfile` — official Bun base image, copy the project, default command surfaces the web UI on a configurable port (`ENV PORT=8080`, `EXPOSE 8080`, `CMD ["bun","source/main.ts","--serve","$PORT","--human-backend","web"]`). No install step. Run as a non-root user.
2. `.dockerignore` — exclude `node_modules/`, `data/`, `.git/`, and plan/docs where appropriate to keep the image small.
3. `docs/deployment.md` — deployment guidance:
   - Recommended `docker run` flags: `--network none` (or a restricted network) for the executor process, `--read-only` filesystem with a writable volume mounted at `data/`, `--user` non-root, optional `--cap-drop ALL` / seccomp.
   - How to pass API keys via environment variables (never in the Guild or image).
   - How to mount a Guild and benchmark workspace as volumes.
   - The explicit note that v1's `run_shell` (step 21) runs arbitrary commands inside the per-run isolated workspace (step 20); the container boundary (this step) is the outer isolation layer, with step 20 providing per-run containment inside it. Document an optional future in-tool allowlist as a deferred defense-in-depth enhancement (and, if concrete, insert a follow-up step).
4. Update `docs/architecture.md`'s execution-model note ("Single Dockerfile for the final product") to reference the new `Dockerfile` and `docs/deployment.md`.
5. The `run_shell` containment debt is owned by step 20 (environment isolation), not this step; do not remove a debt row here. Confirm the deployment docs are consistent with step 20's per-run isolation running inside this container.

## Module boundaries

- The Dockerfile and `.dockerignore` are build configuration.
- `docs/deployment.md` is documentation.
- No executor code changes expected (unless a small port/env wiring fix surfaces during build).

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` still pass (no code regressions).
- [ ] `Dockerfile` and `.dockerignore` exist and are consistent with the no-dependencies design.
- [ ] `docs/deployment.md` documents the recommended container flags, API-key handling, volume mounts, and the `run_shell`/isolation caveat (per-run isolation is step 20's layer inside this container).

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
