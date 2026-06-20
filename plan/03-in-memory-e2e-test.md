# Step 03 — In-memory end-to-end integration test

## Goal

Add an in-memory integration test that drives the **full** executor (`runExecutor`) through a complete role+tool run against the `hello_001` benchmark, using a fake LLM caller, and asserts the run succeeds and materializes `output.txt`. This validates the wiring end-to-end without needing a real LLM endpoint (per the in-memory testing policy).

## Context

Read [`00-foundation-completed.md`](00-foundation-completed.md) and `source/executor/executor.test.ts` to see how the executor is already exercised with fakes. The `hello_001` benchmark expects `output.txt` containing `hello world` (see `benchmarks/hello_001/eval.json` and `tests/test_output.py`). After step 01, the `coder` role can call `write_file`. The fake LLM must emit a plausible tool-call sequence: e.g. the orchestrator delegates to `coder`, the `coder` calls `write_file` then `finish`, the orchestrator calls `finish` with `status: "success"`.

## Deliverables

1. `source/executor/integration.test.ts` — an in-memory integration test that:
   - Builds a temp run directory under `os.tmpdir()` (cleaned up in `afterAll`).
   - Assembles real persistence/loader/tool handlers (real `createToolHandlers` with the temp workspace as root, real `createGuildLoader`, real persistence factories pointing at the temp dir) plus a **fake** `LlmCaller` and a **stub** `HumanBackend`.
   - The fake `LlmCaller` returns canned `AssistantResponse` objects in sequence so the seed Guild's `orchestrator → coder → write_file → finish` path is traversed. Drive it from the real `guild/guild.json` so the integration test also guards against Guild breakage.
   - Calls `runExecutor` with `--workspace benchmarks/hello_001` (copied into the temp run dir) and a task describing `output.txt`.
   - Asserts: `meta.status === "success"`; `data/runs/<id>/workspace/output.txt` exists and contains `hello world`; `log.jsonl` has at least one LLM-call event and the `write_file` tool-call event.
2. A reusable fake-LLM fixture in `source/executor/test-fixtures.ts` (if the existing fixtures do not already provide a scripted multi-turn caller). Export it; do not duplicate across tests.

## Module boundaries

- This is the one integration test that composes real leaves with a fake LLM. It is still in-memory (no network, no real model) and uses a temp dir, so it stays within the testing policy.
- Do not add orchestration logic to make the test pass — if the executor cannot traverse the path with a cooperative fake, fix the executor or the Guild, not the test's fakeness.

## Acceptance criteria

- [ ] `bun run typecheck` passes.
- [ ] `bun test source/` passes, including `integration.test.ts`, and the test runs in well under a second.
- [ ] The test asserts `meta.status === "success"` and that `output.txt` was materialized inside the temp run workspace.
- [ ] The temp directory is cleaned up (no leftover `os.tmpdir()` entries from the test).

## End-of-step evaluation

If the fake-LLM sequence had to be surprising or brittle, treat that as a signal about the executor or Guild and refactor. Confirm `test-fixtures.ts` is not exporting helpers solely for this one test unless they are genuinely reusable. Re-read `executor.ts` and `engine.ts` paths touched and ensure no test-only branches were added to production code.

## Estimated effort

Small to medium — the fake-LLM scripting is the fiddly part.

## Operator handoff

None — fully in-memory.
