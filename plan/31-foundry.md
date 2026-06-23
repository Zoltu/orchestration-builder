# Step 31 — Foundry design and implementation

## Goal

Build the Foundry — a meta-optimizer that automatically improves the Guild by proposing, testing, and merging changes. The Foundry is a separate program that consumes the executor as an HTTP client.

## Context

Read [`docs/foundry.md`](../docs/foundry.md) in full — it is the complete design reference for the Foundry, covering the optimization loop, branch management, scoring, evaluation, hypothesis generation, merge/conflict resolution, guardrails, promotion/rollback, data layout, and the architecture decision that the Foundry is an HTTP client of the executor (never imports from `source/executor/`). Also read [`docs/architecture.md`](../docs/architecture.md) ("Data flow: an optimization cycle") and [`docs/reference.md`](../docs/reference.md) (the HTTP API the Foundry talks to).

The existing `source/benchmarks/` harness (validation, run-suite) is complete and decoupled — it will be reused by the Foundry. The existing `source/foundry/` scaffold was deleted because it was written against a stale in-process model and violated the target architecture.

## Deliverables

Collaborate with the operator to:

1. **Decide project structure.** Should the Foundry live as a subpackage within this repository (separate `package.json`/`tsconfig`, consuming the executor only as an HTTP client) or as a separate repository that consumes the executor's published image/API? Document the decision and rationale.

2. **Design the architecture and implementation plan.** The design in `docs/foundry.md` is the reference, but by the time this step runs, the executor and Guild will have evolved. Re-evaluate the design against the current state and adjust as needed. Figure out the right module decomposition — the doc outlines the pieces (branch management, scoring, evaluation, hypothesis generation, merge, report, promotion, loop, entry point) but the agent and operator should decide the right breakdown together.

3. **Solve per-run environment isolation.** Each Foundry benchmark run gets its own container (one container = one benchmark) so benchmarks that install packages or download tooling cannot pollute each other. This step designs and implements the isolation mechanism: hermetic per-run environment (scoped `PATH`/`HOME`, no global pollution, no unapproved egress for `bun install`/dependency fetches), the toolchain profile concept, and generalization of the checker-tool commands (removing the step-04/05 hardcoded-checker debt). The egress policy, trust boundary, and any container-runtime decisions belong to the operator — propose, don't impose.

4. **Build the Foundry end-to-end.** Implement the full optimization loop: observe → hypothesize → branch → evaluate → score → merge → report → promote → repeat, with guardrails. The Foundry submits runs to the executor service over HTTP, never imports `runExecutor`, and runs as a standalone program.

5. **Wire up the benchmarks harness.** Connect `source/benchmarks/` (or its successor in the foundry project) to the Foundry's evaluation loop. The Foundry should be able to run a full optimization cycle against the benchmark suite.

## Module boundaries

- The Foundry never imports from `source/executor/`. It talks to the executor exclusively over HTTP.
- The Foundry may import from `source/benchmarks/` (validation helpers) if it lives in the same repository, or duplicate/reimplement them if separate.
- `docs/foundry.md` is the authoritative design reference; update it if implementation reveals the design needs adjustment.

## Acceptance criteria

- [ ] The Foundry can run a full optimization cycle end-to-end against the executor service and benchmark suite.
- [ ] The Foundry never imports from `source/executor/`.
- [ ] `bun run typecheck` and `bun test` pass (for whichever project(s) the Foundry lives in).
- [ ] A real optimization cycle produces a report and (if successful) a promoted baseline Guild.

## End-of-step evaluation

Confirm the Foundry is a true HTTP client of the executor — no in-process coupling. Confirm the design in `docs/foundry.md` matches what was built (update the doc if not). Re-read the whole Foundry codebase and refactor anything that grew too large or acquired logic that should be in a pure helper. Confirm no `as` casts.

## Operator handoff

Run a real optimization cycle with a real big-model endpoint and a running executor service. Provide the generated report and any bugs surfaced by the real run back to the agent for fixing.
