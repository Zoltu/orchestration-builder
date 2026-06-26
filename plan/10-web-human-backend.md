# Step 10 — Web `ask_human` backend state machine

## Goal

Add a `mode: 'web'` human backend that writes pending `ask_human` questions to the run state and resumes the executor when an answer is provided, keeping the `ask_human` tool interface identical to the stub/foundry backends. This is the testable core of human-in-the-loop; the HTTP surface is step 11.

## Context

Read `docs/reference.md` ("Built-in tools" → `ask_human`, "Executor runtime") and `source/executor/human-backend.ts` (the existing stub). The small model sees the same tool name/schema in every environment; only the backend changes. The web backend must allow the run to pause waiting for an answer and resume when one arrives. The executor is sequential, so a pending question blocks the single active role until answered.

## Deliverables

1. `source/executor/human-backend.ts` — extend to support `mode: 'web'`. The web backend is a small state machine: `ask(question, context)` returns a promise that resolves when `submitAnswer(id, answer)` is called. Implement with a simple in-process map of pending questions → resolvers (no external async library; Bun/web-standard only).
2. `source/executor/run-state.ts` — a leaf/orchestration that exposes pending questions for a run (so the web UI in step 11 can list them) and accepts answers. Keep it minimal and injectable.
3. `source/executor/human-backend.test.ts` (extend) — in-memory tests: the web backend resolves when an answer is submitted; an unanswered question stays pending; the tool result shape matches the stub backend (same fields the small model sees). No real HTTP.
4. The backend selection is made at runtime (step 12 wires `--human-backend web`); this step only delivers the backend and its tests.

## Module boundaries

- `human-backend.ts` owns the question/answer state machine.
- No HTTP server in this step — that is step 11. The web backend here is a promise-based resolver the server will drive.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The web backend resolves a pending question when its answer is submitted (in-memory).
- [ ] The `ask_human` tool result is identical in shape across stub/foundry/web backends (the small model cannot tell which is active).
- [ ] No busy-waiting; the pending promise resolves promptly on submit.

## End-of-step evaluation

Confirm the state machine has no race that drops an answer submitted before the question is registered (handle the "answer arrives then question" ordering defensively, or document why it cannot happen given sequential execution). Ensure no `as` casts. Confirm the backend selection logic stays in `main.ts` (step 12), not in the backend module.

## Estimated effort

Medium — the state machine is small but ordering edge cases need care.

## Operator handoff

None — fully in-memory.

## Closeout (complete)

Delivered:

- `source/executor/human-backend.ts` extended: `HumanBackendConfig` is now `{ mode: 'stub' } | { mode: 'web' }`. New `WebHumanBackend` interface (extends `HumanBackend`) exposes `ask`, `submitAnswer(id, answer)`, and `pendingQuestions()`. `createWebHumanBackend()` is the state-machine factory; `createHumanBackend({ mode: 'web' })` delegates to it (returning `HumanBackend` — callers that need the control surface call `createWebHumanBackend()` directly). Pending questions are keyed by `crypto.randomUUID()` in a `Map`; `ask` returns a `Promise<string>` resolved by `submitAnswer`.
- `source/executor/run-state.ts` added: `RunState` interface (`pendingQuestions`, `submitAnswer`) plus `createRunState({ humanBackend })`. It is the injectable façade the web server will consume; it delegates answers to the web backend and returns isolated shallow copies of pending questions so callers cannot mutate backend state.
- `source/executor/human-backend.test.ts` extended with web-mode coverage; `source/executor/run-state.test.ts` added.

Deviations / decisions (authoritative):

1. `AnswerSubmitResult` is `{ kind: 'resolved'; question } | { kind: 'not_found' }` only. A resolved question is deleted from the map, so a second submit for the same id returns `not_found` (no separate `already_answered` state) — the UI refreshes its pending list after a submit, so this is sufficient and keeps the state machine minimal.
2. The answer-before-registration race cannot occur: `ask` registers the pending entry synchronously inside the `new Promise` executor (which runs before `ask` returns), and a question's id is only discoverable via `pendingQuestions()` (which reads the registered map). Therefore any `submitAnswer(id)` call carries an id that was observed after registration. No defensive pre-answer buffer is needed.
3. Backend selection stays out of this module: `createHumanBackend` dispatches on `config.mode` (construction), but deciding stub-vs-web from the CLI is step 12's job in `main.ts`. The module reads no env or args.
4. `createRunState` is a thin façade whose real responsibilities are (a) defining the `RunState` contract the server depends on (dependency inversion, enables fakes) and (b) snapshot isolation of pending questions. It is tested for both.
5. `ask_human` tool-result shape is identical across backends by construction: both stub and web `ask` return `Promise<string>`, and `createAskHuman` (`source/executor/builtin-tools.ts`) wraps the answer as `{ kind: 'success', data: { question, answer } }` regardless of backend. Covered by an explicit test asserting the web answer is a string matching the stub.

`bun run typecheck` and `bun test source/` pass (285 tests). No `as` casts introduced.
