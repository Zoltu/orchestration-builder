# Step 29 — Foundry standalone entry point + optimization loop + safeguards

## Goal

Wire the Foundry pieces (steps 23–28) into a top-level optimization loop with a **standalone entry point** (a separate program from the executor service, not a `main.ts` subcommand), and enforce the termination safeguards (cycle budget, cost budget, plateau detection, no-op detection). After this step the Foundry can run a full optimize cycle end-to-end (against a real big model + the real executor service — operator work).

## Context

Read `docs/foundry.md` ("Overview of the optimization loop", "Guardrails and termination", "Promotion and rollback", "Separation from the executor"). The loop: observe → hypothesize → branch → evaluate → compare → merge → report → repeat, until a guardrail fires. The Foundry is a client of the executor service (step 13): it submits runs via the per-benchmark container leaf (steps 25–26) and reads results over the service API. The Foundry never imports `runExecutor` or runs inside the executor process.

The realignment made the Foundry a standalone program rather than a `main.ts foundry optimize` subcommand. Rationale: the Foundry is an HTTP client + Docker orchestrator + big-model caller, a different program from the executor service. Keeping it separate keeps the executor's dependency surface minimal (the executor still imports nothing from `source/foundry/`) and lets the Foundry run on a different host from the executor service if desired.

## Deliverables

1. `source/foundry/loop.ts` — orchestration `runOptimizationCycle(dependencies, { config, suiteDir, baselineGuildPath })` implementing one cycle, and `runFoundry(dependencies, { config, suiteDir, baselineGuildPath })` implementing the repeating loop with safeguards. Dependencies are all the leaves/orchestrations from steps 23–28 (branch manager, scoring, run-submitter, evaluation loop, big-model caller, merge, report, promote); no defaults.
2. `source/foundry/loop.test.ts` — in-memory tests with fakes for every dependency. Cover: a cycle that produces an accepted branch promotes it; a cycle with no improvement increments the plateau counter; hitting the cycle budget stops the loop; no-op hypotheses (wording-only changes that don't move scores) are discarded; a regression in the merged candidate prevents promotion.
3. `source/foundry/main.ts` — the Foundry's standalone entry point. Parses Foundry CLI args (`--suite`, `--cycles`, `--guild`, cost/plateau overrides, the big-model endpoint env var, and the executor-service endpoint/container-image config the run-submitter needs). Assembles real Foundry dependencies and calls `runFoundry`. This entry point is not unit-tested (integration shell), mirroring the executor's `source/main.ts` pattern. A pure arg helper (`source/foundry/main-args.ts`) holds the testable parsing surface, mirroring `source/main-args.ts`.
4. `package.json` — add a `foundry` script (e.g. `"foundry": "bun source/foundry/main.ts"`) so the operator can run `bun run foundry -- --suite benchmarks/ ...`.
5. Safeguards implemented as pure helpers where possible (e.g. `shouldTerminate(state, config): TerminationReason`) so they are testable in isolation.
6. `README.md` — document the Foundry entry point invocation, the big-model env var, and the executor-service/container config the Foundry needs.

## Module boundaries

- `loop.ts` is orchestration; all leaves injected.
- `source/foundry/main.ts` assembles deps; no logic (mirrors the executor `main.ts` rule).
- `source/foundry/main-args.ts` is a pure arg helper, unit-tested.
- Safeguard logic is pure and tested directly.
- The Foundry never imports from `source/executor/` — it talks to the service over HTTP via the step-25 run-submitter.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including `source/foundry/main-args.test.ts`.
- [ ] The loop promotes a clearly-improving branch and refuses a regressing one (fakes).
- [ ] Every guardrail (cycle, cost, plateau, no-op) terminates the loop correctly (fakes).
- [ ] `bun source/foundry/main.ts --help` prints usage and exits non-zero on bad args.
- [ ] No `source/foundry/` file imports from `source/executor/` (the Foundry is a service client, not a peer).
- [ ] `README.md` documents the Foundry command.

## End-of-step evaluation

Confirm `loop.ts` does not reach for globals or env. Ensure the safeguard helpers are pure and independently tested. Re-read the whole `source/foundry/` tree and refactor any orchestration that grew too large or any leaf that acquired logic — split before closing. Confirm no `as` casts. Confirm the executor's `source/main.ts` was not modified to add a `foundry` subcommand (the Foundry is standalone).

## Estimated effort

Large — this is the capstone of the Foundry; the loop ties everything together and the safeguards are easy to get subtly wrong. The standalone entry point + arg helper mirror the executor's step-02 pattern, which is a small fraction of the work.

## Operator handoff

Run a real optimization cycle: `bun source/foundry/main.ts --suite benchmarks/ --guild guild --cycles 3` with a real big-model endpoint and a running executor service (step 13) plus a built container image (step 15). Provide the generated `data/foundry/reports/<timestamp>/summary.json` and `index.html` back. The agent should sanity-check the report shape in-environment and iterate on prompt/parsing bugs surfaced by the real run.
