# Step 33 — Run persistence and resumption

## Goal

Let a run survive a service restart. Today the executor keeps each role's conversation and budget state in memory; when the container stops (crash, host reboot, `docker stop`, operator Ctrl-C) the active run is abandoned — its `log.jsonl` is durable but no `meta.json` is written, and on restart the service starts idle while the UI shows the run perpetually "in progress". This step persists enough role state to resume an interrupted run on the next startup, and reconciles runs that cannot be resumed so the UI reports them honestly (`interrupted`) instead of hanging on "in progress".

## Context

Read [`13-long-running-service-mode.md`](13-long-running-service-mode.md) (the service lifecycle and the signal-handler debt this step closes), [`31-interrupt-inspect-platform.md`](31-interrupt-inspect-platform.md) (the safe-point drain a clean shutdown uses), `source/executor/engine.ts` (`runRole`'s `RoleState`, the depth-first `agent`-call stack), `source/executor/executor.ts`, `source/executor/persistence.ts`, and `source/executor/run-submission.ts`. Read the tracked-debt row "Signal handler abandons the active run instead of draining it gracefully" in `plan/README.md`.

The deployment model is one container = one project, left running 24/7. Restarts happen: the host reboots, the image is upgraded, an operator stops the container, or a fatal error tears the process down. A run budget is up to four hours; losing all of that on every restart is a poor operator experience and makes long runs effectively impossible. The interrupt channel (step 31) gives a running role a safe point to stop at; this step gives the service a way to *start back up where it left off*.

The hard part is the depth-first role stack. When a child role is running, its parent is suspended mid-`agent`-tool-call awaiting the child's result card. Resuming means reconstructing not just the active leaf role's conversation but the entire suspended ancestor chain — each parent's `RoleState`, the pending `ToolCall` it was waiting on, and the budget accumulators. A faithful resume re-enters the leaf and lets the depth-first traversal unwind naturally on completion.

## Deliverables

1. **Role-state persistence.** `source/executor/engine.ts` / `source/executor/persistence.ts` (extend) — at each safe point (the same drain point step 31 established, plus on every `role_finished`), write the runnable role-stack state to a checkpoint file under the run directory (e.g. `state.json`): for each active role on the stack, its `RoleState` (history, tool-call count, token accumulators, recent-tool-call/compaction windows), the pending `agent` tool call each parent is suspended on, and the `EngineContext` (roleName, depth, task, parent). The checkpoint is written atomically (temp file + rename, the same pattern `meta.json` uses) so a torn write does not corrupt the resume. `log.jsonl` is already append-only and durable; the checkpoint is the missing piece.
2. **Startup reconciliation.** `source/serve.ts` / `source/executor/run-submission.ts` (extend) — on startup, scan the runs directory for runs that have a `log.jsonl` but no terminal `meta.json` (or a `meta.json` with `status: 'running'`). For each:
   - If a valid checkpoint exists, resume the run: reload the role stack from the checkpoint and re-enter `runRole` at the suspended leaf, letting the depth-first traversal continue. The run's `runId`, `task`, and budget accumulators are preserved.
   - If no valid checkpoint exists (e.g. a crash mid-checkpoint-write, or a pre-step-33 abandoned run), write a terminal `meta.json` with `status: 'interrupted'` and an `error: { kind, message }` recording that the run was abandoned and could not be resumed, so the UI stops showing it as "in progress".
   Only one run may resume at a time (the one-task-at-a-time invariant); if multiple interrupted runs exist, resume the most recent and mark the rest `interrupted`.
3. **`interrupted` status.** `source/executor/types.ts` (extend) — add `'interrupted'` to `RunMeta['status']`. Extend the validators (`isRunMeta`) and the web layer's status label/terminal-set handling (`app.js` `STATUS_LABELS`, `TERMINAL_STATUSES`; `render.ts` status typing) so an interrupted run renders as a terminal state ("interrupted", red) rather than "in progress".
4. **Graceful-shutdown integration.** `source/serve.ts` (extend) — close the step-13/31 debt: on `SIGINT`/`SIGTERM` with an active run, submit an inquiry interrupt asking the run to wind down (step 31), await it under a short bounded timeout, then on exit write a final checkpoint so the next startup resumes cleanly. If the timeout elapses (the run did not reach a safe point), write the checkpoint from whatever state is reachable and exit; the next startup resumes from there. Remove the "Signal handler abandons the active run" debt row from `plan/README.md`.
5. `source/executor/engine.test.ts` (extend) — in-memory test with a fake LLM caller: run a planner→coder descent, trigger a checkpoint, reconstruct the role stack from the checkpoint, and assert the resumed run continues from the suspended leaf and produces the same final result as an uninterrupted run. Assert a corrupted/absent checkpoint reconciles to `interrupted`.
6. `source/executor/executor.test.ts` / `source/web/server.test.ts` (extend) — cover the `interrupted` status surfacing through to the run view, and the startup-resume path with a fake `startRun` that parks (so the test drives the lifecycle without a real LLM).
7. `docs/reference.md` — document the checkpoint file, the resume contract, the `interrupted` status, and the restart behavior (a stopped container resumes its active run on next start; an unresumable run is marked `interrupted`).

## Module boundaries

- Checkpoint writing is a new persistence leaf (atomic write, sibling to `writeMeta`); the decision of *when* to checkpoint is engine orchestration (the existing safe-point drain).
- Resume is orchestration in `runSubmission`/`serve` startup: it reads the checkpoint and re-enters the engine. The engine's `runRole` must accept a reconstructed `RoleState`/context rather than always starting fresh — extend its entry to take an optional persisted state.
- No Guild changes. No new endpoints (resume is a startup behavior, not API-driven). The UI only learns the new `interrupted` status.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the checkpoint/resume and `interrupted`-status tests.
- [ ] A run stopped mid-flight (via graceful shutdown) resumes from its checkpoint on the next service start and runs to completion, producing the same result as an uninterrupted run.
- [ ] A run whose checkpoint is absent or corrupt is marked `interrupted` with a terminal `meta.json` on startup; the UI renders it as terminal, not "in progress".
- [ ] The depth-first role stack is faithfully reconstructed: a resumed parent→child run re-enters the child, and on the child's `finish` the parent continues from its suspended `agent` call.
- [ ] The "Signal handler abandons the active run" debt row is removed from `plan/README.md`.
- [ ] No new dependencies.

## End-of-step evaluation

Confirm the checkpoint is written atomically (a torn write mid-restart must reconcile to `interrupted`, not crash the startup). Confirm the resumed role-stack reconstruction preserves budget accumulators (a resumed run must not reset `toolCalls`/`promptTokens` and so must not exceed its budget by forgetting prior usage). Confirm the single-active-run invariant holds at startup (resume at most one run; mark the rest `interrupted`). Re-read `runRole`'s entry to confirm the optional-persisted-state parameter does not change the fresh-start path. Confirm no `as` casts — the reconstructed `RoleState` is validated by a type guard against the checkpoint JSON before use.

## Estimated effort

Large — persisting and reconstructing the depth-first role stack is the core difficulty, and the resume must preserve budget accumulators and the suspended `agent`-call chain exactly. Budget for a design pass with the operator on the checkpoint format before implementing.

## Operator handoff

Run a multi-role task, stop the container mid-run (`docker stop`), restart it, and confirm the run resumes and completes. Then kill the container hard (`docker kill`) mid-checkpoint-write and confirm the next start marks the run `interrupted` rather than hanging on "in progress". Report any state lost on resume (forgotten tool calls, reset budgets, a parent that does not receive its child's result) — those are resume-correctness bugs to fix in-environment.
