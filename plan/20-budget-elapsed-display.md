# Step 20 — Budget & elapsed-time display

## Goal

Surface how far a run has progressed against its hard safety budgets so the operator can see whether a long-running run is healthy, approaching a limit, or stuck. Today the executor enforces `maxToolCallsPerRole`, `maxTokensPerRole`, `maxRunTimeSeconds`, and `maxAgentDepth` but the UI shows none of them — only raw event counts in the role-activity list. This step adds an elapsed-time display and used-vs-budget indicators for tool calls and tokens.

## Context

Read [`14-multi-run-ui.md`](14-multi-run-ui.md) (the role-activity panel), `source/web/render.ts` (`deriveRoleActivity`, `RunView`), `source/executor/types.ts` (`ExecutorConfig`, `RunMeta.startTime`), `source/executor/engine.ts` (what the `llm_call` and `tool_call` log events carry — confirm whether token `usage` is logged), and `guild/guild.json` (the `executor` budget block).

Elapsed time is derivable from `RunMeta.startTime` and the current time. Tool-call counts are derivable by counting `tool_call` events in the log. Token usage is returned by the model endpoint's `usage` fields, but it is not obvious that usage is persisted to the `llm_call` log event; this step confirms that and, if missing, adds it as an additive payload field so token budgets are recoverable. The budget maximums live in the Guild's `executor` block, which step 21 exposes via a read-only config endpoint; this step renders "used" counts and defers the "max" comparison to step 21's config data (or renders used counts alone until then).

## Deliverables

1. `source/executor/engine.ts` (extend, if needed) — if the `llm_call` log event does not already carry token `usage` (prompt/completion/total), add it as an additive payload field. Existing readers ignore extra fields; do not rename existing ones. Skip this if usage is already logged.
2. `source/web/render.ts` — a pure `deriveBudgets(logEvents, meta, now)` helper returning `{ elapsedSeconds, toolCalls, tokensUsed }` (tokens summed from `llm_call` usage fields; `null` when usage is unavailable). Add a `budgets` field to `RunView`.
3. `source/web/render.test.ts` — cover `deriveBudgets`: elapsed from start time, tool-call count across roles, token sum from usage fields, `null` tokens when usage is absent, and the in-progress (no `endTime`) case.
4. `source/web/static/app.js` — render a budgets line in the run summary: elapsed time (formatted as `Xm Ys`), tool calls used, and tokens used (or "—" when unavailable). When step 21's config data is available, render used/max; otherwise render used alone with a note that maximums come from the config panel. All rendering uses `createElement`/`textContent`.
5. `source/web/server.test.ts` — update the run-view fixture so `/api/runs/:id` exercises the `budgets` field (include `llm_call` events with usage).
6. `source/web/static/styles.css` — minimal styling for the budgets line.

## Module boundaries

- `deriveBudgets` is a pure, testable helper in `render.ts`; it takes `now` as a parameter so elapsed-time tests are deterministic.
- The only executor touch is the optional additive `usage` field on `llm_call` events, required only if usage is not already logged.
- The "max" side of used/max depends on step 21's `GET /api/config` endpoint; this step renders "used" now and notes the dependency so step 21 can wire used/max together. Do not duplicate the Guild-reading leaf here.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the extended `render.test.ts`, `engine.test.ts` (if usage logging was added), and `server.test.ts`.
- [ ] The run summary shows elapsed time, tool calls used, and tokens used (or "—" when usage is unavailable).
- [ ] `deriveBudgets` is covered for elapsed, tool-call count, token sum, missing-usage, and in-progress cases.
- [ ] If `usage` was added to `llm_call` events, the change is additive and existing event-shape assertions still pass.
- [ ] All rendering uses `createElement`/`textContent` (no `innerHTML`).

## End-of-step evaluation

Confirm `deriveBudgets` takes `now` as a parameter (no `Date.now()` inside the pure helper — the server passes `new Date().toISOString()`). Confirm token summation does not throw when an `llm_call` event lacks usage (treat as 0 or skip). Confirm the elapsed-time formatting does not go negative if the clock skew between client and server makes `now` precede `startTime` (clamp to 0). If usage logging was added, confirm every `llm_call` path (including the context-budget-exceeded retry path) logs it consistently.

## Estimated effort

Medium — mostly a pure helper and its tests, plus a small additive executor change if usage is not already logged. The client work is a single summary line.

## Operator handoff

Run the service against a multi-role benchmark and confirm the budgets line updates as the run progresses: elapsed time advances, tool-call count grows, and token usage reflects the model's reported usage. Report any case where tokens show "—" unexpectedly (meaning usage is not being logged); the agent adds the `usage` field in-environment.
