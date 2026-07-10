# UI step 13 — Backend `InteractionModel` adapter + flow endpoints

## Goal

Build the server-side half the MVC refactor deferred: a pure derivation that turns a run's full log + meta + guild config into the `InteractionModel` the canonical view modules (`flow-view.js`, `sequence-diagram.js`) already render, and expose it via new endpoints. This is the successor to the original `deriveFlowModel` — it produces the contract `docs/visualization.md` specifies, from the executor's `LogEvent` stream. It is the only backend change phase B still needs, and it unblocks step 14's live hookup (a data-source swap onto this endpoint, not a renderer rewrite).

## Context

Read [`PLAN.md`](PLAN.md) ("Methodology", "Module boundaries"), [`mvc/PLAN.md`](mvc/PLAN.md) ("The model", "The single invariant both views read", "Interrupts"), `docs/visualization.md` ("The model", "Backend adapter (future)"), [`12-guild-human-facing-labels.md`](12-guild-human-facing-labels.md) (the live `/api/config` carries the tiered labels the resolver reads), `source/web/static/interaction-model.js` (the contract + the read helpers the adapter's output must satisfy: `activeStack`, `stacksOf`, `callChainOf`, `fateOf`, `observesOf`, `terminatesOf`), `source/executor/types.ts` (`LogEvent`), `source/web/render.ts` (`deriveRoleTree`, `parseLogEvents`, `RunSnapshot` / `RunSnapshotRaw`, and the `isObject` / `stringField` / `numberField` / `usageOf` narrowing patterns to copy), and `source/web/server.ts` (the existing `/api/runs/:id`, `/api/run`, `/api/config` routes and the snapshot-reading / `isKnownRun` / `runViewFor` helpers).

The view modules consume an `InteractionModel` (a timeline of operations over participants), not a `RunView`. The client only ever receives a truncated `recentLog` (the last 200 events) and run-wide budgets from `/api/runs/:id` — not the full log, and not the per-invocation time/token costs the flow nodes display. So the `LogEvent → InteractionModel` derivation belongs server-side, where the full snapshot is available. This step is that derivation; step 14 then points the renderers at the endpoint this step produces.

## The `InteractionModel` contract (fixed)

The shapes are defined in `source/web/static/interaction-model.js` (JSDoc) and documented in `docs/visualization.md` "The model". The adapter must produce objects that satisfy the model's own read helpers — those helpers encode the single invariant both views read, so a model that breaks them breaks the views.

```ts
Participant      = { id, role, kind: 'human' | 'interrupt' | 'role' | 'tool' }
OperationMetrics = { tokens: number | null, cachedPromptTokens: number | null, elapsedSeconds: number | null }
Operation        = { id, kind: 'call' | 'return' | 'observe' | 'terminate', stack, source, destination,
                     startedAt, settledAt: string | null, lifecycle: 'in_flight' | 'settled',
                     outcome: 'success' | 'error' | 'terminated' | null, details: string | null, metrics: OperationMetrics | null }
InteractionModel = { participants: Participant[], operations: Operation[], status: RunStatus }
```

`status` mirrors `RunMeta.status` with an `'unknown'` fallback for a malformed or absent meta.

## Derivation rules (executor `LogEvent` → `InteractionModel`)

- **Participants (instance-scoped).** `role_start` creates a `role` participant; `tool_call` creates a `tool` participant; a root `human` participant ("You") is always present; `ask_human` creates a child `human` participant; an interrupt event (when the executor emits one) creates an `interrupt` participant. A role invoked twice carries two participants with distinct ids.
- **Stacks.** The main run is one stack rooted at the human → entry role → delegations. Nested `agent_call` / `role_start` push onto the same stack; `tool_call` and `ask_human` are leaves on the caller's stack (push then pop on result / answer); `role_finished` / `tool_result` / `human_answer` pop. An interrupt spawns a fresh stack rooted at its `interrupt` participant (the active stack is whichever received the latest operation).
- **Operations.** `agent_call` / `role_start` → a `call` from the parent participant to the child role participant. `role_finished` → a `return` from the child to its caller, `outcome` from the status (`success` → success; `error` → error; `needs_clarification` → success — the role finished cleanly by asking; the run-level `needs_clarification` is carried by `InteractionModel.status`, not the operation outcome). `tool_call` → a `call` to the tool participant; `tool_result` → a `return` with `outcome` from the result kind (`success` → success; any `ErrorKind` → error). `ask_human` → a `call` to the child human; `human_answer` → a `return`. A `call` is `in_flight` from its start until the matching `return` lands (or a nested `call` on the same stack supersedes activity); a `return` is `in_flight` for its response-leg transit. `llm_call` does not create an operation — it contributes `metrics` to the active role's in-flight call span.
- **Metrics.** A `call` operation's `metrics` accumulates the callee's work across its span: `tokens` = sum of `usage.totalTokens` over the `llm_call`s between the call and its matching return (up to `now` while in-flight); `cachedPromptTokens` = sum of `usage.cachedPromptTokens`; `elapsedSeconds` = `settledAt − startedAt` (or `now − startedAt` while in-flight). Tool calls carry `elapsedSeconds` over their `tool_call` → `tool_result` span (typically no `llm_call` tokens). Pick one home for the per-invocation cost the view reads (the `call`'s metrics) and keep it consistent; the matching `return` may mirror the final totals or carry null.
- **`details`.** Adapter-formatted markdown for tooltip / detail surfaces: a role call carries the delegation task text; a tool call carries pretty-printed arguments; a tool result carries the result; an `ask_human` call carries the question (+ context). This is data, not localization; it reaches the DOM only through the step-27 sanitized Markdown pipeline, so the adapter produces markdown strings the pipeline can sanitize — it need not pre-sanitize (the client sanitizes).
- **Interrupts.** The executor's interrupt / inspect platform is main-plan step 31 and has not landed; the adapter must not assume those events exist, but must map them correctly when present: an interrupt spawns a new stack rooted at an `interrupt` participant, with `observe` / `terminate` operations mapping to read-only / revert cross-stack references as specified in `docs/visualization.md` "Interrupts". A run with no interrupt events produces a single-stack model.

## Deliverables

1. **`source/web/interaction-model-adapter.ts`** (new) — a pure `deriveInteractionModel(snapshot: RunSnapshot, now: string): InteractionModel` function. Pure and deterministic: given the full log + meta + `now`, one `InteractionModel`. No `as` casts; `LogEvent.payload` narrowed with type guards (reuse the `isObject` / `stringField` / `numberField` / `usageOf` patterns from `render.ts`).
   - **Type source.** The canonical `InteractionModel` shape lives in `source/web/static/interaction-model.js` as JSDoc (so the browser view modules can import it without a build step). The adapter is a server-side `.ts` module; it mirrors that shape as TS interfaces in this module so the server typechecks, with a one-line comment linking the two to the single contract in `docs/visualization.md`.
2. **`source/web/interaction-model-adapter.test.ts`** (new, in-memory) — the derivation rules asserted against hand-built `LogEvent` sequences (not the `scenarios.js` fixtures; those are the renderer's test bed and stay hand-authored). Covers: single-role completion; delegation chain (`agent_call` → `role_start` → `role_finished` → return); instance-per-invocation retry (two `coder` calls are two participants); in-flight tool node (`tool_call` with no `tool_result` yet); lingering return leg (a `role_finished` whose caller has not yet emitted a new action — the return is `in_flight`); `ask_human` → child human → `human_answer` return; per-invocation `tokens` / `elapsedSeconds` accumulated from `llm_call` usage; the root human always present; and (gracefully) the absence of interrupt events. Each produced model must satisfy `interaction-model.js`'s read helpers as a sanity check (`activeStack` / `callChainOf` / `fateOf` / `stacksOf` don't throw and return sensible values for the scenario).
3. **`source/web/server.ts`** — new endpoints `GET /api/runs/:id/flow` and `GET /api/run/flow` (alias to the active run, mirroring `/api/runs/:id` and `/api/run`) that call `deriveInteractionModel` with the full snapshot. Reuse the existing snapshot-reading leaf and the `isKnownRun` / `runViewFor` helpers; 404 for unknown runs. No `format=text` (the model is structured JSON). `details` markdown strings are served as-is; the client sanitizes.
4. **`source/web/server.test.ts`** — endpoint cases: a known run returns a model with the right `status` and at least the root human + entry-role participants; an unknown run 404s; the `/api/run/flow` alias matches `/api/runs/:id/flow` for the active run.
5. **`source/web/static/scenarios.js`** — leave the hand-authored `InteractionModel` frames in place (they remain the renderer's test bed and the dev harness's data source until step 14); this step does not touch them.
6. **`docs/security.md`** — confirm the endpoint serves structured JSON (identifiers / counters / costs as JSON values, agent prose as markdown strings in `details`); the client renders `details` only through the step-27 sanitized Markdown pipeline, so the security invariant holds. The server does not sanitize — it must not serve pre-rendered HTML that would bypass the client's sanitization.

## Module boundaries

- The adapter is a pure function in a `source/web/*.ts` module (it may import `render.ts`'s `deriveRoleTree` / `LogEvent` types and `executor/validation.js`, unlike the browser-pure view modules). It is tested in-memory; the server is a thin leaf that delegates to it.
- No executor-runtime changes: the derivation reads the persisted log + meta — the same artifacts `render.ts` already reads. Per-invocation costs are derived, not newly emitted by the executor.
- No new dependencies. The new endpoints reuse the existing static-asset + JSON-response helpers.
- `flow-view.js` / `sequence-diagram.js` (the renderers) are unchanged by this step — step 14 points them at the live endpoint instead of the fixture model.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] `deriveInteractionModel` produces models that satisfy `interaction-model.js`'s read helpers for every test scenario.
- [ ] The main area is active-path-only; lingering return legs and in-flight tool nodes are derived from the **full** log (the adapter reads the full snapshot, not a truncated `recentLog`).
- [ ] Per-invocation `metrics.tokens` / `metrics.elapsedSeconds` are derived from `llm_call` usage + event timestamps.
- [ ] `GET /api/runs/:id/flow` and `GET /api/run/flow` return the model; 404 for unknown runs.
- [ ] `/api/config` still carries the tiered labels (step 12) and still omits `apiKey` / `apiBase`.
- [ ] No `as` casts; external `LogEvent` payloads narrowed with type guards.

## Sequencing

After step 12 (guild label tiers — the model's friendly labels resolve from the live config via `labels.js`). Before step 14 (live hookup — which swaps the fixture model for `fetch('/api/run/flow')`). This step is the backend half the MVC refactor deferred; step 14 is the data-source swap onto the endpoint this step produces.

## Operator handoff

Confirm `/api/run/flow` returns a structured `InteractionModel` for a run: `curl` against a local-Ollama run (see `AGENTS.md` "Local test model" — `qwen3.5:9b` for a basic multi-role smoke test) or a fixture run, and confirm the participants / operations match the run's `role_start` / `tool_call` / `ask_human` events and the per-invocation token totals match the `llm_call` usage. Confirm `labels.js` resolves the friendly tiers from the live `/api/config`. (The product UI does not yet consume this endpoint — that is step 14.)

## Closeout (2026-07-09)

In-environment complete: `bun run typecheck` and `bun test source/` green. The adapter (`source/web/interaction-model-adapter.ts`) is a single pure pass over the full `LogEvent` stream that produces an `InteractionModel` satisfying `interaction-model.js`'s read helpers for every test scenario; the server serves it at `GET /api/runs/:id/flow` and the `/api/run/flow` alias (404 for unknown runs, 404 `no_run` when no run is active); `docs/security.md` records that the endpoint serves structured JSON with agent prose only as `details` markdown the client sanitizes.

Two deliberate deviations from the step's original wording, both made because the MVC refactor moved concerns the original adapter design expected to carry:

- **The `config: GuildConfigView` parameter was dropped.** The model carries no display prose (labels are a client concern resolved from the live `/api/config` by `labels.js`), so the adapter has no use for the guild config. Keeping an unused parameter would violate `noUnusedParameters`; rather than invent a speculative use, the signature is `deriveInteractionModel(snapshot, now)`. The server passes the parsed snapshot and `now`.
- **`deriveRoleTree` is not reused.** The tree gives role-name parent/child structure, but the operation model needs instance-scoped participant ids, per-call metrics, lifecycle, and the call-chain/return-leg bookkeeping the tree does not carry. A single stack-based pass over `role_start`/`role_finished`/`tool_call`/`tool_result`/`ask_human`/`human_answer`/`llm_call` derives all of that directly and more accurately (instance-per-invocation, lingering return legs, in-flight tool nodes), so the tree would have been redundant scaffolding.

The control-flow tools `agent`, `ask_human`, and `finish` have their `tool_call`/`tool_result` events skipped: `agent` is the delegation wrapper (the `role_start`/`role_finished` pair is the call), `ask_human` is the question (the `ask_human`/`human_answer` events are the call), and `finish` ends the role (the `role_finished` return is the close). This keeps a delegation from also spawning a redundant "agent" tool node.

A lingering return leg (a `role_finished` whose caller has not yet acted) is `in_flight`; it settles when the caller acts — a new call, the caller's `role_finished`, or an `llm_call` from the caller (the design's "until the caller emits a new action" rule). A finished run (`success`/`error`) has nothing in flight: the final return settles at its own timestamp and no row renders, matching the model contract. `needs_clarification`/`running`/`unknown` keep the latest activity-affecting operation in flight.

Operator visual sign-off (the `/api/run/flow` payload against a real run, plus `labels.js` resolving tiers from `/api/config`) is the remaining gate; the product UI does not consume the endpoint until step 14.