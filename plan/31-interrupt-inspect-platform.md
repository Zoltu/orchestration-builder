# Step 31 — Interrupt & agent-inspection platform (with loop-detector agent)

## Goal

Build two generalized tool families that let the Guild define agents which interrupt running work and inspect other agents' activity — without tying the mechanism to any one agent. The first use-case and test case is a **loop-detector agent** that watches a running role for stuck patterns (consecutive identical tool calls, and LLM-judged reasoning repetition) and intervenes. This step also absorbs the planned run-interrupt channel (formerly steps 30–31): the operator/API interrupt becomes another trigger source on the same queue, so the inquiry and plan-modification halves are handler prompts, not separate mechanisms.

The platform is the deliverable; the loop detector proves it works. Other interrupt-use agents (on-task drift checks, post-hoc reviewers of a finished agent's work) are the same tools with different prompts — no new executor code per use case.

## Context

Read [`26-budget-cleanup.md`](26-budget-cleanup.md) (the accepted gap this step closes: no in-band stuck/runaway detection), [`13-long-running-service-mode.md`](13-long-running-service-mode.md) (the single-active-run service the interrupt channel lives in), [`10-web-human-backend.md`](10-web-human-backend.md) (the existing pause/resume shape — `ask_human` parks a role on a promise, the model for suspension), [`engine.ts`](../source/executor/engine.ts) (`executeRoleLoop`'s `while(true)` — the synchronous turn-by-turn loop where suspension must insert; `runRole`'s `RoleState` closure; the `spawnAgent` recursion), [`executor.ts`](../source/executor/executor.ts) (run-level assembly — where the registry and interrupt queue are created), [`builtin-tools.ts`](../source/executor/builtin-tools.ts) (the pattern for built-in tools that close over run state — `context_info`/`edit_context`), and [`types.ts`](../source/executor/types.ts). Read the tracked-debt rows "Signal handler abandons the active run" (this step's interrupt queue is the safe-stop channel step 33 needs) and "Cross-role context compaction is not supported" (this step's read primitive is the read-half owner; the write half is step 32).

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
- **Read-only for the overseer now; cross-role write half (compaction) in step 32.** This step builds the registry + read tools. Step 32 adds a cross-role `edit_context` write primitive so `context_manager` can compact another role's conversation, closing the step-25 compaction debt. Keeps this step scoped.
- **Triggers (v1): every N tool calls, every N generated tokens, and the operator/API interrupt.** Thresholds configurable in `guild.json` executor config, effort-scaled (high effort checks less often, consistent with "work hard at high effort"). A self-requested check-in tool was rejected (a stuck model will not call it).

## Deliverables

### Engine core

1. **Role-instance registry.** `source/executor/engine.ts` / `source/executor/executor.ts` — `runRole` generates a stable role-instance id (e.g. `${roleName}-${depth}-${counter}`), registers its `roleState` in a run-level registry (created in `runExecutor`, threaded via `EngineDependencies`), logs the id in `role_start` (additive field), and unregisters on `role_finished`. Replaces name-only identification so multiple coder instances are distinguishable and targetable. `spawnAgent` and the engine-trigger invocation pass ids. The registry is a plain `Map<roleId, RoleState>` held in run state; not persisted (step 33 adds persistence).
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

13. `source/serve.ts` (extend) — on `SIGINT`/`SIGTERM` with an active run, submit an inquiry interrupt asking the run to wind down, await under a short bounded timeout, then exit. If the timeout elapses, force-exit as today. (The full debt — checkpoint so the next startup resumes — closes in step 33; this step delivers the bounded-graceful drain the interrupt queue enables.)

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

- [x] `bun run typecheck` and `bun test source/` pass, including `role-inspection.test.ts`, the extended engine tests, and the seed-guild conformance.
- [x] A role making consecutive identical tool calls triggers the loop-detector handler, which intervenes (`redirect` or `abort`), logged as an `interrupt` event.
- [x] A reasoning-loop fixture triggers the handler via `search_role_blocks`/`read_message_window` (the handler never receives the full reasoning in its prompt — only the windows it requests).
- [x] An operator inquiry interrupt injects a marked user message at the next safe point, is logged, and the run resumes.
- [x] A plan-mod interrupt aborts a descendant role and its intermediates, delivers the modification to the top-level planner, and the run resumes from the planner.
- [x] The drain happens between iterations, not during an in-flight LLM call.
- [x] An interrupt to a non-active or terminal run is rejected (`409`).
- [x] The inspect tools never return a full message's content/reasoning — only bounded windows and capped search matches.
- [x] The "No in-band stuck/runaway detection" debt row (step 26) is removed from `plan/README.md`.
- [x] No `as` casts; external input (interrupt bodies, inspect tool args) is validated with type guards.

## End-of-step evaluation

Confirm the platform is agent-agnostic: the loop detector is one guild role, and swapping its prompt for an on-task checker requires no executor change. Confirm the inspect tools are bounded — re-read each tool and confirm no path returns a full message's content or reasoning (only windows/capped matches). Confirm the drain point is the only place the engine checks for interrupts (one safe point). Confirm the abort-to-planner path reuses the existing `agent`-call unwind rather than a parallel control-flow mechanism. Confirm the handler is a normal guild role with a normal `finish` (no special return contract; the action flows through `trigger_interrupt`). Confirm the cross-role compaction debt row is updated to point at this step as the read-half owner. Re-read the engine loop and confirm the interrupt path cannot deadlock (an interrupt that itself triggers an `ask_human` must still resolve — the two pause mechanisms are independent).

## Tracked technical debt

- **Cross-role context compaction write half.** This step lands the read primitive (registry + inspect tools). The write half — a cross-role `edit_context` so `context_manager` can compact another role's conversation — is step 32. Update the existing "Cross-role context compaction" debt row: the read half is now owned by step 31; the write half is owned by step 32, which removes the row.
- **Run persistence (step 33).** The interrupt queue's safe-point drain is the checkpoint trigger step 33 needs; this step delivers the drain, step 33 adds the checkpoint. The "Signal handler abandons the active run" debt is partially closed by this step's graceful drain (Deliverable 13) and fully closed by step 33's checkpoint-on-exit.

## Estimated effort

Large — the role-instance registry threads through the engine and executor; suspension in the synchronous loop needs care; the inspect tools are a new tool family with pure logic to test; the abort-to-planner propagation interacts with the depth-first unwind. The loop-detector agent and the inquiry/plan-mod handlers are prompt work on top. Budget for a design pass with the operator on the registry id scheme and the interrupt-queue/`ask_human` interaction before implementing.

## Operator handoff

Run a service session and exercise all three trigger paths: (1) a stuck role (scripted or real) that loops on identical tool calls — confirm the loop detector intervenes and the run recovers or aborts cleanly; (2) an inquiry interrupt mid-run — confirm the active role acknowledges and answers and the run continues; (3) a plan-modification interrupt on a multi-role task — confirm the active sub-role aborts, the planner receives the modification, and the run resumes from the planner's new plan. Report any deadlocks, lost state on abort-to-planner, or cases where the inspect tools return more than the bounded window. (Loop-detector and planner response quality depend on the prompts taught here — judge both the platform mechanics and the taught behavior.)

The in-environment portion of this handoff was exercised before closeout (see the closeout below): all three trigger paths ran live against the local Ollama model with a throwaway workspace. What remains for the operator is judgment of the taught prompts' *quality* over real tasks (does the detector abort real loops, does the planner integrate real modifications well) and the visual review of the interrupt form in the UI.

## Closeout (2026-07-25)

✅ complete (in-environment). `bun run typecheck` and `bun test source/` green (823 pass across 48 files). The step-26 debt row is removed from `plan/README.md`; the cross-role compaction row now reads "read half landed, write half is step 32"; the signal-handler row is scoped to step 33's checkpoint persistence.

### Live validation (local Ollama, throwaway workspace)

A real service session against `qwen3.6:35b-a3b-q4_K_M` exercised every trigger path:

- **Loop-check cadence.** A 12-file creation task at effort 0 crossed the 12-tool-call threshold: the `interrupt` event fired on `coder-1-2`, the real model running the `loop_detector` prompt investigated exactly as taught (`recent_role_tool_calls` → `list_role_messages` → a bounded `read_message_window` of reasoning), and correctly judged `continue` (12 `write_file` calls with *different* args are progress, not a loop) — then the run finished successfully. A second spontaneous check ran during the acceptance phase of the longer task.
- **Inquiry.** `POST /api/runs/:id/interrupt {kind:"inquiry"}` mid-run injected the marked user message into the active coder (`operator_inquiry` event logged; the marker visible in the role's subsequent `llm_call` sent list).
- **Plan modification.** Fired during the acceptance phase (chain `orchestrator→acceptance_lead→acceptance_reviewer`, no planner present): the reviewer and lead unwound with `interrupted` error cards at their own safe points, the orchestrator received the modification, re-delegated fresh work, and the run completed successfully — the final website was built to the *modified* brief. The 409 rejection for a terminal/unknown run also fired live (an interrupt posted seconds after a run completed).
- The graceful-shutdown drain (Deliverable 13) is implemented but was not exercised with an active run (the service was stopped while idle); its inquiry submission reuses the live-validated path.

### Deviations from the plan wording

- **Cadence triggers are evaluated in-loop, not queued.** The step's model pushes every trigger onto the per-run queue; the implementation evaluates the tool-call/token cadence directly in the draining role's own loop (watermarks on `RoleState`) and reserves the queue for external requests (operator API, shutdown). A queued cadence entry would go stale (its counts describe an old turn) and force dedup bookkeeping; direct evaluation cannot. The drain order is: marks set by an earlier routing → cadence → one queued operator request.
- **Inquiry and plan-modification are engine routing + role prompts, not handler-role invocations.** The step's "both are handler-role invocations" reads as a separate handler role per kind; the implementation injects the inquiry directly into the active role (the answer arrives in its next response — a handler round-trip would add nothing) and routes the plan modification through registry marks (`planAbort`/`planInjection`) that unwind through the existing `agent`-call error-card propagation. That is the step's own "handler prompts + engine routing, not separate mechanisms": the behaviors live in the orchestrator/planner prompts (Deliverable 12), no parallel machinery exists.
- **The plan owner is configurable (`executor.interruptTriggers.planOwnerRole`) with a chain-root fallback**, rather than a hard-coded "planner". The rootmost live chain instance of the configured role receives the modification; when it is unset or absent from the chain (validated live: the acceptance phase has no planner), the modification goes to the root entry role, whose prompt teaches the same integration.
- **The `interrupt` log event is split across two events.** The step's single `interrupt {trigger, handler, action, target}` cannot carry the action before the handler finishes, and the interaction-model adapter needs the stack-push marker *before* the handler's `role_start` (an `interrupt` event with no following handler `role_start` strands a phantom stack — which is why inquiry/plan-mod log as `operator_inquiry`/`plan_modification` instead). The implementation logs `interrupt {trigger, handler, target}` at routing and `interrupt_resolved {trigger, handler, target, action}` after the handler; the action is also on the handler's `trigger_interrupt` tool_call event.
- **New `ErrorKind` `interrupted`** for plan-aborted roles (the step named only `loop_detected`); `recovery.md` teaches it (it is not a failure to retry — hand back to the plan owner) and the recovery conformance iterates it automatically.
- **`role_start`/`role_finished` carry `roleId`** (additive), so instance ids are recoverable from the log without the registry.
- **The interrupt form lives inside the run-summary panel** (rendered only while the selected run is the active one) rather than as a new grid panel — the wide-viewport grid is untouched. It carries the mode toggle, the plan-modification abort warning, and queued/sent/not-active notices; the poll surfaces `interruptPending` from `GET /api/runs/:id`.
- **Handler depth is clamped to `maxAgentDepth`** so a loop check at max depth cannot die on the depth budget; the handler otherwise runs at `target.depth + 1`.
- **`docs/reference.md`'s forward-looking `observe`/`terminate` entries were kept but corrected**: no current executor tool emits them (the inspection tools read the registry directly); the `interrupt` entry now documents the real payload.
- **The `coder` prompt was not taught the inquiry marker** (Deliverable 12 names only orchestrator/planner); the injected marker text is itself the instruction, and an inquiry to a mid-flight coder was answered correctly in the live run. If real tasks show coders fumbling inquiries, that teaching is a prompt-only follow-up.

### UI feedback round (2026-07-25, same day)

The operator's first UI test surfaced two gaps the curl-side validation had missed:

- **Inquiries were invisible.** The flow view has no "message injection" operation in its vocabulary, and forcing one in mislabels the visualization (a settled call pair would read as "handing the quest off"). The honest fix is a first-class **Interrupts section in the Run panel**: `deriveInterruptHistory` (`source/web/render.ts`) pairs each `operator_inquiry` with the recipient role's first content-bearing `llm_call` (the answer), marks inquiries whose role finished without answering as ended, and records plan modifications with their delivery target and abort count. `GET /api/runs/:id` carries the derived `interrupts` list (the `plan_modification` log event gained a `targetRole` name field for display); the panel renders questions as plain text and answers through the sanitized Markdown pipeline (`docs/security.md` surface inventory updated). The form's sent-notice now points at the list.
- **Roles didn't answer.** A live re-check caught an inquiry landing on `acceptance_lead`, which continued its loop and finished without answering — only three prompts taught the contract and the marker read as low-priority context. The engine's injected marker was made imperative and the four review-lead prompts gained the contract paragraph (both superseded by the routing round below). A second live check confirmed the loop end-to-end: the coder answered the inquiry three seconds after injection and the run view paired it.

### Routing & visualization round (2026-07-26)

The operator's next UI review set two design corrections, both implemented and live-verified:

- **Inquiries route to the chain root, not the active leaf.** `routeOperatorInterrupt` now injects the marked message into the entry role's history; the leaf keeps working undisturbed and the entry role answers when control next returns to it — from its run-wide knowledge, or by delegating to a fresh sub-agent first when the answer needs detail from in-flight work (the orchestrator prompt teaches this; the leaf-role inquiry teaching from the previous round was reverted as dead). The engine's marker text is addressed to the entry role accordingly.
- **Question interrupts are first-class in the visualization.** A new `inquiry` operation kind: the question (human→root role) stays `in_flight` (marching) until the recipient's first content-bearing `llm_call` settles it and emits the answer op (role→human, born settled); a role finishing without answering settles the question alone. Inquiry ops never enter call chains and never affect activity (the helpers skip them like observes). Both views render them as blue dashed reference lines (waiting questions march); the sequence view draws message rows, the inspector resolves their text via the new `inquiry` label templates in `guild.json` (`operationTemplates`/`genericOperationTemplates`, validation extended to require the kind). The `operator-inquiry` demo fixture drives the real adapter so the dev harness exercises the exact product path. Docs updated (`visualization.md` operation kinds, `reference.md` routing/events/API, `security.md` details-surface note).

Live verification against the local llama-server: an inquiry posted mid-run logged `operator_inquiry` on the orchestrator; the orchestrator answered 14s later with run-wide detail; `/api/runs/:id/flow` carried the question op (in-flight for those 14s) and the answer op; the run view paired them. All gates green: `bun run typecheck`, `bun test source/` (720 pass), and the operator's `bun run validate-data` gate (which now hosts the data-validity conformance moved out of `bun test` by the operator's own refactor — the 11 test-file deletions in the staged tree are that refactor's, and its `validate-data.ts` already covers this step's guild additions).

### End-of-step confirmation

The platform is agent-agnostic: the engine knows only the cadence config, the queue, the registry, and the tool mechanics — a new interrupt-use agent is a guild role with a different prompt and no executor change. Every inspection path is hard-bounded (window cap 8192 chars, match cap 25, index counts only, hash trace) — no path returns a full message's content or reasoning. `drainInterrupts` is the only interrupt check in the loop (one safe point, before budget checks). The abort-to-plan-owner path reuses the `agent`-call result-card unwind — marked roles return `interrupted` cards at their own safe points and the propagation does the rest. The handler is a normal guild role with a normal `finish`; the decision flows through `trigger_interrupt`, and a handler that finishes without deciding resumes the target unchanged (logged). No `as` casts in source; all external input (interrupt bodies, tool args) is validated with type guards. The interrupt path cannot deadlock on `ask_human`: the two pause mechanisms are independent (a handler that asks simply parks like any role; the operator queue waits for the target's next safe point while a handler runs, because handler invocations skip the drain).
