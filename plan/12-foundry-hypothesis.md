# Step 12 — Foundry hypothesis generation

## Goal

Add the big-model-driven hypothesis generation: prompt the large model with the baseline Guild and recent run logs, parse hypotheses (motivation, mechanism, predicted impact, file changes), validate each produces a loadable branch Guild, and create branches for valid hypotheses.

## Context

Read `docs/foundry.md` ("Hypotheses", "Human simulation and question penalty"). The Foundry is the only part using a large model. The hypothesis is metadata + a branch configuration. The big-model endpoint is configured separately from the executor's small model (`FoundryConfig.bigModel`). `ask_human` during Foundry runs is answered by the same large model simulating a persona — but the human-simulator backend wiring belongs to step 14 (loop) or a dedicated sub-step if it grows; keep this step focused on hypothesis generation.

## Deliverables

1. `source/foundry/llm.ts` — leaf factory `createBigModelCaller(config)` returning `{ call }` that POSTs to the big-model endpoint with retries/backoff, mirroring the executor's `createLlmCaller` shape. This is the only file the Foundry uses for big-model HTTP.
2. `source/foundry/hypothesize.ts` — orchestration `generateHypotheses(dependencies, { baselineGuild, recentRunLogs, config })`:
   - Builds the prompt (baseline Guild text + aggregated failure summaries + instructions to produce only actionable, testable hypotheses).
   - Calls the big model via the injected caller.
   - Parses the response into `Hypothesis[]` with a type guard (`isHypothesis`); rejects malformed output.
   - For each hypothesis, applies its changes via the branch manager (step 09) and validates the resulting Guild loads; drops hypotheses that produce an invalid Guild, recording why.
   - Returns `{ hypotheses, rejected }`.
3. `source/foundry/hypothesize.test.ts` — in-memory test with a fake big-model caller returning a scripted hypothesis JSON. Assert: valid hypotheses are parsed and produce loadable branches; malformed hypotheses are rejected with reasons; a hypothesis whose edits break the Guild is dropped.
4. `source/foundry/human-simulator.ts` (if not already present) — a `mode: 'foundry'` human backend that answers `ask_human` via the big model with the configured persona and the benchmark's deterministic `humanResponses` for near-exact matches. Mirrors the `ask_human` contract from `docs/executor.md`. Tested with a fake big-model caller.

## Module boundaries

- `llm.ts` is the only Foundry file doing HTTP (leaf factory).
- `hypothesize.ts` is orchestration receiving the big-model caller and branch manager explicitly.
- Prompt text is data — keep the prompt-building logic pure and testable (assert on the constructed prompt, not just the parsed output).

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] `generateHypotheses` parses valid hypotheses and rejects malformed ones with clear reasons.
- [ ] A hypothesis whose edits yield an invalid Guild is dropped, not crashed on.
- [ ] The human simulator returns deterministic `humanResponses` on near-exact matches and falls back to the big-model persona otherwise (verified with a fake caller).

## End-of-step evaluation

Confirm the prompt construction is pure and the parsing uses a type guard (no casts). Ensure the big-model caller mirrors the executor LLM caller's retry/backoff and error-surfacing shape. Check that no big-model call happens outside `llm.ts`.

## Estimated effort

Medium to large — prompt design + parsing + simulator.

## Operator handoff

None for code. Real hypothesis generation requires a real big-model endpoint and is exercised in step 14.
