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
- **Keep the plan out of source.** Source files, tests, and commit messages must never reference the plan — no "step N", "phase N", "the plan", or `plan/` paths in comments, identifiers, error messages, or test names. The plan is a transient artifact that will be deleted once the work is complete; source must stand on its own. Comments that need design context point at the permanent `docs/*.md` by filename and section; comments that need a sibling module point at its path or symbol, not at the step that builds it. See `AGENTS.md` "Comments".
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
| 04 | `typecheck` tool | pending | [`04-typecheck-tool.md`](04-typecheck-tool.md) |
| 05 | `test` tool | pending | [`05-test-tool.md`](05-test-tool.md) |
| 06 | Benchmark suite harness + authoring guide | ✅ complete | [`06-benchmark-harness.md`](06-benchmark-harness.md) |
| 07 | Quick-fix benchmarks | ✅ complete (in-env; real-run handoff blocked on step 01) | [`07-quick-fix-benchmarks.md`](07-quick-fix-benchmarks.md) |
| 08 | Medium benchmarks | ✅ complete (in-env; real-run handoff blocked on step 01) | [`08-medium-benchmarks.md`](08-medium-benchmarks.md) |
| 09 | Large benchmark | ✅ complete (in-env; real-run handoff blocked on step 01) | [`09-large-benchmark.md`](09-large-benchmark.md) |
| 10 | Web `ask_human` backend state machine | pending | [`10-web-human-backend.md`](10-web-human-backend.md) |
| 11 | Web UI server + static assets | pending | [`11-web-ui-server.md`](11-web-ui-server.md) |
| 12 | `main.ts --serve` wiring | pending | [`12-main-serve-wiring.md`](12-main-serve-wiring.md) |
| 13 | Dockerfile + deployment docs | pending | [`13-dockerfile-deployment.md`](13-dockerfile-deployment.md) |
| 14 | Foundry foundation: types, config, branch management | ✅ complete | [`14-foundry-foundation.md`](14-foundry-foundation.md) |
| 15 | Foundry validation + scoring | pending | [`15-foundry-validation-scoring.md`](15-foundry-validation-scoring.md) |
| 16 | Foundry branch evaluation | pending | [`16-foundry-evaluation.md`](16-foundry-evaluation.md) |
| 17 | Foundry hypothesis generation | pending | [`17-foundry-hypothesis.md`](17-foundry-hypothesis.md) |
| 18 | Foundry merge + reporting | pending | [`18-foundry-merge-report.md`](18-foundry-merge-report.md) |
| 19 | Foundry CLI + optimization loop + safeguards | pending | [`19-foundry-cli-loop.md`](19-foundry-cli-loop.md) |
| 20 | Per-run environment isolation (operator-collaboration) | pending | [`20-environment-isolation.md`](20-environment-isolation.md) |
| 21 | `run_shell` tool (gated on step 20) | pending | [`21-run-shell-tool.md`](21-run-shell-tool.md) |

When a step completes, mark its status `✅ complete` and add a dated closeout section to its file (see `00-foundation-completed.md` for the format) recording any deviations from the plan wording, so future sessions inherit reality rather than aspiration.

## Tracked technical debt

| Debt | Source step | To be removed in | Notes |
|---|---|---|---|
| `typecheck` hardcodes `bun --bun tsc --noEmit`. | 04 | 20 | Named generically + fixed command so the guild cannot over-fit to TS; generalize to a per-workspace toolchain command when environment isolation + multi-language support land. |
| `test` hardcodes `bun test`. | 05 | 20 | Same shape as the `typecheck` debt; generalize at the isolation/multi-language step. |
| No shell allowlist/denylist for `run_shell`. | 21 | 20 | Containment comes from step-20 per-run isolation (non-root, no unapproved egress, hermetic fs), not an in-tool filter. The dependency on step 20 is the link; a future in-tool allowlist is deferred until a concrete need (e.g. an environment without full isolation) arises. |

When you add a row, also update the target step's file to describe the removal work. When you remove the debt, delete the row.

## Implementation order

Steps 01–05 close out the original Phase 5 (integration & smoke testing) and bridge into real benchmarks by adding the missing v1 tools: `write_file` (01), the CLI (02), an in-memory e2e test (03), and the two safe checker tools `typecheck` (04) and `test` (05). Steps 06–09 build the benchmark suite (original Phase 6). Steps 10–13 build the web UI and deployment (original Phase 8), brought forward ahead of the Foundry so a fully deployable, human-in-the-loop product ships before the offline optimizer — the executor and Guild are stable by step 05, so the web UI depends on no later work, and deferring the Foundry keeps the optimizer (which treats the executor as a black box and is not required for the product to run) last among the original phases. Steps 14–19 build the Foundry meta-optimizer (original Phase 7). Steps 20–21 add per-run environment isolation and the `run_shell` tool that it unblocks — placed at the end so a full, deployable product ships before the larger isolation work; step 20 is an operator-collaboration step (the agent proposes approaches and works with the operator, it does not implement isolation unilaterally), and step 21 (`run_shell`) is gated on it.

Every original `PLAN.md` phase is accounted for: Phases 1–4 are consolidated in step 00; Phases 5–8 map to the steps above. The old top-level `PLAN.md` has been removed to avoid maintaining redundant content.
