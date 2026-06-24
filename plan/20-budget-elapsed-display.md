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

- [x] `bun run typecheck` and `bun test source/` pass, including the extended `render.test.ts`, `engine.test.ts` (if usage logging was added), and `server.test.ts`.
- [x] The run summary shows elapsed time, tool calls used, and tokens used (or "—" when usage is unavailable).
- [x] `deriveBudgets` is covered for elapsed, tool-call count, token sum, missing-usage, and in-progress cases.
- [x] If `usage` was added to `llm_call` events, the change is additive and existing event-shape assertions still pass.
- [x] All rendering uses `createElement`/`textContent` (no `innerHTML`).

## Closeout (2026-06-24)

Complete. `bun run typecheck` and `bun test source/` both pass (395 tests across 29 files).

Changed files:

- `source/executor/engine.ts` — the `llm_call` log event now carries a per-call `usage` field. The event moved from before `deps.llmCaller.call` to after it (the usage is only known once the endpoint responds), via a new `llmCallPayload` helper. An `llm_call` event is still emitted on every call path — including the `context_budget_exceeded` retry and `llm_unavailable` paths — so the activity trail stays consistent; `usage` is attached only on the success path, since the over-budget prompt size on a context-budget result is a rejection signal, not consumed tokens. `messageCount` is unchanged; the change is purely additive. `usage` is split into billable buckets — `promptTokens` (full prompt bill, cached + uncached), `cachedPromptTokens` (the subset served from the endpoint's prompt cache, already counted inside `promptTokens`), `completionTokens`, and `totalTokens` — because prompt and completion tokens, and cached vs uncached prompt tokens, are billed at different rates. `RoleState` gained an accumulated `cachedPromptTokens` total alongside the existing prompt/completion totals.
- `source/executor/llm.ts` — `LlmCallResult`'s success `usage` is now an `LlmUsage` interface with an optional `cachedPromptTokens`. The parser reads it from `usage.prompt_tokens_details.cached_tokens` (OpenAI's shape); it is already counted inside `prompt_tokens`, so it is surfaced as a sub-field rather than added on top. Additive — fakes and callers that only read `promptTokens`/`completionTokens` still compile.
- `source/web/render.ts` — new pure `deriveBudgets(logEvents, meta, now)` helper returning `{ elapsedSeconds, toolCalls, tokensUsed, tokenBreakdown }`, plus `Budgets` and `TokenUsage` interfaces and a `usageOf` payload reader. `RunView` gained a `budgets` field; `RenderRunViewOptions` gained a required `now: string` so the pure helper never reads the clock. Elapsed time uses `meta.endTime` for a completed run and `now` for an in-progress run; when meta is absent (run in progress, meta.json not yet written) the first log event's timestamp stands in for the start, so elapsed is recoverable before meta exists. Clock skew that would make `now` precede the start is clamped to 0. `tokensUsed` is `null` when no `llm_call` event carries usage; otherwise it is the sum of every reported per-call total, and `tokenBreakdown` splits that total into `promptTokens` (cached + uncached), `cachedPromptTokens`, `completionTokens`, and `totalTokens`. The UI renders the uncached prompt bill as `promptTokens - cachedPromptTokens`, so cached tokens are not double-counted against the uncached rate.
- `source/web/render.test.ts` — a `deriveBudgets` describe block covering: elapsed from meta for a completed run, elapsed from the first log event for an in-progress (meta-null) run, the clock-skew clamp, tool-call counting across roles, token summing, `null` tokens when no usage is present, partial-usage summing, malformed-payload safety, the empty-log/no-meta base case, and the cached-vs-uncached prompt-token split. Existing `renderRunView` calls updated to pass the required `now`, plus a `budgets` assertion on the completed-run view.
- `source/web/server.ts` — `runViewFor` passes `now: new Date().toISOString()` to `renderRunView`.
- `source/web/server.test.ts` — the run-view fixture's `llm_call` event now carries `usage`, the `recentLog[0].payload` assertion updated to match, a new test asserts `/api/runs/run-1` returns `budgets` derived from the log and meta, and a new `run-cached` fixture (one call with cached tokens, one without) drives a test asserting the cached-vs-uncached prompt split end to end.
- `source/web/static/app.js` — `RunSummaryPanel` renders a budgets line (elapsed time as `Xm Ys`, tool calls used, total tokens used or `—` when unavailable) plus, when a breakdown is present, the uncached prompt / cached prompt / completion split, via `createElement`/`textContent` only. `formatElapsed` and `formatTokens` formatters plus a top-level `BudgetsLine` view function support it. Used counts are rendered alone; the used/max comparison is deferred to the step-21 config panel.
- `source/web/static/styles.css` — minimal `.budgets` line styling, with the cached-token detail in green to distinguish it from the uncached prompt bill.

Deviations / decisions (authoritative):

- **The `llm_call` event moved from pre-call to post-call.** The plan's "add usage as an additive payload field" is only possible once the endpoint has responded, so the event is now emitted after `deps.llmCaller.call` returns. This is the same reorder step 22 mandates (its `llm_call` enrichment — sent messages, received response, `finishReason`, per-call usage — requires `llmResult`, so step 22 moves the event after `handleLlmResult`), so step 20 doing it early reduces step 22's diff and lands the usage field on the event step 22 will expand. The side effect is that a role mid-LLM-call no longer shows a fresh "llm call" current-activity marker until the call returns; for the local fast models this is sub-second, and step 22 will own the final in-flight-visibility story. Event ordering relative to other events is unchanged (`llm_call` still precedes `implicit_finish` / `tool_call` / `llm_unavailable` / `context_budget_exceeded`), so existing order-sensitive assertions still pass.
- **`llm_call` is still logged on the failure paths.** The end-of-step evaluation asked that every `llm_call` path (including the context-budget-exceeded retry path) log it consistently, so the event is emitted on every path with `usage` present only on success. Step 22 will later narrow this to the success paths only (its evaluation explicitly drops `llm_call` from the `llm_unavailable`/`context_budget_exceeded` paths); step 20 keeps the broader emission to satisfy its own evaluation and to avoid changing which paths appear in the activity trail ahead of step 22's richer rewrite.
- **Elapsed time falls back to the first log event's timestamp when meta is absent.** The plan assumed `RunMeta.startTime` is available, but meta.json is written only at run completion, so an in-progress run has no meta and no `startTime`. The first `log.jsonl` event's timestamp is the closest available start signal for an in-progress run and keeps elapsed time live while a run is running. This is an in-helper adaptation; no meta/persistence change was needed.
- **`tokensUsed` sums `totalTokens` (falling back to `promptTokens + completionTokens`).** The executor logs `totalTokens`, but the reader tolerates the two-field form so a partial or older log still contributes its real cost rather than reading as zero.

No new technical debt introduced. The used/max comparison is intentionally deferred to step 21's read-only config endpoint per this step's module boundaries, not tracked as debt.

## End-of-step evaluation

Confirm `deriveBudgets` takes `now` as a parameter (no `Date.now()` inside the pure helper — the server passes `new Date().toISOString()`). Confirm token summation does not throw when an `llm_call` event lacks usage (treat as 0 or skip). Confirm the elapsed-time formatting does not go negative if the clock skew between client and server makes `now` precede `startTime` (clamp to 0). If usage logging was added, confirm every `llm_call` path (including the context-budget-exceeded retry path) logs it consistently.

## Estimated effort

Medium — mostly a pure helper and its tests, plus a small additive executor change if usage is not already logged. The client work is a single summary line.

## Operator handoff

Run the service against a multi-role benchmark and confirm the budgets line updates as the run progresses: elapsed time advances, tool-call count grows, and token usage reflects the model's reported usage. Report any case where tokens show "—" unexpectedly (meaning usage is not being logged); the agent adds the `usage` field in-environment.
