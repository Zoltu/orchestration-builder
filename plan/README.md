# Adaptive Orchestrator — Development Plan

This is the working development plan for the Adaptive Orchestrator. It is broken into **bite-sized steps**, each sized to be completed in a single session by a competent agent. The foundation (the original Phases 1–4) is already complete; its design-decision record lives in [`00-foundation-completed.md`](00-foundation-completed.md). The executable work begins at step `01`.

> **Note:** This plan is a living document. No plan survives contact with reality unchanged. When implementation reveals that a plan's assumptions are wrong, or that a different approach is clearly better, update the plan (and `AGENTS.md`) to match the well-factored code, not the other way around. See `AGENTS.md` ("Adapting the Plan").

## How to use this plan

1. Read [`AGENTS.md`](../AGENTS.md) first and last. Its Project-Wide Principles, type-safety, error-handling, testing, and architecture rules apply to every step.
2. Read [`00-foundation-completed.md`](00-foundation-completed.md) for the design-decision context inherited from Phases 1–4.
3. Pick the lowest-numbered step that is not yet complete. Each step file is self-contained: goal, context, deliverables, module boundaries, acceptance criteria, and (where relevant) operator handoff.

## Step hygiene — read before starting any step

Every step must leave the repository in a **clean, healthy state**. A step is not done when its acceptance criteria pass; it is done when the repository is something a reviewer would be happy to inherit.

- **Leave it clean.** `bun run typecheck` and `bun test source/` must both pass at the end of the step. No failing tests, no type errors, no dead code introduced, no TODO litter left behind.
- **Pay technical debt before closing.** If the step accrued debt that can be paid within the session (a cast, a control-flow-via-catch, a missing guard, a duplicated helper), pay it before the step closes. Do not defer debt that is cheap to remove.
- **Track debt you cannot pay.** If some debt is genuinely unavoidable (e.g. it depends on a later step's deliverable), record it explicitly in this README's [Tracked technical debt](#tracked-technical-debt) table, name the step that will remove it, and update that step's file to call out the removal work. Untracked debt is a violation.
- **Evaluate and refactor at the end.** Before declaring a step done, re-read the changed files and the modules they touch. Is the naming clear? Is the data flow obvious? Did a helper drift from its siblings? Refactor while the context is fresh. Small refactorings at the end of each step keep the codebase healthy across the whole plan; they are not optional polish.
- **Update the plan when reality diverges.** If a discovery during a step will require significant work to overcome, **insert a new step** into the plan and renumber the affected steps accordingly. Renumber both the status table below and the step filenames (`NN-name.md`). Do not silently expand a step's scope; split it.
- **Keep steps session-sized.** If a step grows past what a single session can do well, split it into two steps and renumber. Code quality over speed — see `AGENTS.md`.
- **External actions need operator handoff.** Any work that cannot be done inside this environment (real-LLM end-to-end runs, Docker builds, network egress, installing a system tool) must end the step with a clear **Operator handoff** section telling the operator exactly what to run and what success looks like. The in-environment portion (code, in-memory tests, typecheck) must still be complete and green before handoff.

## Project goals (recap)

1. Build a minimal executor that runs a small language model against a JSON-driven Guild configuration. *(done — foundation)*
2. Seed a Guild capable of long-horizon coding tasks and project maintenance for non-developers. *(done — foundation; refined as tools land)*
3. Validate the system with a real benchmark suite covering minutes-long bug fixes and days-long application builds.
4. Add a meta-optimizer (Foundry) that automatically improves the Guild offline.
5. Deliver a simple web UI and containerized deployment for end users.

The target user is a **non-developer**. The Guild must ask few, clear clarifying questions and explain failures in plain language.

## Status

| Step | Focus | Status | File |
|---|---|---|---|
| 00 | Foundation (Phases 1–4) | ✅ complete | [`00-foundation-completed.md`](00-foundation-completed.md) |
| 01 | `write_file` tool | pending | [`01-write-file-tool.md`](01-write-file-tool.md) |
| 02 | CLI entry point + executor public API | pending | [`02-cli-entry-point.md`](02-cli-entry-point.md) |
| 03 | In-memory end-to-end integration test | pending | [`03-in-memory-e2e-test.md`](03-in-memory-e2e-test.md) |
| 04 | `run_shell` tool | pending | [`04-run-shell-tool.md`](04-run-shell-tool.md) |
| 05 | Benchmark suite harness + authoring guide | pending | [`05-benchmark-harness.md`](05-benchmark-harness.md) |
| 06 | Quick-fix benchmarks | pending | [`06-quick-fix-benchmarks.md`](06-quick-fix-benchmarks.md) |
| 07 | Medium benchmarks | pending | [`07-medium-benchmarks.md`](07-medium-benchmarks.md) |
| 08 | Large benchmark | pending | [`08-large-benchmark.md`](08-large-benchmark.md) |
| 09 | Foundry foundation: types, config, branch management | pending | [`09-foundry-foundation.md`](09-foundry-foundation.md) |
| 10 | Foundry validation + scoring | pending | [`10-foundry-validation-scoring.md`](10-foundry-validation-scoring.md) |
| 11 | Foundry branch evaluation | pending | [`11-foundry-evaluation.md`](11-foundry-evaluation.md) |
| 12 | Foundry hypothesis generation | pending | [`12-foundry-hypothesis.md`](12-foundry-hypothesis.md) |
| 13 | Foundry merge + reporting | pending | [`13-foundry-merge-report.md`](13-foundry-merge-report.md) |
| 14 | Foundry CLI + optimization loop + safeguards | pending | [`14-foundry-cli-loop.md`](14-foundry-cli-loop.md) |
| 15 | Web `ask_human` backend state machine | pending | [`15-web-human-backend.md`](15-web-human-backend.md) |
| 16 | Web UI server + static assets | pending | [`16-web-ui-server.md`](16-web-ui-server.md) |
| 17 | `main.ts --serve` wiring | pending | [`17-main-serve-wiring.md`](17-main-serve-wiring.md) |
| 18 | Dockerfile + deployment docs | pending | [`18-dockerfile-deployment.md`](18-dockerfile-deployment.md) |

When a step completes, mark its status `✅ complete` and add a dated closeout section to its file (see `00-foundation-completed.md` for the format) recording any deviations from the plan wording, so future sessions inherit reality rather than aspiration.

## Tracked technical debt

| Debt | Source step | To be removed in | Notes |
|---|---|---|---|
| _None currently._ | — | — | — |

When you add a row, also update the target step's file to describe the removal work. When you remove the debt, delete the row.

## Implementation order

Steps 01–04 close out the original Phase 5 (integration & smoke testing) and bridge into real benchmarks by adding the two missing v1 tools. Steps 05–08 build the benchmark suite (original Phase 6). Steps 09–14 build the Foundry meta-optimizer (original Phase 7). Steps 15–18 build the web UI and deployment (original Phase 8).

Every original `PLAN.md` phase is accounted for: Phases 1–4 are consolidated in step 00; Phases 5–8 map to the steps above. The old top-level `PLAN.md` has been removed to avoid maintaining redundant content.
