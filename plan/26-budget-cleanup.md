# Step 26 — Budget cleanup: remove cumulative caps and deterministic loop detection

## Goal

Remove the executor's hard cumulative caps (`maxToolCallsPerRole`, `maxTokensPerRole`, `maxRunTimeSeconds`) and its deterministic consecutive-duplicate loop detection, so agents can work as long and as hard as the task requires. Context-window overflow is already handled by the existing endpoint → `context_budget_exceeded` → recovery path; the removed caps were a blunt, redundant guardrail that fired on healthy long-horizon work (a 200k cumulative budget with ~32k-prompt turns expires after ~6 turns, long before the window is full). Run termination becomes the deployment container's responsibility (`docker stop` / orchestrator timeout as the outer defense), with a proper in-band overseer/interrupt mechanism arriving in step 31. This step also loosens the tight `2048` per-role generation caps so roles inherit the model's `maxTokens` and can emit full delegations and rationales.

This step **does not** replace the removed loop detection with anything — step 31 lands a loop-detector agent built on the new interrupt/inspect platform. Between step 26 and step 31 there is no in-band stuck detection; a runaway that does not overflow context runs until the operator stops the container. This is an accepted, short-lived gap, chosen because the deterministic check being removed was both too blunt (fired on healthy repetition like `compile → write_file → compile` is fine, but `compile → compile → compile` is not — yet it could not tell productive repetition from a stuck loop) and because modern models loop far less than the small models the seed values were tuned for.

## Context

Read [`budgets.ts`](../source/executor/budgets.ts) (`checkRoleBudgets`/`checkGlobalBudgets` — the three bundled checks), [`engine.ts`](../source/executor/engine.ts) (where `promptTokens += usage.promptTokens` each turn makes `maxTokensPerRole` a *cumulative* sum, not a context-window-occupancy check; and `recentToolCalls` which only feeds the deleted loop check), [`llm.ts`](../source/executor/llm.ts) (`detectContextBudgetExceeded` — the real context-window guardrail, via the endpoint's HTTP 400), [`builtin-tools.ts`](../source/executor/builtin-tools.ts) (`validateAgentArgs` — the `agent` tool's `budget` parameter), [`types.ts`](../source/executor/types.ts) (`ExecutorConfig`, `RoleBudget`, `ErrorKind`), and [`validation.ts`](../source/executor/validation.ts) (the guards for the removed fields). Read [`25-seed-guild-buildout.md`](25-seed-guild-buildout.md) and `guild/guild.json` (the `2048` generation caps and the executor-config fields being removed).

### Design decisions (operator-approved)

- **Delete the cumulative caps entirely** (not "optional, unlimited default"). `maxToolCallsPerRole`, `maxTokensPerRole`, `maxRunTimeSeconds` are removed from `ExecutorConfig`, the validators, and all fixtures. Cleaner end state; no dead optional fields. The context window and per-turn `maxTokens` are LLM-runtime-enforced limits and suffice.
- **Delete `maxRepeatedToolCalls` and the deterministic loop check now.** Step 31's loop-detector agent (built on the interrupt/inspect platform) replaces it. Keeping a deterministic pre-filter alongside the agent was rejected as redundant and prone to double-flagging. Accepted gap until step 31.
- **Delete `maxRunTimeSeconds`.** Wall-clock is hardware-dependent (1 tps vs 15 000 tps) — a fixed value either fires on healthy slow-hardware runs or never fires on fast hardware. Run termination is the deployment container's job; document this in `docs/reference.md` and `docs/architecture.md` ("Deployment" → "Run termination"). The accepted gap (no in-band runaway termination until step 31) is the same gap as the loop-detection removal.
- **Remove the `agent` tool's `budget` parameter.** `RoleBudget` exists only to override the two deleted global caps, so it has no remaining purpose. Removing it drops `validateAgentArgs`'s budget validation, the `budget` field in `agent.json`, and `cloneRoleDefinitionWithBudget` in `engine.ts`.
- **Remove all per-role `generation.maxTokens: 2048` overrides** in `guild.json` (orchestrator, context_manager, recovery) so every role inherits `model.generation.maxTokens`. The context manager self-limits via its own output (compacting 256k → 50k is a big win and well worth the tokens); defensively capping it loses that. Modern models do not loop enough to justify preemptive output caps.
- **Keep `maxAgentDepth`, `maxCompactionAttempts`, `defaultToolTimeoutSeconds`.** Depth guards unbounded recursion (distinct from "stuck" looping). Compaction-progress guards a context_manager that cannot reduce tokens. Tool timeout guards a hung subprocess.
- **Keep `ErrorKind` entries.** `loop_detected` stays (step 31's agent emits it); `tool_budget_exceeded` stays (depth still uses it); `token_budget_exceeded` is removed (no emitter remains after the cumulative cap is gone).

## Deliverables

1. `source/executor/types.ts` — remove `maxToolCallsPerRole`, `maxTokensPerRole`, `maxRunTimeSeconds`, `maxRepeatedToolCalls` from `ExecutorConfig`. Remove `RoleBudget` and `RoleDefinition.budget`. Remove `'token_budget_exceeded'` from `ErrorKind`.
2. `source/executor/validation.ts` — remove the `isNumber` checks for the four deleted `ExecutorConfig` fields from `isExecutorConfig` and `validateExecutorConfig`. Remove `isRoleBudget` and the `validateRoleBudget` call from `validateRoleDefinition`.
3. `source/executor/budgets.ts` — `checkRoleBudgets` keeps **only** the compaction-progress check (the `recentCompactionPromptTokens` logic); delete the tool-call-count, total-token, and consecutive-duplicate loop checks. `checkGlobalBudgets` keeps **only** depth; delete the wall-clock check. `RoleBudgetState` loses `recentToolCalls` (only fed the deleted loop check).
4. `source/executor/engine.ts` — remove `recentToolCalls` from `RoleState` and its tracking in `dispatchAndRecord` (the `argsHash`/push/shift block). Remove `cloneRoleDefinitionWithBudget` and the `roleDefinitionOverride` budget-clone path in `spawnAgent` (a child runs its parent's definition; no budget override). Remove `roleDefinition.budget` from `checkRoleBudgets` call sites.
5. `source/executor/builtin-tools.ts` — `validateAgentArgs` drops the `budget` parsing/validation; returns `{ roleName, task }` only. The `agent` handler calls `spawnAgent(roleName, task)` with no budget.
6. `guild/tools/agent.json` — remove the `budget` property from the manifest's `parameters.properties`.
7. `guild/guild.json` — remove `maxToolCallsPerRole`, `maxTokensPerRole`, `maxRunTimeSeconds`, `maxRepeatedToolCalls` from `executor`. Remove the `generation` override on `orchestrator`, `context_manager`, and `recovery` (all roles inherit `model.generation`).
8. `guild/prompts/recovery.md` — drop the `token_budget_exceeded` guidance. Keep `loop_detected` (still valid; step 31 emits it), `context_budget_exceeded`, `tool_budget_exceeded` (now depth-only), `timeout`, `llm_unavailable`, `compaction_failed`, `invalid_tool_call`, `invalid_arguments`, `unknown_tool`.
9. `docs/reference.md` — update the executor-config field table (the four removed fields), the error-kind table (`token_budget_exceeded` removed), and add a note that run termination is the deployment container's responsibility (no executor wall-clock); a proper in-band overseer lands in step 31.
10. `docs/architecture.md` ("Deployment" → "Run termination") — add/confirm the note that the container's own kill/timeout (`docker stop`, orchestrator `--timeout`) is the outer run-termination boundary, since the executor no longer enforces wall-clock.
11. Tests/fixtures — mechanically remove the deleted fields from every `ExecutorConfig` literal: `validation.test.ts`, `budgets.test.ts`, `engine.test.ts`, `executor.test.ts`, `builtin-tools.test.ts`, `server.test.ts`, `render.test.ts`. Update `seed-guild.test.ts` (drop the `maxToolCallsPerRole >= 50` and `maxRunTimeSeconds >= 3600` assertions; the fields no longer exist). Rewrite `budgets.test.ts` to cover depth-only (`checkGlobalBudgets`) and compaction-progress-only (`checkRoleBudgets`). Remove `budget` from the `agent`-tool tests in `builtin-tools.test.ts`. Remove the `token_budget_exceeded` and consecutive-dup `loop_detected` engine tests (the emitters are gone); keep the depth `tool_budget_exceeded` test.

## Module boundaries

- `budgets.ts` stays pure orchestration (testable in-memory); it just does less.
- No new leaf functions. No new tools.
- The Guild change (removing generation overrides) is a pure config edit; no prompt rewrite beyond the `recovery.md` `token_budget_exceeded` removal.
- `docs/reference.md` and `docs/architecture.md` ("Deployment" → "Run termination") are the only docs touched.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass with the removed fields and rewritten tests.
- [ ] `guild.json` loads (loader validates); the seed-guild conformance test passes against the trimmed config.
- [ ] No `token_budget_exceeded` emitter remains; no `as` casts introduced.
- [ ] `docs/reference.md` no longer lists the four removed executor-config fields or `token_budget_exceeded`; it documents run termination as the deployment container's job (`docs/architecture.md` "Run termination").
- [ ] The `agent` tool accepts `{ role, task }` only (no `budget`); `agent.json`'s manifest has no `budget` property.

## End-of-step evaluation

Confirm `maxTokensPerRole` is gone everywhere (it was the conceptual bug — a cumulative sum masquerading as a context-window cap; the real context-window guardrail is the endpoint's `context_budget_exceeded`, unchanged). Confirm `recentToolCalls`/`argsHash` tracking is fully removed (no dead state left feeding nothing). Confirm `checkRoleBudgets` and `checkGlobalBudgets` each retain exactly one check (compaction-progress and depth respectively). Re-read `recovery.md` and confirm it no longer references `token_budget_exceeded` but still covers every remaining `ErrorKind`. Confirm the accepted gap (no in-band stuck/runaway detection until step 31) is recorded in the tracked-debt table.

## Tracked technical debt introduced

- **No in-band stuck/runaway detection between step 26 and step 31.** Removing `maxRepeatedToolCalls` and `maxRunTimeSeconds` leaves a window where a runaway role that does not overflow its context window runs until the operator stops the container. This is accepted and short-lived: step 31 lands the interrupt/inspect platform with a loop-detector agent (covering both consecutive-identical tool calls and LLM-judged reasoning repetition) plus the operator/API interrupt as the in-band termination path. Remove this row when step 31 lands.

## Estimated effort

Medium — the changes are mechanical (field removals across ~10 files) but the test rewrite is fiddly (several engine tests asserted the removed emitters). No new logic.

## Operator handoff

None for the code — fully in-environment (typecheck + tests). After this step, runs no longer have an executor-enforced wall-clock or tool-call cap; rely on the deployment container's `docker stop`/timeout to terminate a stuck run until step 31 lands the in-band overseer. If a real run loops indefinitely before step 31, that is the accepted gap, not a regression.

## Closeout (2026-06-25)

✅ complete. `bun run typecheck` and `bun test source/` green (461 pass). The accepted stuck/runaway gap is recorded in the tracked-debt table (`plan/README.md`).

### Deviations from the plan wording

- **Removed `RoleDefinition.generation` entirely.** Removing the `maxTokens: 2048` caps left only dead `temperature` overrides on `orchestrator`/`context_manager`, and a follow-up review found those were never applied at all: `createLlmCaller` closes over `model` and reads only `model.generation`, and `runRole` never passes a role's `generation` to the caller. The per-role `generation` field was dead config — validated but never read. It was removed from `RoleDefinition`, the role validators, `guild.json`, `docs/reference.md`, and the `renderConfig` test, so the only sampling parameters that exist are the model-level ones. This is pre-existing dead code this step exposed, paid in-step per the "no dead state" principle.

- **Removed additional dead state the plan did not name explicitly.** The plan only named `recentToolCalls`/`argsHash` for dead-state removal, but the same "only fed the deleted check" reasoning applied to the `RoleState.toolCalls`/`promptTokens`/`completionTokens` accumulators (each fed only the deleted tool-call-count / total-token check) and `EngineContext.startMs` / `GlobalBudgetState.startMs` (fed only the deleted wall-clock check). `cachedPromptTokens` was already dead before this step (accumulated, never read). All were removed to honor the "no dead state left feeding nothing" principle; `lastPromptTokens` and `recentCompactionPromptTokens` were retained (still read by `context_info` / `checkRoleBudgets`). `handleLlmResult` dropped its now-unused `roleDefinition` parameter.

- **Folded the run-termination note into `docs/architecture.md`.** The plan's design-decision text referenced `docs/deployment.md`, a file that was removed in an earlier docs refactor (its content lives in `docs/architecture.md` "Deployment"). Rather than recreate it, the run-termination note was added as a "Run termination" subsection under `docs/architecture.md` "Deployment", and `docs/reference.md` cross-links there. One stale `docs/executor.md` reference in `source/executor/index.ts` (another removed-doc remnant) was repointed to `docs/reference.md` in the same pass.

### End-of-step confirmation

`maxTokensPerRole` is gone everywhere (it was the conceptual bug — a cumulative sum masquerading as a context-window cap). `recentToolCalls`/`argsHash`/`hashArgs` are fully removed. `checkRoleBudgets` retains exactly one check (compaction-progress); `checkGlobalBudgets` retains exactly one check (depth). `recovery.md` no longer references `token_budget_exceeded` and still covers every remaining `ErrorKind` (the seed-guild conformance test, which iterates `ERROR_KINDS`, passes). The `agent` tool accepts `{ role, task }` only; `agent.json` has no `budget` property. No `as` casts were introduced.

