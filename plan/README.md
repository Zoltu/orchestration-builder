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
- **Re-check comment and newline hygiene.** Before declaring a step done, re-read the changed files against `AGENTS.md` ("Comments explain why, never what" and "Formatting"): delete comments that restate a name/signature/type/obvious behavior, remove bare `TODO`/`FIXME`/`XXX`/`HACK`/"later"/"placeholder" notes (move real work to the [Tracked technical debt](#tracked-technical-debt) table), and rejoin any comment, doc block, or string literal broken mid-sentence for width. These accumulate silently; sweep them every change.
- **Pay technical debt before closing.** If the step accrued debt that can be paid within the session (a cast, a control-flow-via-catch, a missing guard, a duplicated helper), pay it before the step closes. Do not defer debt that is cheap to remove.
- **Track debt you cannot pay.** If some debt is genuinely unavoidable (e.g. it depends on a later step's deliverable), record it explicitly in this README's [Tracked technical debt](#tracked-technical-debt) table, name the step that will remove it, and update that step's file to call out the removal work. Untracked debt is a violation.
- **Evaluate and refactor at the end.** Before declaring a step done, re-read the changed files and the modules they touch. Is the naming clear? Is the data flow obvious? Did a helper drift from its siblings? Refactor while the context is fresh. Small refactorings at the end of each step keep the codebase healthy across the whole plan; they are not optional polish.
- **Update the plan when reality diverges.** If a discovery during a step will require significant work to overcome, **insert a new step** into the plan and renumber the affected steps accordingly. Renumber both the status table below and the step filenames (`NN-name.md`). Do not silently expand a step's scope; split it.
- **Keep steps session-sized.** If a step grows past what a single session can do well, split it into two steps and renumber. Code quality over speed — see `AGENTS.md`.
- **External actions need operator handoff.** Any work that cannot be done inside this environment (real-LLM end-to-end runs, Docker builds, network egress, installing a system tool) must end the step with a clear **Operator handoff** section telling the operator exactly what to run and what success looks like. The in-environment portion (code, in-memory tests, typecheck) must still be complete and green before handoff. The agent must also surface the handoff **prominently in its final response** — a dedicated, hard-to-miss "Operator action required" block at the end, not a line buried mid-summary. The operator only reads the final message; if the action is not flagged there, it will be missed.

## Project goals (recap)

1. Build a minimal executor that runs a small language model against a JSON-driven Guild configuration. *(done — foundation)*
2. Seed a Guild capable of long-horizon coding tasks and project maintenance for non-developers. *(done — foundation; refined as tools land)*
3. Validate the system with a real benchmark suite covering minutes-long bug fixes and days-long application builds.
4. Add a meta-optimizer (Foundry) that automatically improves the Guild offline.
5. Deliver a simple web UI and containerized deployment for end users.

The target user is a **non-developer**. The Guild must ask few, clear clarifying questions and explain failures in plain language.

## Status

When a step completes, mark its status `✅ complete` and add a dated closeout section to its file (see `00-foundation-completed.md` for the format) recording any deviations from the plan wording, so future sessions inherit reality rather than aspiration.

## Tracked technical debt

| Debt | Source step | To be removed in | Notes |
|---|---|---|---|
| `typecheck` hardcodes `bun --bun tsc --noEmit`. | 04 | 20 | Named generically + fixed command so the guild cannot over-fit to TS; generalize to a per-workspace toolchain command when environment isolation + multi-language support land. |
| `test` hardcodes `bun test`. | 05 | 20 | Same shape as the `typecheck` debt; generalize at the isolation/multi-language step. |
| No shell allowlist/denylist for `run_shell`. | 21 | 20 | Containment comes from step-20 per-run isolation (non-root, no unapproved egress, hermetic fs), not an in-tool filter. The dependency on step 20 is the link; a future in-tool allowlist is deferred until a concrete need (e.g. an environment without full isolation) arises. |
| Web UI renders role *activity* not a role *tree*. | 11 | 22 | The executor does not log agent-spawn events (parent + child + depth), so a strict parent-child tree is not recoverable from `log.jsonl`. Step 22 emits structured `agent_call`/`role_start` events and extends `role_finished` with `depth` and `parent` so `render.ts` can build the real tree; until step 22 lands, `deriveRoleActivity` renders the faithful per-role summary the log supports. |

When you add a row, also update the target step's file to describe the removal work. When you remove the debt, delete the row.

## Implementation order

Steps 01–05 close out the original Phase 5 (integration & smoke testing) and bridge into real benchmarks by adding the missing v1 tools: `write_file` (01), the CLI (02), an in-memory e2e test (03), and the two safe checker tools `typecheck` (04) and `test` (05). Steps 06–09 build the benchmark suite (original Phase 6). Steps 10–13 build the web UI and deployment (original Phase 8), brought forward ahead of the Foundry so a fully deployable, human-in-the-loop product ships before the offline optimizer — the executor and Guild are stable by step 05, so the web UI depends on no later work, and deferring the Foundry keeps the optimizer (which treats the executor as a black box and is not required for the product to run) last among the original phases. Steps 14–19 build the Foundry meta-optimizer (original Phase 7). Steps 20–21 add per-run environment isolation and the `run_shell` tool that it unblocks — placed at the end so a full, deployable product ships before the larger isolation work; step 20 is an operator-collaboration step (the agent proposes approaches and works with the operator, it does not implement isolation unilaterally), and step 21 (`run_shell`) is gated on it. Step 22 is the removal work for a debt the web UI step (11) introduced: it adds the executor log events the UI needs to render a real role tree, scheduled after the isolation work so the deployment surface is complete first.

Every original `PLAN.md` phase is accounted for: Phases 1–4 are consolidated in step 00; Phases 5–8 map to the steps above. The old top-level `PLAN.md` has been removed to avoid maintaining redundant content.
