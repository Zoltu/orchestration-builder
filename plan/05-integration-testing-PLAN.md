# Phase 5 — Integration & Smoke Testing

## Goal

Wire the executor to a CLI, run the seed Guild against `benchmarks/hello_001`, and fix any integration issues. By the end of this phase the executor is usable from the command line and produces a passing run on the smoke benchmark.

## Deliverables

1. `src/main.ts` — CLI entry point:
   - Parse CLI args: `--guild <path>`, `--workspace <path>`, `--task <text>`, optional `--run-id <id>`.
   - Read environment variables for API key (if needed).
   - Assemble real dependencies: loader, LLM caller, persistence, human backend, tools.
   - Call `runExecutor(dependencies, options)`.
   - Exit with appropriate code.

2. `src/executor/index.ts` — public executor API exporting only what external callers need:
   - `runExecutor`
   - `createLlmCaller`
   - `createRunDirectory`, `createCopyWorkspace`, `createAppendLog`, `createWriteMeta`
   - `createHumanBackend`
   - `createGuildLoader`
   - Relevant types.

3. Unit tests:
   - `tests/shared/validation.test.ts` — type guards reject malformed input.
   - `tests/executor/context-builder.test.ts` — message list built correctly.
   - `tests/executor/budgets.test.ts` — budget enforcement with fake state.
   - `tests/executor/tool-dispatch.test.ts` — dispatch routes to tools and surfaces errors.

4. Integration test:
   - `scripts/smoke-test.ts` runs the executor on `benchmarks/hello_001` using the seed Guild.
   - Asserts `meta.json` status is `"success"`.

5. `README.md` updates:
   - How to run `bun src/main.ts --guild guild --workspace benchmarks/hello_001 --task ...`
   - How to run tests: `bun test`.

## Module boundaries

- `main.ts` is the only file that reads CLI args and environment variables.
- Tests use fakes for leaf factories and never touch real filesystems or LLMs.
- The integration script is the only test that executes a real run end-to-end.

## Acceptance criteria

- [ ] `bun src/main.ts --guild guild --workspace benchmarks/hello_001 --task "Write a file greeting the user"` completes successfully.
   - Creates `data/runs/<run_id>/`.
   - Writes `meta.json` with `status: "success"`.
   - Writes `log.jsonl` with at least one LLM call and relevant tool calls.
- [ ] `bun test` passes all unit tests.
- [ ] The smoke benchmark validation command passes when run manually against the final workspace.

## Known risks

- The seed Guild may fail to use tools correctly on the first attempt. Expect prompt iteration.
- Smaller local models may need explicit JSON-mode or tool-calling instructions; the LLM client may need small prompt-engineering adjustments.

## Estimated effort

Medium — integration debugging and prompt iteration usually take longer than expected.
