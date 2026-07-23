# Step 32 — Cross-role context compaction (write half)

## Goal

Give `context_manager` the ability to compact **another role's** conversation, closing the step-25 cross-role compaction debt. Today `edit_context` mutates only the caller's own message list, so a `context_manager` spawned as a fresh child has nothing to compact, and a role that overflows its context window can only finish with `context_budget_exceeded` and be re-delegated in smaller pieces — re-reading files and wasting tokens. This step adds the write half: a context-pressure trigger on the step-31 interrupt platform that suspends the active role at a safe point and invokes `context_manager` to compact that role's history in place, after which the role resumes with the shortened conversation and never overflows.

## Context

Read [`31-interrupt-inspect-platform.md`](31-interrupt-inspect-platform.md) in full — this step is a direct extension of that platform: the role-instance registry, the per-run interrupt queue with the safe-point drain in `executeRoleLoop`, the `trigger → suspend → invoke handler → resume` flow, and the Family 2 read-only inspect tools (`list_role_messages` / `read_message_window` / `search_role_blocks`) are its deliverables. The read half is step 31; this step is the write half and must land before the Foundry (step 35), which would otherwise optimize a compaction strategy against a broken mechanism.

Read the tracked-debt row "Cross-role context compaction is not supported" in [`README.md`](README.md) (this step removes the row), the step-25 closeout in [`25-seed-guild-buildout.md`](25-seed-guild-buildout.md) (the deviation that recorded the limitation), `source/executor/builtin-tools.ts` (the current self-only `edit_context` and `context_info`), `source/executor/engine.ts` (`RoleState`, the drain point), and `source/executor/context-policy.ts` (`stripReasoning` — the existing pure history-mutation helper the cross-role path should reuse).

Key facts that shape the design:

- **Only a suspended role can be compacted.** The engine is synchronous: while `context_manager` runs (as the interrupt handler at the drain point), the target role is suspended mid-loop with its `RoleState` registered. Mutating the target's history is safe exactly in that window. A role that has already *finished* (including one that finished with `context_budget_exceeded`) is unregistered and cannot be compacted — the reactive path for actual overflows stays finish-and-re-delegate-in-smaller-pieces (unchanged; see `recovery.md`).
- **Compaction is therefore proactive.** A context-pressure trigger fires when the active role's estimated prompt tokens cross a configurable fraction of the model's context window — before the endpoint rejects the request. The existing `context_budget_exceeded` handling remains as the backstop when compaction cannot keep up (a single enormous tool result, a threshold set too high).
- **`context_manager`'s prompt must be rewritten, not patched.** Its current prompt teaches "you cannot reach another role's conversation" — exactly what this step changes.

## Deliverables

1. **Cross-role `edit_context`.** `source/executor/builtin-tools.ts` (extend) — `edit_context` accepts an optional `targetRole` (a role-instance id). When present, the validated operations apply to the target's `roleState.history` via the registry instead of the caller's own list. Rules: the target must be a registered role instance; the target must not be the caller's own active role (self-edits stay the no-`targetRole` path); the same operation validation holds (never drop or alter message index 0 (system) or index 1 (user task); ranges in bounds; at least one operation). When `targetRole` is absent, behavior is byte-for-byte today's. Unknown target → `invalid_arguments`; unregistered target → a clear tool error. Also extend `context_info` with the same optional `targetRole` so the handler can measure the target before and after.
2. **Context-pressure trigger.** `source/executor/engine.ts` (extend) — each turn, after token accounting, estimate the active role's prompt tokens (the existing estimator) and push a `context_pressure` trigger onto the interrupt queue when the estimate crosses `executor.contextPressureThreshold` × the model's `contextWindow` (new optional config in `guild.json`, a fraction such as `0.8`; the trigger is inert when unset). At the drain, the suspended active role is handed to the configured handler with the trigger payload (same flow as the operator/API interrupt in step 31), and resumed after the handler finishes. Fire at most once per crossing — re-arm only after the estimate falls back below the threshold, so a handler that fails to shrink the history does not re-trigger every turn (the existing `compaction_failed` guard still applies to the handler itself).
3. **Guild wiring.** `guild/guild.json` — give `context_manager` the Family 2 inspect tools (`list_role_messages`, `read_message_window`, `search_role_blocks`) alongside its existing `context_info`/`edit_context`/`finish`; set `executor.contextPressureThreshold`; point the `context_pressure` trigger's handler at `context_manager` (reusing step 31's handler-wiring config). Update `source/executor/seed-guild.test.ts` (the `context_manager` tool list).
4. **`guild/prompts/context_manager.md` (rewrite).** The role now compacts a *target* role's conversation: it is invoked with the target role-instance id, inspects the target's history with the Family 2 tools (never receiving the full history in its own prompt), decides what to drop/strip/replace, applies operations with cross-role `edit_context`, and confirms the reduction with cross-role `context_info` before finishing. Preserve always: the target's system prompt, its original task, and its most recent reasoning and tool results. Keep the existing anti-loop guidance (confirm the token count decreased; stop once it fits).
5. **`guild/prompts/orchestrator.md` and `guild/prompts/recovery.md` (small updates).** Remove the now-true-but-stale statements that `context_manager` "can only compact the conversation it is itself running in." The reactive `context_budget_exceeded` guidance (finish, then re-delegate the step in smaller pieces) stays — it is the backstop for overflows proactive compaction did not prevent. Do not teach the orchestrator to delegate compaction for an already-finished role; a finished role cannot be compacted.
6. **Tests.** `source/executor/builtin-tools.test.ts` (extend) — cross-role `edit_context`/`context_info`: operations apply to the target's history, index 0/1 protection holds, unknown/unregistered target errors, absent `targetRole` is unchanged. `source/executor/engine.test.ts` (extend) — with a scripted LLM: a role whose history crosses the pressure threshold triggers the `context_manager` handler, the handler compacts, and the role resumes and completes with a shorter history; a trigger below the threshold does not fire; a handler that fails to reduce tokens does not re-trigger on the very next turn (re-arm rule).
7. **Docs and debt.** `docs/reference.md` — document the cross-role `targetRole` parameter, the context-pressure trigger and its threshold config, and the suspend-compact-resume flow. Remove the "Cross-role context compaction is not supported" debt row from `plan/README.md`.

## Module boundaries

- The cross-role edit primitive lives in the existing built-in tool factory, closing over the registry (step 31); operation validation is shared with the self-edit path — one validator, not two.
- History-mutation logic stays pure (`context-policy.ts` and friends operate on a `Message[]`); the built-in wrapper is a thin leaf that resolves the target `RoleState` from the registry.
- The trigger evaluation is engine orchestration at the single existing drain point — no second interrupt queue, no new safe points.
- The compaction *strategy* (what to drop, strip, replace) is Guild prompt work, not engine behavior — the Foundry will optimize it later.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the new built-in and engine tests and the updated seed-guild conformance.
- [ ] A role approaching the context window is suspended at the safe point, compacted by `context_manager`, and resumed; the run completes without `context_budget_exceeded`, and the compaction is visible in the log events.
- [ ] `edit_context` without `targetRole` behaves exactly as before (no regression in the self-compaction path).
- [ ] A finished role cannot be targeted (its instance is unregistered); the tool returns a clear error, and the reactive re-delegation path in `recovery.md` is unchanged.
- [ ] The "Cross-role context compaction is not supported" debt row is removed from `plan/README.md`.
- [ ] No `as` casts; tool arguments are validated with type guards.

## End-of-step evaluation

Confirm the write path reuses step 31's drain rather than adding a second suspension mechanism. Confirm the threshold trigger cannot storm (re-arm rule) and cannot fire during an in-flight LLM call. Re-read `context_manager.md` against `recovery.md`/`orchestrator.md` for contradictions about who can compact what. Confirm the validator for cross-role operations is the same function the self-edit path uses. Confirm the estimated-token trigger uses the same estimator the engine's token accounting already trusts, not a second estimator.

## Estimated effort

Medium — the platform pieces (registry, drain, inspect tools) land in step 31; this step adds one tool parameter, one trigger condition, guild wiring, a prompt rewrite, and tests. Budget for a design pass with the operator on the threshold default and the re-arm rule.

## Operator handoff

Run a long-horizon task against the local model with a deliberately low `contextPressureThreshold` and confirm: the pressure trigger fires mid-run, `context_manager` compacts the active role, the role resumes and completes, and the UI's flow view shows the interrupt/compaction interlude legibly. Then run with the production threshold and confirm no premature triggers. Judge both the mechanics and the quality of `context_manager`'s compaction choices (did it drop something the role later needed?).
