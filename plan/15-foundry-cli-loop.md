# Step 15 — Foundry CLI + optimization loop + safeguards

## Goal

Wire the Foundry pieces (steps 10–14) into a top-level optimization loop with a CLI entry point, and enforce the termination safeguards (cycle budget, cost budget, plateau detection, no-op detection). After this step the Foundry can run a full optimize cycle end-to-end (against a real big model + real executor — operator work).

## Context

Read `docs/foundry.md` ("Overview of the optimization loop", "Guardrails and termination", "Promotion and rollback", "Separation from the executor"). The loop: observe → hypothesize → branch → evaluate → compare → merge → report → repeat, until a guardrail fires. `bun source/main.ts foundry optimize --suite benchmarks/ --cycles 5`. The Foundry invokes the executor as a black box and never runs inside it.

## Deliverables

1. `source/foundry/loop.ts` — orchestration `runOptimizationCycle(dependencies, { config, suiteDir, baselineGuildPath })` implementing one cycle, and `runFoundry(dependencies, { config, suiteDir, baselineGuildPath })` implementing the repeating loop with safeguards. Dependencies are all the leaves/orchestrations from steps 10–14 plus the big-model caller; no defaults.
2. `source/foundry/loop.test.ts` — in-memory tests with fakes for every dependency. Cover: a cycle that produces an accepted branch promotes it; a cycle with no improvement increments the plateau counter; hitting the cycle budget stops the loop; no-op hypotheses (wording-only changes that don't move scores) are discarded; a regression in the merged candidate prevents promotion.
3. `source/main.ts` (extend the step-02 CLI) — add a `foundry optimize` subcommand parsing `--suite`, `--cycles`, `--guild`, cost/plateau overrides, and the big-model endpoint env var. Assembles real Foundry dependencies and calls `runFoundry`. This CLI path is not unit-tested (integration shell).
4. Safeguards implemented as pure helpers where possible (e.g. `shouldTerminate(state, config): TerminationReason`) so they are testable in isolation.
5. `README.md` — document the Foundry CLI invocation and the big-model env var.

## Module boundaries

- `loop.ts` is orchestration; all leaves injected.
- `main.ts` `foundry` path assembles deps; no logic.
- Safeguard logic is pure and tested directly.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The loop promotes a clearly-improving branch and refuses a regressing one (fakes).
- [ ] Every guardrail (cycle, cost, plateau, no-op) terminates the loop correctly (fakes).
- [ ] `bun source/main.ts foundry optimize --help` prints usage and exits non-zero on bad args.
- [ ] `README.md` documents the Foundry command.

## End-of-step evaluation

Confirm `loop.ts` does not reach for globals or env. Ensure the safeguard helpers are pure and independently tested. Re-read the whole `source/foundry/` tree and refactor any orchestration that grew too large or any leaf that acquired logic — split before closing. Confirm no `as` casts.

## Estimated effort

Large — this is the capstone of the Foundry; the loop ties everything together and the safeguards are easy to get subtly wrong.

## Operator handoff

Run a real optimization cycle: `bun source/main.ts foundry optimize --suite benchmarks/ --guild guild --cycles 3` with a real big-model endpoint and a real executor endpoint. Provide the generated `data/foundry/reports/<timestamp>/summary.json` and `index.html` back. The agent should sanity-check the report shape in-environment and iterate on prompt/parsing bugs surfaced by the real run.
