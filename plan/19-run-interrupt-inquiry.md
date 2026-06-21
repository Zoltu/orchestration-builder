# Step 19 — Run interrupt: inquiry channel

## Goal

Add the executor mechanism for a user to pause the active run and ask the active role a question about its current plan and progress, then resume the run after the user is done. This is the inquiry half of the run-interrupt feature; plan-modification (step 20) is the other half. The planner's behavior for handling an inquiry is taught during Guild build-out (step 21); this step delivers the channel and a minimal built-in behavior.

## Context

Read [`13-long-running-service-mode.md`](13-long-running-service-mode.md) (the service the interrupt channel lives in), [`10-web-human-backend.md`](10-web-human-backend.md) (the existing pause/resume shape — `ask_human` parks a role on a promise), and `docs/executor.md` ("Sequential scheduling", "`ask_human`").

The interrupt is **user-initiated** and distinct from the role-initiated `ask_human`: `ask_human` is the role deciding it needs information; an interrupt is the operator deciding to inject a message mid-run. Both pause the single active role, but an interrupt can arrive at any point in the role's loop (between tool calls, during an LLM call's await), whereas `ask_human` only fires when the role calls the tool.

Two interrupt modes, split across steps 18 and 19:

- **Inquiry (this step):** the user asks a question; the active role receives it as a high-priority user message, answers (and may adjust its plan in light of the question), and the run resumes. Resume is automatic once the role finishes responding.
- **Plan-modification (step 20):** the user modifies the plan; the modification is routed to the **top-level planner** (an ancestor of the active role, not necessarily the active role itself), which integrates the change and decides how the active work should resume (continue, restart a sub-task, or abort). This is harder and Guild-coupled, so it is a separate step.

## Deliverables

1. `source/executor/run-state.ts` (extend) / a new interrupt state holder — an interrupt queue per active run: `submitInterrupt(runId, message)` parks the message; the executor's role loop drains it at the next safe point. Keep the single-run invariant: only the active run can receive an interrupt.
2. `source/executor/engine.ts` (extend) — at the top of each role-loop iteration (before the next LLM call or tool dispatch), check for a pending interrupt for the active role. If present:
   - Inject the user's message as a `user`-role message flagged as an interrupt (a new message shape or a clearly-marked content prefix the role can recognize — the marker is part of the contract the Guild prompt is taught to expect).
   - Continue the loop so the role produces a response (which may include tool calls, e.g. `context_info` to gather state before answering, or `finish` if the role decides to stop).
   - Log an `interrupt` event (`{ role, message }`) so the run trace records the injection.
   - The safe-point check must not interrupt an in-flight LLM call; it drains between iterations.
3. `source/web/server.ts` (extend) — `POST /api/runs/:id/interrupt` (body: `{ message }`) submits an interrupt for the active run. Returns `202` if accepted (the run will process it at its next safe point), `409` if the run is not active or is terminal. `GET /api/runs/:id` exposes whether an interrupt is pending.
4. `source/web/static/app.js` (extend) — an "interrupt" input on the active-run view: type a message, submit; the UI shows "interrupt pending" until the run processes it. Disabled when no run is active.
5. `source/executor/engine.test.ts` (extend) — in-memory test with a fake LLM caller: submit an interrupt mid-run; assert the next LLM call's messages include the interrupt message, an `interrupt` log event is emitted, and the run resumes to completion afterward. Assert an interrupt submitted to a non-active or terminal run is rejected.
6. `docs/executor.md` — document the interrupt channel: the safe-point drain, the message marker, the log event, and the API endpoint. Note that plan-modification interrupts (step 20) extend this with ancestor routing.

## Module boundaries

- The interrupt queue is part of run state (orchestration); the drain point is in the engine (orchestration). Both testable with fakes.
- The HTTP endpoint is a thin leaf delegating to run state.
- The message marker is a documented contract between the executor and the Guild prompts; the Guild's behavior for handling it is taught in step 21, not here. This step's engine only injects the marked message and lets the role respond — it does not interpret the response.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the extended engine and server tests.
- [ ] An interrupt submitted mid-run is injected as a marked user message at the next safe point, logged, and the run resumes.
- [ ] An interrupt submitted to a non-active or terminal run is rejected (`409`).
- [ ] An in-flight LLM call is not interrupted; the drain happens between iterations.
- [ ] `docs/executor.md` documents the channel.

## End-of-step evaluation

Confirm the drain point is the only place the engine checks for interrupts (one safe point, not scattered checks). Confirm the interrupt message marker is a stable, documented string (the Guild prompts depend on it). Confirm no `as` casts. Re-read the engine loop and confirm the interrupt path cannot deadlock (an interrupt that itself triggers an `ask_human` must still resolve normally — the two pause mechanisms are independent).

## Estimated effort

Medium — the mechanism is small but the safe-point placement and the interaction with `ask_human` need care.

## Operator handoff

Run a service session, submit a task, and mid-run submit an inquiry interrupt via the UI. Confirm the active role acknowledges and answers the question and the run continues. Report any deadlocks or unexpected resume behavior; the agent fixes them in-environment. (Full planner-quality responses depend on the Guild prompts taught in step 21, so do not judge prompt quality here — only the channel mechanics.)
