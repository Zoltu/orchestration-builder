# Step 31 — Interrupt & agent-inspection platform (with loop-detector agent)

## Goal

Build two generalized tool families that let the Guild define agents which interrupt running work and inspect other agents' activity — without tying the mechanism to any one agent. The first use-case and test case is a **loop-detector agent** that watches a running role for stuck patterns (consecutive identical tool calls, and LLM-judged reasoning repetition) and intervenes. This step also absorbs the planned run-interrupt channel (formerly steps 30–31): the operator/API interrupt becomes another trigger source on the same queue, so the inquiry and plan-modification halves are handler prompts, not separate mechanisms.

The platform is the deliverable; the loop detector proves it works. Other interrupt-use agents (on-task drift checks, post-hoc reviewers of a finished agent's work) are the same tools with different prompts — no new executor code per use case.

## Context

Read [`26-budget-cleanup.md`](26-budget-cleanup.md) (the accepted gap this step closes: no in-band stuck/runaway detection), [`13-long-running-service-mode.md`](13-long-running-service-mode.md) (the single-active-run service the interrupt channel lives in), [`10-web-human-backend.md`](10-web-human-backend.md) (the existing pause/resume shape — `ask_human` parks a role on a promise, the model for suspension), [`engine.ts`](../source/executor/engine.ts) (`executeRoleLoop`'s `while(true)` — the synchronous turn-by-turn loop where suspension must insert; `runRole`'s `RoleState` closure; the `spawnAgent` recursion), [`executor.ts`](../source/executor/executor.ts) (run-level assembly — where the registry and interrupt queue are created), [`builtin-tools.ts`](../source/executor/builtin-tools.ts) (the pattern for built-in tools that close over run state — `context_info`/`edit_context`), and [`types.ts`](../source/executor/types.ts). Read the tracked-debt rows "Signal handler abandons the active run" (this step's interrupt queue is the safe-stop channel step 32 needs) and "Cross-role context compaction is not supported" (this step's read primitive is the read-half owner; the write half is a later step).

### The core constraint: the engine is synchronous

`executeRoleLoop` is a `while(true)` of LLM-call → tool-dispatch turns. The only role that can be "interrupted" is the one currently executing. So an agent-triggered interrupt flows through the engine's turn boundary, not concurrently:

1. A **trigger** pushes an interrupt onto a per-run queue.
2. Between turns, the engine drains the queue: it **suspends** the active role (snapshots its `roleState`, keeps it registered under a stable role-instance id), and **invokes a guild-configured handler role** with a task describing the trigger + the target role id.
3. The handler inspects via the Family 2 tools and calls `trigger_interrupt(target, action, reason)`.
4. The engine applies the action (`continue`/`redirect`/`abort`) and resumes the target.

### Design decisions (operator-approved)

- **Generalized platform, not an overseer feature.** The trigger mechanism, the role-state registry, and the inspect tools are agent-agnostic. The loop detector is one guild role using them; a future on-task checker or post-hoc reviewer is another role with the same tools and a different prompt. No executor code per use case.
- **Loop detector handles both tool-call loops and reasoning loops.** Tool-call loops via `recent_role_tool_calls` (consecutive identical calls — the rule from step 26, now agent-judged so `compile → write_file → compile` is safe but `compile → compile → compile` is not). Reasoning loops via `search_role_blocks`/`read_message_window` — the LLM recognizes repetition a heuristic cannot, without the full 256k reasoning block in its prompt.
- **Inspect tools give bounded, windowed, searchable access to both `content` and `reasoning`** of a target role's history, never the full text. The overseer drives the investigation incrementally: search to find candidates, window-read to confirm, decide.
- **`trigger_interrupt` actions: `{continue, redirect, abort}`.** `redirect` injects a message into the target's history then resumes (the "nudge back on task" path); `abort` forces the target to finish with a `loop_detected` error card; `continue` resumes unchanged.
- **Absorb the run-interrupt channel (old 30–31).** The operator/API interrupt is another trigger source on the same queue. The inquiry half (pause, ask the active role, resume) and the plan-modification half (route to the top-level planner via abort-to-planner) are handler prompts + engine routing, not separate mechanisms. The abort-to-planner propagation reuses the existing `agent`-call result-card unwind.
- **Read-only for the overseer now; cross-role write half (compaction) later.** This step builds the registry + read tools. A later step adds a cross-role `edit_context` write primitive so `context_manager` can compact another role's conversation, closing the step-25 compaction debt. Keeps this step scoped.
- **Triggers (v1): every N tool calls, every N generated tokens, and the operator/API interrupt.** Thresholds configurable in `guild.json` executor config, effort-scaled (high effort checks less often, consistent with "work hard at high effort"). A self-requested check-in tool was rejected (a stuck model will not call it).

## Deliverables

### Engine core

1. **Role-instance registry.** `source/executor/engine.ts` / `source/executor/executor.ts` — `runRole` generates a stable role-instance id (e.g. `${roleName}-${depth}-${counter}`), registers its `roleState` in a run-level registry (created in `runExecutor`, threaded via `EngineDependencies`), logs the id in `role_start` (additive field), and unregisters on `role_finished`. Replaces name-only identification so multiple coder instances are distinguishable and targetable. `spawnAgent` and the engine-trigger invocation pass ids. The registry is a plain `Map<roleId, RoleState>` held in run state; not persisted (step 32 adds persistence).
2. **Interrupt queue + suspension.** `source/executor/run-state.ts` (extend) / a new interrupt state holder — a per-run queue: `submitInterrupt(runId, trigger)` parks the trigger. `source/executor/engine.ts` (extend) — at the top of each `executeRoleLoop` iteration (the safe point, before the next LLM call), drain the queue. On a pending interrupt: suspend the active role (state stays registered), invoke the configured handler role via `runRole` (recursive, `parent` = suspended role, task engine-generated from the trigger payload + target id), await its finish, apply the handler's last `trigger_interrupt` action, resume. Log an `interrupt` event `{ trigger, handler, action, target }`. The drain must not interrupt an in-flight LLM call; it runs between iterations (same safe-point contract old step 30 specified).
3. **Triggers.** `source/executor/engine.ts` — evaluate trigger conditions each turn: tool-call count modulo N, generated-token count modulo N. Push to the queue when crossed. The operator/API interrupt (Deliverable 7) pushes externally. N configurable in `guild.json` `executor.interruptTriggers` (new optional section), effort-scaled.

### Family 1 — interrupt trigger tool (built-in, registry-backed)

4. `source/executor/builtin-tools.ts` — `trigger_interrupt(targetRole, action, reason)` where `action ∈ {'continue','redirect','abort'}`. The handler closes over the registry: `redirect` injects a `user` message (the `reason`) into the target's `roleState.history` then marks resume; `abort` forces the target to finish with a `loop_detected` error card on its next turn; `continue` marks resume unchanged. The tool returns the action taken. Assigned to a handler role via `guild.json`.
5. `guild/tools/trigger_interrupt.json` — manifest. Parameters: `targetRole` (string, the role-instance id), `action` (enum), `reason` (string).

### Family 2 — agent-activity inspection tools (built-in, read-only, registry-backed)

6. `source/executor/builtin-tools.ts` — four read-only tools, all taking a target role-instance id:
   - `list_role_messages(targetRole)` — compact index: per-message `index`, `role`, `contentChars`, `reasoningChars`, `toolCallCount`.
   - `read_message_window(targetRole, index, field, start, end)` — a bounded char slice of one message's `content` or `reasoning` (the "spelunk without 256k in prompt" primitive). `field ∈ {'content','reasoning'}`.
   - `search_role_blocks(targetRole, { field, pattern, kind, maxMatches })` — substring/regex across all of a role's `content` or `reasoning`; returns match offsets + short surrounding windows (e.g. 256 chars), capped at `maxMatches`. `kind ∈ {'substring','regex'}`.
   - `recent_role_tool_calls(targetRole, limit)` — structured trace (tool names, arg hashes, result kinds) for the last `limit` tool calls.
   The search/window logic is pure (operates on a `RoleState` snapshot) and lives in a new `source/executor/role-inspection.ts` (testable in-memory); the built-in tool wrappers are thin leaves closing over the registry.
7. `guild/tools/{list_role_messages,read_message_window,search_role_blocks,recent_role_tool_calls}.json` — manifests.

### Loop-detector agent (the test case)

8. `guild/prompts/loop_detector.md` (new) — a guild role invoked by the engine triggers. Prompt: use `recent_role_tool_calls` to find consecutive identical calls (the rule from step 26, agent-judged) and `search_role_blocks`/`read_message_window` on reasoning to find LLM-recognized repetition. On a hit, call `trigger_interrupt(target, 'redirect'|'abort', reason)`. On no hit, call `trigger_interrupt(target, 'continue', '')`.
9. `guild/guild.json` — add the `loop_detector` role with Family 2 tools + `trigger_interrupt` + `finish`; add the new tool manifests to the `tools` list; configure `executor.interruptTriggers` (N tool calls, N tokens, effort-scaled). Wire the handler role reference in the executor config (which role the engine invokes on a trigger).

### Run-interrupt channel (absorbs old 30–31)

10. `source/web/server.ts` (extend) — `POST /api/runs/:id/interrupt` (body: `{ kind: 'inquiry' | 'plan_modification', message }`) submits an interrupt for the active run. Returns `202` if accepted, `409` if not active/terminal. `kind: 'inquiry'` injects as a user message to the active role (resume after response); `kind: 'plan_modification'` aborts the active leaf and intermediates up to the top-level planner (reusing the `agent`-call result-card unwind), then injects the modification to the planner. Both are handler-role invocations under the new platform (the inquiry/plan-mod behavior is a handler prompt + engine routing, not a parallel mechanism). `GET /api/runs/:id` exposes whether an interrupt is pending.
11. `source/web/static/app.js` (extend) — an interrupt input on the active-run view with a mode toggle (inquiry / plan-modification). Plan-mod submission warns that active sub-work will be aborted.
12. `guild/prompts/planner.md` and `guild/prompts/orchestrator.md` (extend) — teach the interrupt contract: how the entry role and planner recognize and acknowledge an inquiry marker, and how the planner integrates a plan-modification (decide restart-sub-task vs. continue vs. abort). The seed Guild (step 25) was written before this channel existed; this is the deferred revisit.

### Graceful shutdown (closes part of the step-13 debt)

13. `source/serve.ts` (extend) — on `SIGINT`/`SIGTERM` with an active run, submit an inquiry interrupt asking the run to wind down, await under a short bounded timeout, then exit. If the timeout elapses, force-exit as today. (The full debt — checkpoint so the next startup resumes — closes in step 32; this step delivers the bounded-graceful drain the interrupt queue enables.)

### Tests & docs

14. `source/executor/role-inspection.test.ts` (new) — pure tests for the search/window/index functions over a fixture `RoleState`: substring and regex matches return correct offsets + windows; window-read slices correctly at boundaries; the index reports accurate char counts; `maxMatches` caps results.
15. `source/executor/engine.test.ts` (extend) — in-memory tests with a scripted LLM: (a) a role making consecutive identical tool calls triggers the loop-detector handler, which calls `trigger_interrupt(target, 'abort')`, and the target finishes with `loop_detected`; (b) a reasoning-loop fixture triggers the handler via `search_role_blocks` and the handler redirects; (c) an operator inquiry interrupt injects a user message to the active role and the run resumes; (d) a plan-mod interrupt aborts a coder and delivers the modification to the top-level planner (multi-level descent: planner → coder → sub-coder); (e) the drain does not interrupt an in-flight LLM call; (f) an interrupt to a non-active/terminal run is rejected.
16. `source/executor/seed-guild.test.ts` (extend) — assert the new `loop_detector` role, its tool list, and the new manifests.
17. `docs/reference.md` — document: the role-instance registry and `role_start` id field; the interrupt queue and safe-point drain; the trigger conditions (N tool calls, N tokens, operator/API); the Family 1 and Family 2 tools; the `interrupt` log event; the `POST /api/runs/:id/interrupt` endpoint and its `kind`; the abort-to-planner propagation. Note that the loop detector is the first agent on the platform and that other interrupt-use agents are prompt-only additions.
18. `docs/security.md` — note that the inspect tools are read-only and bounded (no full-history exfiltration to a handler prompt; the handler sees only what it windows).

## Module boundaries

- The role-state registry is run-level state held in `runExecutor`'s closure, threaded via `EngineDependencies` (orchestration; tested with fakes).
- The interrupt queue is run state (orchestration); the drain point is in `executeRoleLoop` (one safe point, not scattered checks).
- The inspect tools' logic is pure (`role-inspection.ts`, testable); the built-in wrappers are thin leaves closing over the registry.
- `trigger_interrupt` is a built-in tool closing over the registry and the resume/abort control (orchestration).
- The HTTP endpoint is a thin leaf delegating to run state.
- The handler's behavior (loop detection, inquiry acknowledgment, plan-mod integration) is Guild prompt work, not engine behavior. The engine only invokes the handler and applies the action.
- The abort-to-planner propagation reuses the existing `agent`-call result-card unwind (a child returning an error card already unwinds to its parent); the new work is triggering that unwind from an external interrupt.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including `role-inspection.test.ts`, the extended engine tests, and the seed-guild conformance.
- [ ] A role making consecutive identical tool calls triggers the loop-detector handler, which intervenes (`redirect` or `abort`), logged as an `interrupt` event.
- [ ] A reasoning-loop fixture triggers the handler via `search_role_blocks`/`read_message_window` (the handler never receives the full reasoning in its prompt — only the windows it requests).
- [ ] An operator inquiry interrupt injects a marked user message at the next safe point, is logged, and the run resumes.
- [ ] A plan-mod interrupt aborts a descendant role and its intermediates, delivers the modification to the top-level planner, and the run resumes from the planner.
- [ ] The drain happens between iterations, not during an in-flight LLM call.
- [ ] An interrupt to a non-active or terminal run is rejected (`409`).
- [ ] The inspect tools never return a full message's content/reasoning — only bounded windows and capped search matches.
- [ ] The "No in-band stuck/runaway detection" debt row (step 26) is removed from `plan/README.md`.
- [ ] No `as` casts; external input (interrupt bodies, inspect tool args) is validated with type guards.

## End-of-step evaluation

Confirm the platform is agent-agnostic: the loop detector is one guild role, and swapping its prompt for an on-task checker requires no executor change. Confirm the inspect tools are bounded — re-read each tool and confirm no path returns a full message's content or reasoning (only windows/capped matches). Confirm the drain point is the only place the engine checks for interrupts (one safe point). Confirm the abort-to-planner path reuses the existing `agent`-call unwind rather than a parallel control-flow mechanism. Confirm the handler is a normal guild role with a normal `finish` (no special return contract; the action flows through `trigger_interrupt`). Confirm the cross-role compaction debt row is updated to point at this step as the read-half owner. Re-read the engine loop and confirm the interrupt path cannot deadlock (an interrupt that itself triggers an `ask_human` must still resolve — the two pause mechanisms are independent).

## Tracked technical debt

- **Cross-role context compaction write half.** This step lands the read primitive (registry + inspect tools). The write half — a cross-role `edit_context` so `context_manager` can compact another role's conversation — is a later step. Update the existing "Cross-role context compaction" debt row: the read half is now owned by step 31; the write half remains open. Remove the row when the write half lands.
- **Run persistence (step 32).** The interrupt queue's safe-point drain is the checkpoint trigger step 32 needs; this step delivers the drain, step 32 adds the checkpoint. The "Signal handler abandons the active run" debt is partially closed by this step's graceful drain (Deliverable 13) and fully closed by step 32's checkpoint-on-exit.

## Estimated effort

Large — the role-instance registry threads through the engine and executor; suspension in the synchronous loop needs care; the inspect tools are a new tool family with pure logic to test; the abort-to-planner propagation interacts with the depth-first unwind. The loop-detector agent and the inquiry/plan-mod handlers are prompt work on top. Budget for a design pass with the operator on the registry id scheme and the interrupt-queue/`ask_human` interaction before implementing.

## Operator handoff

Run a service session and exercise all three trigger paths: (1) a stuck role (scripted or real) that loops on identical tool calls — confirm the loop detector intervenes and the run recovers or aborts cleanly; (2) an inquiry interrupt mid-run — confirm the active role acknowledges and answers and the run continues; (3) a plan-modification interrupt on a multi-role task — confirm the active sub-role aborts, the planner receives the modification, and the run resumes from the planner's new plan. Report any deadlocks, lost state on abort-to-planner, or cases where the inspect tools return more than the bounded window. (Loop-detector and planner response quality depend on the prompts taught here — judge both the platform mechanics and the taught behavior.)
