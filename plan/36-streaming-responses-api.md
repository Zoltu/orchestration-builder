# Step 36 — Streaming Responses API

Replace the executor's non-streaming `/chat/completions` client with a streaming (`SSE`) OpenAI **Responses API** (`POST {apiBase}/responses`) client. This is a one-time, permanent, non-backward-compatible switch: no chat-completions fallback, no dialect switch, no non-streaming path.

Targets that must keep working: **PPQ.ai** (`api.ppq.ai`), **llama.cpp** (`llama-server`, builds ≥ `b7793`, 2026-01-21), **Unsloth** (serves via bundled llama-server, inherits llama.cpp behavior). All three were investigated (2026-09-13): all support the stateless streaming Responses subset. See the investigation summary at the bottom of this file for the per-stack wire observations the implementation must tolerate.

## Status

— in progress (2026-09-13)

## Non-negotiable design decisions

1. **`LlmCallResult` is unchanged.** The engine (`engine.ts`), summarizer (`summarize.ts`), and log pipeline consume `LlmCaller.call()` results; none of them may change because of this step. The migration lives entirely behind the `LlmCaller` interface (`source/executor/llm.ts`) plus the model-catalog plumbing.
2. **Internal message history stays in the current chat-shaped `Message[]` dialect** (checkpoints, engine, UI all depend on it). Translation to Responses wire shape happens in `llm.ts` at request-build time; translation back happens at result-parse time.
3. **Streaming only.** `stream: true` always. Retries only apply *before* the SSE stream starts; once a 200 SSE stream is open, a mid-stream failure is terminal for that call (`llm_unavailable`), never retried (retrying would re-bill reasoning and risk duplicate tool calls).
4. **No abort/cancellation plumbing in this step.** (Future model-switch work adds it; do not preempt.)
5. **`reasoningField` is removed outright** from config, types, validation, env overrides, deployment file, and docs. Responses API normalizes reasoning into typed output items (`reasoning_text`), so the per-model field-name hack is obsolete.
6. **No new dependencies.** SSE parsing is hand-rolled (Bun built-ins and web APIs only).

## Architecture

### `source/executor/llm.ts` (rewritten internals, same exports)

**Leaf** — `createLlmFetch()` keeps its name, changes contract: `LlmFetchRequest` → `Promise<LlmStreamResponse>` where a 2xx yields `{ status, stream: ReadableStream<Uint8Array> }` (the raw SSE byte stream) and a non-2xx yields `{ status, errorBody: string }` (pre-stream errors are plain HTTP status + JSON on every target stack). Network errors still throw (the retry loop catches them, as today).

**Pure helpers (all directly unit-tested, no injection needed):**

- `createSseLineAssembler()` — incremental decoder/line splitter. Must handle: partial UTF-8 sequences split across chunks (`TextDecoder` with `stream: true`), `\r\n` and `\n`, blank lines, comment lines starting with `#`, `event:`/`id:`/`retry:` lines (ignore — PPQ and llama.cpp both send bare `data:` lines, but be lenient), and the literal `data: [DONE]` sentinel (PPQ sends it after the terminal event; llama.cpp never does — both must terminate cleanly). Cap the maximum line length defensively (a run of bytes with no newline must not buffer unboundedly); exceeding the cap is an error.
- `parseSseDataPayload(text)` — JSON-parse one data line into a value; distinguish the OpenAI Responses event envelope (`type` field) from a chat-completions-style error object (`{"error": …}` — llama.cpp's mid-stream error shape).
- `createResponsesStreamAccumulator()` — folds typed events into accumulated state, keyed per output item by `item_id` (present on delta events in both stacks), falling back to `output_index`, falling back to a single slot if neither is present. Events to handle (ignore anything unknown):
  - `response.created`, `response.in_progress` — record lifecycle, no data effect.
  - `output_item.added` — register an item slot (`message` / `reasoning` / `function_call` with `call_id`, `name`).
  - `content_part.added` — no data effect.
  - `reasoning_text.delta` — append raw reasoning text (raw CoT, not summaries, on both PPQ and llama.cpp).
  - `output_text.delta` — append assistant text.
  - `function_call_arguments.delta` — append to that item's buffered arguments.
  - `*_done` events and `output_item.done` — may arrive out of order/deferred (llama.cpp emits all `*_done` at the end); treat as informational, never authoritative.
  - `response.completed` / `response.incomplete` — **terminal and authoritative**: the event carries the full response object (`status`, `output[]`, `usage`, `incomplete_details`). Final state is built from this payload, not from the deltas (deltas exist for future incremental UX; the terminal payload is the source of truth for the result).
  - A bare `{"error": …}` data line — llama.cpp's mid-stream failure shape; record as a stream error.
- `mapHistoryToResponsesInput(messages, ...)` — leading `system` message → top-level `instructions`; any later `system` message is a bug → fail fast (the engine guarantees a single leading system message). `user` → `{role: 'user', content: [{type: 'input_text', text}]}`; `assistant` text → `{role: 'assistant', content: [{type: 'output_text', text}]}`; assistant `tool_calls` → `{type: 'function_call', call_id: id, name, arguments}` items; `tool` messages → `{type: 'function_call_output', call_id: tool_call_id, output: content}`. Reasoning is never sent back (matches today's behavior).
- `mapToolManifestsToResponsesTools(manifests)` — chat's nested `{type:'function', function:{name, description, parameters}}` becomes flat `{type:'function', name, description, parameters}`.
- `mapTerminalResponseToCallResult(response)` — output items → `content` (concatenated `output_text`), `reasoning` (concatenated `reasoning_text`), `toolCalls` (`function_call` items: `call_id` → `ToolCall.id`, plus `name`/`arguments`); `usage` → `{promptTokens: input_tokens, completionTokens: output_tokens, cachedPromptTokens: input_tokens_details.cached_tokens}`; `finishReason`: any `function_call` in output → `'tool_calls'`, `incomplete` with `max_output_tokens` → `'length'`, else `'stop'`. Preserve the current degenerate-response semantics (completed but empty content and no tool calls → retryable; `length` with no content → immediate failure).
- `detectContextBudgetExceeded(status, errorBody, contextWindow)` — ports the existing keyword heuristics to the new error shapes: PPQ nests the upstream error under `error.metadata.raw`; llama.cpp puts a plain message under `error.message`. Extract `prompt_tokens` from any of the paths the shapes offer.

**Orchestration** — `createLlmCaller(model, apiKey, {llmFetch, sleep})` keeps its signature (minus `reasoningField`): builds the request (`POST {apiBase}/responses`, Bearer header when a key exists, `{model, input, instructions, tools, tool_choice: 'auto', stream: true, max_output_tokens, temperature}`), classifies pre-stream outcomes (retry 5xx/429 up to 3 attempts with the existing backoff; `context_budget_exceeded` detection on the error body; other 4xx immediate failure), and consumes 2xx SSE streams through the assembler + accumulator to a terminal event, mapping to the same `LlmCallResult` union as today. A stream that ends without a terminal event, or a mid-stream error payload, yields `llm_unavailable` (with accumulated-state detail in the message) — no retry.

### Model catalog plumbing (`model-probe.ts`, `model-resolution.ts`)

`parseModelInfo` must accept both catalog shapes: llama.cpp's `{id, meta: {n_ctx}}` and PPQ's richer `{id, context_length, supported_parameters, pricing, …}` (367 entries; junk entries skipped as today). `context_length` and `meta.n_ctx` are interchangeable sources of the context window. The probe leaf itself is unchanged (value-returning, 5 s self-timeout, Bearer when a key exists).

### Config removal (`types.ts`, `validation.ts`, `deployment-env.ts`, `deployment/deployment.json`)

Remove `reasoningField` everywhere: the `ModelConfig`/`ResolvedModelConfig` fields, `validateModelConfig` (including its rejection message if it references it), `ORCHESTRATOR_REASONING_FIELD` env override, the deployment file, `source/tools/validate-data.ts` expectations, README's env table row, and `docs/reference.md`'s model-config section. `generation.temperature` / `generation.maxTokens` map to `temperature` / `max_output_tokens` — note for docs: Responses' `max_output_tokens` **includes** reasoning tokens, so configured values may need raising; the e2e run decides the shipped `deployment.json` value.

### Testing

- `llm.test.ts` rewritten against fake SSE byte streams (`ReadableStream` from in-memory strings — no network): assembler chunk-boundary and multibyte-split cases; accumulator cases for every stack quirk listed below; request-shape tests; pre-stream classification tests (context budget, 429/5xx retry, 4xx fail); terminal mapping tests (completed/incomplete, zero-delta streams, missing terminal event, mid-stream error).
- Engine/executor/summarizer tests keep passing unchanged (they fake `LlmCaller`) — that is the regression proof of decision 1.
- `bun run validate-data` passes with the updated deployment file.
- E2E smoke against the local `llama-server` (Guild's configured endpoint, reachable in-environment per AGENTS.md): submit a tiny task through `POST /api/runs`, verify the run reaches a terminal status with real streamed calls. This is integration validation, not part of `bun test`.

## Acceptance criteria

- No reference to `/chat/completions`, `completions`, `reasoningField`, or chat-shaped wire parsing remains in `source/` (grep-clean), except historical references in `docs/` where genuinely historical.
- `bun run typecheck`, `bun test source/`, `bun run validate-data` all green.
- A real run against the local llama-server completes through the new streaming path.
- All three target stacks' wire quirks (below) are covered by tests.

## Per-stack wire facts (from the 2026-09-13 investigation — the lenient client must tolerate all of these)

- **PPQ** (`https://api.ppq.ai/v1/responses`): bare `data:` JSON lines (no `event:` lines), contiguous 0-based `sequence_number`, `data: [DONE]` sentinel after the terminal event, distinct `response.completed`/`response.incomplete`/`response.failed` terminals (only the first two observed; errors arrive as pre-stream HTTP status + JSON), `reasoning_text.delta` carries raw CoT, `usage` (with `cost`) only in the terminal event, response bodies may carry leading whitespace (non-SSE), 429 capacity errors are routine (Qwen), `max_output_tokens` includes reasoning and a default `reasoning.effort` is injected per model, zero-delta streams are real (`muse-spark-1.3` streams `created → in_progress → incomplete` with no items).
- **llama.cpp** (≥ `b7793`): genuinely incremental `output_text.delta` / `reasoning_text.delta` / `function_call_arguments.delta`, but no `sequence_number`/`output_index`/`content_index` fields, no `[DONE]` sentinel (stream ends after `response.completed`), no `response.failed`/`response.incomplete` (mid-stream errors arrive as chat-completions-shaped `{"error": …}` data lines, then the stream closes), all `*_done`/`output_item.done` events deferred to the end, `output_item.added` may be missing for consecutive function calls, `usage` only in `response.completed`, extra `timings`/`prompt_progress` fields on events to ignore, reasoning item `summary` always `[]`.
- **Unsloth**: identical to llama.cpp (their HTTP API *is* llama-server; builds track recent llama.cpp, far above the floor). SSE does not survive their Cloudflare quick tunnel (localhost/LAN fine) — docs-level caveat only.

## Open questions (decided during implementation, recorded at closeout)

- None open at planning time. `max_output_tokens` value for the shipped deployment file is settled by the e2e run.
