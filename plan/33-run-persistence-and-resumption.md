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

Verified in-environment (see closeout): a SIGKILLed mid-run service resumed and completed on restart, an unresumable run was marked `interrupted`, and an idle SIGTERM exited cleanly. **Operator verification (2026-08-02):** `docker stop` mid-run resumed on container restart, and `docker kill` mid-checkpoint-write also resumed — both correct. The kill case was expected to reconcile to `interrupted` in this handoff's original wording, but that premise was wrong: the atomic temp+rename write means the on-disk `state.json` is always a complete checkpoint, so a hard kill cannot corrupt it — resume from the previous safe point is the designed outcome (losing at most the in-flight turn). `interrupted` fires only when no valid checkpoint exists (crash before the first safe point, pre-step-33 runs, corrupt/mismatched files, superseded runs) — covered by the reconciliation tests and the in-environment planted run. `docs/reference.md` "Run persistence and resumption" records this expectation.

## Closeout (2026-08-02)

Complete. `bun run typecheck`, `bun test source/` (800 tests across 40 files), and `bun run validate-data` all pass. The "Signal handler abandons the active run" debt row is removed from `plan/README.md`.

Changed files:

- `source/executor/checkpoint.ts` (new) — the checkpoint contract: `RunCheckpoint`/`CheckpointFrame`/`PendingAgentSuspension` types, the `isRunCheckpoint` guard (per-field shape plus the structural invariants: non-empty stack rooted at depth 0, strict parent chain by preserved id, and the suspension invariant below), and `createCheckpointRecorder`, the per-run recorder every engine frame reports into. Writes are suppressed while a handler invocation is on the stack, and frames are re-ordered by depth at write time.
- `source/executor/persistence.ts` — new leaves: `createWriteCheckpoint` (atomic temp+rename to `state.json`), `createDeleteCheckpoint`, `createReadRunCheckpointById`.
- `source/executor/role-registry.ts` — `register` takes an optional restored id (collision fails fast) and the registry is seedable (`createRoleRegistry(initialCounter)`) with a `counter()` accessor; restored registrations do not advance the counter, so post-resume spawns mint non-colliding ids.
- `source/executor/context-pressure.ts` — `createContextPressureTracker` accepts an optional initial ceiling so a resumed run keeps its learned wall knowledge.
- `source/executor/engine.ts` — `EngineDependencies` gains `checkpointRecorder`. `dispatchAndRecord` split into dispatch + `recordToolResult` (the resume path reuses the record half); `dispatchToolCallSequence` shares the pending-tracking dispatch loop between the live and resumed paths. `runRole` takes an optional `ResumedRole` (preserved id, role state, plan marks, suspended turn); resumed roles skip `role_start`. `resumeRoleStack` re-enters the checkpoint stack; a pending frame's child card resolves lazily from inside the parent's suspended turn (`completeSuspendedTurn`), which also mirrors the live role_finished checkpoint before recording the card. The safe-point write lands after drain/compaction/pressure-notice application, before the budget checks.
- `source/executor/executor.ts` — `ExecutorDependencies` gains `writeCheckpoint`/`deleteCheckpoint`; shared `buildEngineDependencies` creates the registry (seeded on resume), tracker (seeded on resume), and recorder; `resumeExecutor` re-enters a checkpoint under its original run id (re-asserts the running meta with the original start time, logs `run_resumed`, terminal meta, checkpoint deletion); `runExecutor` deletes the checkpoint after the terminal meta.
- `source/executor/run-submission.ts` — `resumeRun` dependency + `resume(checkpoint)`: the resumed run takes the active slot under its original id through the same one-at-a-time machinery (shared `track` helper); resume while active throws.
- `source/executor/startup-reconciliation.ts` (new) — `reconcileRunsOnStartup`: scans the runs directory, resumes the most recent run that has a running/absent meta and a valid run-id-matching checkpoint, and writes terminal `interrupted` metas (preserving existing meta fields; honest placeholders when the meta never landed) for everything else mid-flight.
- `source/executor/types.ts` / `validation.ts` — `RunMeta['status']` gains `'interrupted'`; `isRunMeta` accepts it.
- Web layer — `app.js` status label, `interaction-model.js` terminal set + typedef, `interaction-model-adapter.ts` status passthrough, `scenarios.js` typedef, `result-modal.js` (interrupted renders error-toned with the reconciliation's error message), `flow-view.js` CTA + now-caption, `demo.js` descriptor, `styles.css` status colors.
- `source/serve.ts` — per-run bindings factored into `withRunBindings` (shared by `createStartRun` and the new `createResumeRun`); reconciliation runs before the server accepts submissions and logs its decisions; the shutdown comment now states a timed-out run resumes on next startup.
- Tests — new `checkpoint.test.ts` (guard + recorder, incl. suppression and leaf-first ordering), `startup-reconciliation.test.ts`; extended `engine.test.ts` (checkpoint capture, leaf resume equals uninterrupted result, recorded-card resume without child re-run, post-resume id minting; the in-memory sink re-validates every write against the guard), `executor.test.ts` (resumeExecutor meta/identity/start-time preservation, seeded registry, checkpoint deletion), `run-submission.test.ts` (resume lifecycle), `server.test.ts` (interrupted in run view/list/flow model; resume through the submission; 409 while resumed-active).
- `docs/reference.md` — new "Run persistence and resumption" section (checkpoint contents, write timing, resume, reconciliation, caveats); updated graceful-shutdown, lifecycle, persistence layout, error table, and the `run_resumed` log event.

Deviations from the plan wording (authoritative):

- **The plan said the checkpoint is atomic "the same pattern `meta.json` uses", but `meta.json` is not atomic in the current code.** `state.json` uses the temp+rename pattern `settings.json` uses; `meta.json` was left unchanged (a torn meta read already reconciles to `interrupted`, which is honest).
- **Checkpoint writes are suppressed while a handler invocation (loop-check or context handler) is on the stack** — a refinement the plan did not specify. This makes a handler interlude checkpoint-atomic: either it completes and the post-drain write captures its effects, or the resume re-runs the drain from the pre-interlude checkpoint (persisted watermarks/`contextCompactionPending` make that converge; one in-flight loop check may be skipped).
- **The suspension invariant is richer than "parents hold a pending call".** The role_finished checkpoint has a single (leaf) frame carrying the pending turn with the child's recorded card; the guard validates: non-leaf ⇒ pending without a card; leaf ⇒ no pending, or pending with a recorded card.
- **Resume registers root-first via lazy child-card resolution**, not children-before-parents: `resolveChildCard` is invoked from inside the parent's suspended turn, so registration order and mid-resume checkpoints match live execution (the initial implementation resolved children first and produced invalid single-frame-deep checkpoints mid-resume — caught by the recorder's own guard in the test sink).
- **Resumed roles do not re-emit `role_start`; a `run_resumed` event marks the restart boundary** — the plan did not specify either. This keeps the role_start/role_finished pairing intact across a restart (verified in the smoke test's log).
- **The registry gained counter seeding and fixed-id registration** to preserve instance ids across restart (the plan's "faithful resume" required it for history id references and log linkage).
- **`interruptTriggers`/`contextHandlerRole` handler frames never appear in checkpoints** (consequence of the suppression above) — a resumed run re-runs the drain instead of resuming mid-handler.

Smoke test (in-environment, local Ollama `qwen3.5:9b`, throwaway workspace, guild model temporarily repointed and restored): a run descending orchestrator→coder→review chains was SIGKILLed mid-flight; on restart the service logged `Resumed run … from its checkpoint`, the run completed `success` with its artifact, `state.json` was deleted, `run_resumed` marked the boundary, no `role_start` was re-emitted, and post-restart `role_finished` events carried the preserved ids. A planted run with a log but no meta/checkpoint was marked `interrupted` with the reconciliation error. An idle SIGTERM exited cleanly. The Docker-specific handoff (`docker stop`/`docker kill`) remains with the operator.

End-of-step evaluation: the checkpoint is atomic (a torn write reconciles to `interrupted`, covered by the corrupt-checkpoint test); budget accumulators are preserved (asserted in the engine resume test; the learned ceiling and registry counter are seeded on resume); the single-active-run invariant holds at startup (reconciliation resumes at most one); `runRole`'s fresh-start path is unchanged (all 800 tests green, `resumed === undefined` behaves byte-for-byte as before apart from the additive checkpointing); no `as` casts anywhere — the reconstructed `RoleState` is validated by `isRunCheckpoint` before use, and malformed test values are built through unknown-typed builders rather than casts.

No new technical debt introduced.
