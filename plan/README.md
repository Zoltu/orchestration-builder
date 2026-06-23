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
- **External actions need operator handoff.** Any work that cannot be done inside this environment (Docker builds, network egress, installing a system tool) must end the step with a clear **Operator handoff** section telling the operator exactly what to run and what success looks like. The in-environment portion (code, in-memory tests, typecheck) must still be complete and green before handoff. The agent must also surface the handoff **prominently in its final response** — a dedicated, hard-to-miss "Operator action required" block at the end, not a line buried mid-summary. The operator only reads the final message; if the action is not flagged there, it will be missed. Note that a real-LLM end-to-end run is **not** automatically operator-only: see `AGENTS.md` ("Local test model") — the local Ollama endpoint usually lets a step exercise its real-LLM smoke test in-environment first. Only things the local model cannot exercise (multi-container Docker builds, real network egress, hardware the sandbox lacks) still require handoff.

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
| `typecheck` hardcodes `bun --bun tsc --noEmit`. | 04 | 23 | Named generically + fixed command so the guild cannot over-fit to TS; generalize to a per-workspace toolchain command when per-run environment isolation lands as part of the Foundry. |
| `test` hardcodes `bun test`. | 05 | 23 | Same shape as the `typecheck` debt; generalize at the Foundry step. |
| No shell allowlist/denylist for `run_shell`. | 22 | 23 | Containment comes from the deployment environment (non-root, restricted egress, read-only fs), not from an in-tool filter. A future in-tool allowlist is deferred until a concrete need arises. |
| Web UI renders role *activity* not a role *tree*. | 11 | 17 | The executor does not log agent-spawn events (parent + child + depth), so a strict parent-child tree is not recoverable from `log.jsonl`. Step 17 emits structured `agent_call`/`role_start` events and extends `role_finished` with `depth` and `parent` so `render.ts` can build the real tree; until step 17 lands, `deriveRoleActivity` renders the faithful per-role summary the log supports. |

When you add a row, also update the target step's file to describe the removal work. When you remove the debt, delete the row.

## Implementation order

The plan is structured around the product vision: a Docker image that serves a webpage, left running 24/7, with all user interaction through the UI; the Foundry builds against this target as an API client, never touching the executor bespoke. The ordering enforces "fully functional executor before any real Foundry work."

- **Steps 01–05** close out the original Phase 5 (integration & smoke testing) and add the missing v1 tools: `write_file` (01), the CLI (02), an in-memory e2e test (03), and the two safe checker tools `typecheck` (04) and `test` (05).
- **Steps 06–09** build the benchmark suite (original Phase 6).
- **Steps 10–12** build the web UI backend and the transitional `--serve` wiring (original Phase 8). Step 12 is committed but has tracked debt (server teardown, missing `SIGTERM`, dead-server UX) removed by steps 13–14.
- **Step 13** turns the executor into the long-running service backend it must be as PID 1: one-project, one-task-at-a-time, no queue, task submission via a JSON API (`POST /api/runs`), proper `SIGINT`/`SIGTERM` handling, no teardown on run completion. This is the deployment substrate and the Foundry's API target. (Split from the UI rewrite — a different kind of work — so the step stays session-sized.)
- **Step 14** rewrites the web client into the multi-run UI (run list, create-run form, per-run view with switching, dead-server surfacing) that step 13's API requires, and removes the client-side half of the step-12 debt.
- **Step 15** packages the service as a Docker image (one container = one project, single writable `/workspace` mount, `ENTRYPOINT ["bun","source/serve.ts"]` with no arguments — all configuration is environment variables with production defaults). The executor modifies the workspace in place and writes run bookkeeping under `<workspace>/.orchestration/`. The image build runs `bun install`, typecheck, and tests as gates, then removes `node_modules`.
- **Step 16** is an operator-collaboration step that figures out what UI features should exist beyond the step-14 minimum, creating follow-up steps as needed.
- **Step 17** adds the executor role-tree log events, removing the step-11 role-activity debt.
- **Steps 18–19** add the run-interrupt channel: step 18 the inquiry half (pause, ask the active role, resume), step 19 the plan-modification half (route the modification to the top-level planner via abort-to-planner). Split for session-size.
- **Steps 20–21** are the Guild build-out and retrospective: step 20 writes/refines all role prompts against the real executor surface (including teaching the planner to use the interrupt channel) and iterates with the operator; step 21 is the brainstorm that decides whether follow-up steps are needed before `run_shell` and the Foundry. The executor is frozen at this point — only `guild/` changes here.
- **Step 22** adds the `run_shell` tool — arbitrary shell command execution inside the run workspace. No longer gated on environment isolation (containment comes from the deployment environment), but extreme care should be used when testing against a real LLM since a confused model can wreck the environment.
- **Step 23** builds the Foundry — a separate program that consumes the executor as an HTTP client. The design is documented in [`docs/foundry.md`](../docs/foundry.md); the step collaborates with the operator to decide project structure (in-repo subpackage vs separate repository), design the architecture (including per-run environment isolation for benchmark evaluation), and build the full optimization loop end-to-end. Each Foundry benchmark run gets its own container (one container = one benchmark); Foundry parallelism = N containers.

The Foundry (step 23) talks to the executor service over HTTP; it never imports `runExecutor` or spawns executor processes directly. Per-run environment isolation (hermetic environments for benchmark evaluation, generalizing the checker-tool commands) is part of the Foundry step. Every original `PLAN.md` phase is accounted for: Phases 1–4 are consolidated in step 00; Phases 5–8 map to the steps above.
