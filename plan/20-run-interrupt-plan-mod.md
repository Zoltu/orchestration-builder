# Step 20 — Run interrupt: plan-modification routing

## Goal

Extend the run-interrupt channel so a user can modify the plan mid-run, with the modification routed to the **top-level planner** (an ancestor of the active role) rather than the active role itself. The planner integrates the modification and decides how the active work should resume: continue, restart a sub-task, or abort. This is the plan-mod half of the run-interrupt feature; the inquiry channel (step 19) is the other half.

## Context

Read [`19-run-interrupt-inquiry.md`](19-run-interrupt-inquiry.md) (the interrupt channel this step extends), `docs/executor.md` ("Sequential scheduling", "Built-in tools" — `agent`), and `source/executor/engine.ts` (the parent→child role traversal).

The hard part of plan-modification is that the active role is usually a **descendant** of the planner (the planner delegated to a coder via `agent`, the coder delegated to a sub-role, etc.). Injecting a plan modification into the active leaf role is wrong — the leaf cannot re-plan. The modification must reach the top-level planner, which means unwinding the active role's call stack back to the planner, delivering the modification, and letting the planner re-derive a resume strategy.

The executor is depth-first and sequential: when a child role is running, its parent is suspended mid-`agent`-tool-call, waiting on the child's result card. To route a plan-mod to the planner, the executor must:

1. Interrupt the active leaf role (step-18 mechanism).
2. Abort the active leaf and its suspended ancestors up to (but not including) the planner, returning error/aborted result cards up the chain so each parent's `agent` call completes.
3. Deliver the plan modification to the planner as a marked user message (reusing the step-18 marker).
4. The planner responds — it may re-delegate (`agent`), call `finish`, or ask for clarification. The run resumes from the planner's new decision.

The planner's *quality* at integrating a modification (deciding whether to restart a sub-task vs. continue) is Guild behavior, taught in step 21. This step delivers the routing mechanics and a minimal built-in behavior (abort-to-planner + deliver).

## Deliverables

1. `source/executor/engine.ts` (extend) — a plan-mod interrupt path distinct from the inquiry path:
   - `submitInterrupt(runId, { kind: 'plan_modification', message })` is recognized by the engine.
   - When a plan-mod interrupt is pending, the engine aborts the active leaf role (returns an `aborted` result card), which propagates up the suspended `agent`-call chain. Each aborted child returns an `{ status: 'error', error: { kind: 'aborted_for_replan' } }` result card to its parent.
   - Abortion propagates until the top-level planner (depth 0, the entry role) is the active role. The plan-mod message is then injected as a marked user message and the planner resumes.
   - Log a `plan_modification` event (`{ message, abortedRoles: [...] }`) recording what was unwound.
2. `source/web/server.ts` (extend) — `POST /api/runs/:id/interrupt` accepts `{ kind: 'inquiry' | 'plan_modification', message }` (default `inquiry` for backward compat with step 19). The kind determines the engine path.
3. `source/web/static/app.js` (extend) — the interrupt input offers a mode toggle (inquiry / plan-modification). Plan-mod submission warns the user that active sub-work will be aborted.
4. `source/executor/engine.test.ts` (extend) — in-memory test: a planner→coder run with a plan-mod interrupt submitted while the coder is active; assert the coder is aborted, the planner receives the modification, and the run resumes from the planner. Assert an inquiry interrupt (step 19) still routes to the active role, not the planner. Assert the `plan_modification` log event records the aborted roles.
5. `docs/executor.md` — extend the interrupt-channel documentation with the plan-mod path: the abort-to-planner propagation, the `aborted_for_replan` error kind, and the API `kind` field.

## Module boundaries

- The routing decision (which path: inquiry vs. plan-mod) is pure logic over the interrupt kind.
- The abort-to-planner propagation is engine orchestration; the existing `agent`-call result-card return path is reused (a child returning an error card already unwinds to its parent). The new work is triggering that unwind from an external interrupt rather than a child's `finish`.
- The planner's response to a modification is Guild behavior (step 21), not engine behavior. The engine only delivers the message and resumes.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the extended engine and server tests.
- [ ] A plan-mod interrupt submitted while a descendant role is active aborts the descendant and its intermediates, delivers the modification to the top-level planner, and the run resumes.
- [ ] An inquiry interrupt still routes to the active role (step-18 behavior unchanged).
- [ ] The `plan_modification` log event records the aborted roles.
- [ ] A plan-mod submitted when the planner is itself the active role injects the message directly (no abort needed).
- [ ] `docs/executor.md` documents both interrupt kinds.

## End-of-step evaluation

Confirm the abort-to-planner path reuses the existing `agent`-call unwind (result-card return) rather than introducing a parallel control-flow mechanism. Confirm the `aborted_for_replan` error kind is handled by the existing error-result path in the parent's `agent` tool result. Confirm a plan-mod cannot lose state: every aborted role's partial work is logged before the unwind. Re-read the engine to confirm the interrupt queue cannot deliver a plan-mod to a role that has already been aborted by a prior plan-mod (dedupe / single-in-flight invariant).

## Estimated effort

Medium to large — the abort-to-planner propagation interacts with the depth-first unwind and needs careful state tracking. The in-memory tests must cover multi-level descent (planner → coder → sub-coder) to prove the unwind reaches the right ancestor.

## Operator handoff

Run a service session with a multi-role task (a benchmark that triggers planner→coder delegation). Mid-run, submit a plan-modification interrupt. Confirm the active sub-role aborts, the planner receives the modification, and the run resumes from the planner's new plan. Report any cases where the unwind stops short of the planner or where state is lost. (Planner response quality depends on step-20 Guild prompts — judge only the routing mechanics here.)
