# Step 05 — `test` tool

## Goal

Add a `test` native tool so the agent can run the workspace test suite (`bun test`) and read failing output to iterate. Together with the `typecheck` tool (step 04), this gives the coding agent the two checkers it most needs to succeed on TypeScript coding tasks *without* opening the arbitrary-shell surface that `run_shell` (step 17) carries. `run_shell` is intentionally deferred behind environment isolation (step 16); `test` and `typecheck` are safe enough to ship now because they run a single fixed command with no model-chosen argv, no network, and no installs.

## Context

Read [`04-typecheck-tool.md`](04-typecheck-tool.md) (the sibling checker tool — same shape, same safety rationale) and [`00-foundation-completed.md`](00-foundation-completed.md) (the v1 tool layer). The two checker tools are near-identical leaf factories that each spawn one fixed command. They are kept as **separate modules** on purpose: the tools are meant to be modular and a guild may give one tool to one role and a different tool to another, and separate files are easier to read and copy by other users even if some internal structure is duplicated. This mirrors the existing `source/executor/tools/` convention where `read-file.ts`, `glob-files.ts`, `search-text.ts`, and `list-directory.ts` are each their own module.

Why a dedicated tool instead of `run_shell`: `run_shell` runs arbitrary model-chosen commands — that is exactly why it is gated behind isolation. A `test` tool that runs only `bun test` (cwd pinned to the workspace, no argv from the model) adds essentially no new attack surface over the existing read-only tools: `bun test` only executes `.test.*` files already in the workspace, fetches nothing, installs nothing. The residual risk (a malicious benchmark shipping a test file that spawns a destructive command) is a benchmark-trust problem identical to `run_shell`'s and is likewise deferred to isolation (step 16). Per `docs/executor.md`, a non-zero exit is a **normal tool result** the role reads, not an executor error.

Over-optimization guardrail: the tool is named `test` (generic), not `bun_test`. Its manifest description says "run the workspace test suite (currently `bun test`)." The `coder` prompt wording stays generic. When environment isolation + multi-language support land (step 16), the hardcoded command is generalized to a per-workspace toolchain command. That generalization is tracked debt (see below), removed in step 16 — so the over-fit window is exactly the window where every benchmark is TypeScript and over-fitting is harmless.

## Deliverables

1. `guild/tools/test.json` — manifest. Parameters: `timeoutSeconds` (number, optional; capped by `defaultToolTimeoutSeconds`). No `command` or path parameter — the command is fixed by the tool, not chosen by the model.
2. `source/executor/tools/test.ts` — leaf factory `createTest(workspaceRoot, defaultTimeoutSeconds)` returning a `ToolHandler` that:
   - Spawns `bun test` with `cwd` set to `workspaceRoot` (Bun `Bun.spawn` or `node:child_process`).
   - Enforces the timeout (default from config, overridden up to the cap by `timeoutSeconds`). On timeout, kills the process and returns `{ kind: 'timeout', message, details: { afterSeconds } }`.
   - Captures stdout/stderr (cap their size to avoid blowing context; truncate with a clear marker, reusing the engine's truncation helper where sensible).
   - Returns `{ kind: 'success', data: { exitCode, stdout, stderr } }` even on non-zero exit. Reserve error `kind` for spawn/IO failures and timeouts, not non-zero exit. A failing test suite (exit code 1 with failure output) is a normal result the role reads and iterates on.
   - Does not take a path or command argument; the command is fixed.
3. `source/executor/tools/test.test.ts` — in-memory tests using a temp directory under `os.tmpdir()` (cleaned up after). Cover: a passing test file returns exit code 0 with the pass summary in stdout; a failing test file returns a non-zero exit code as a **success** result with the failure in stdout; a command that exceeds the timeout returns `kind: 'timeout'`; stdout truncation kicks in past the cap.
4. Wire `test` into `createToolHandlers` (`source/executor/tools.ts`).
5. Update `source/executor/tool-manifests.test.ts` (`expectedSignatures`, the native-names set, and the manifest-file count +1) and `source/executor/seed-guild.test.ts` (`expectedToolNames`).
6. Update `guild/guild.json`: add the manifest path and give the `coder` role the `test` tool.
7. Finalize `guild/prompts/coder.md` so the two checker tools compose into one coherent instruction: run `typecheck` and `test` to verify changes, read their diagnostics/failures, and iterate until both are green before finishing. Step 05 owns the final prompt text so step 04 and step 05 do not write conflicting instructions. Keep wording generic ("the test tool", "the typecheck tool"); do not hard-code `bun`/`tsc` in the prompt.

## Module boundaries

- `test.ts` is a leaf factory closing over `workspaceRoot` and the timeout cap.
- It must not duplicate path logic — `test` does not take a path argument, it uses `cwd`.
- The fixed command string lives in the leaf, not in the manifest, so the model cannot influence it.
- Some internal structure is intentionally duplicated from `typecheck.ts` (per the per-tool-separate principle); do not refactor the two into a shared helper unless a third checker tool arrives and the duplication is genuinely costing clarity.

## Acceptance criteria

- [ ] `bun run typecheck` passes.
- [ ] `bun test source/` passes, including `test.test.ts` and the updated conformance/seed-guild tests.
- [ ] A non-zero test exit code is returned as `{ kind: 'success', data: { exitCode, ... } }`, not as an error.
- [ ] A timed-out test run returns `{ kind: 'timeout', details: { afterSeconds } }`.
- [ ] The conformance test asserts the new manifest count.
- [ ] The `coder` prompt composes `typecheck` and `test` into one coherent instruction with no contradictions.

## Tracked technical debt

- **`test` hardcodes `bun test`.** The tool is named generically and the command is fixed so the guild cannot over-fit to Bun, but the implementation is Bun-specific. Generalize to a per-workspace toolchain command when environment isolation + multi-language support land in step 16. Add a row to the [Tracked technical debt](README.md#tracked-technical-debt) table in `README.md` naming step 16 as the remover, and ensure step 16's file calls out generalizing the checker-tool commands.

## End-of-step evaluation

Re-read `test.ts` alongside `typecheck.ts` and the other sibling tools. Confirm the timeout path kills the child (no orphaned processes in tests). Ensure stdout/stderr caps use the same truncation helper as the engine. Confirm the `coder` prompt's combined typecheck/test guidance is coherent and generic, and that it does not over-fit to TypeScript. Sanity-check that an in-memory executor run (step 03's e2e test pattern, or a new one) can drive the coder to call `test` and read a failing result.

## Estimated effort

Small to medium — near-identical in shape to step 04; the bulk is the test fixtures and the finalized coder prompt.

## Operator handoff

None — fully in-memory (tests use temp-dir fixtures). No real safety properties depend on deployment; the fixed command has no network and no installs.

## Closeout

Implemented as written, reusing the injectable-subprocess-runner precedent step 04 established rather than re-deriving it.

**Adaptation — reuse `typecheck.ts`'s subprocess leaf instead of duplicating it.** Step 04's closeout made `createBunSubprocessRunner`, `SubprocessRunner`, and `SubprocessOutcome` exported from `source/executor/tools/typecheck.ts` as a generic, typecheck-agnostic subprocess leaf (the `Bun.spawn` wrapper with timeout-kills-child). `test.ts` imports `SubprocessRunner`/`SubprocessOutcome` from `./typecheck.js` and is itself only the `createTest(workspaceRoot, defaultTimeoutSeconds, runner)` leaf with the fixed `['bun', 'test']` command. This honors the plan's "do not refactor the two into a shared helper unless a third checker tool arrives" boundary — no new shared helper was created; `test.ts` reuses an already-public leaf exactly as `tools.ts` already does. The fixed command string, the output cap, the timeout-clamp orchestration, and the exit-code-as-success mapping live in `test.ts` itself, so the two checker tools remain independently readable and copyable.

`test.test.ts` exercises the orchestration with a fake runner — passing suite (exit 0 + pass summary in stdout), failing suite (non-zero exit returned as `kind: 'success'` with failures in stdout), timeout → `kind: 'timeout'` with `details.afterSeconds`, capped-timeout details, default-vs-capped timeout selection, stdout/stderr truncation via the shared `truncateToolOutput` helper, `timeoutSeconds` validation, and spawn-throw → `invalid_arguments`. The real-subprocess timeout-kills-child safety property of the shared leaf is already covered once in `typecheck.test.ts` and is not duplicated here.

`tools.ts` hoists a single `createBunSubprocessRunner()` instance shared by both `typecheck` and `test` (the runner is stateless — one factory call per process is cleaner than two identical ones).

All acceptance criteria met: `bun run typecheck` and `bun test source/` pass (361 tests); a non-zero exit is a `success` result with `exitCode`; a timeout returns `kind: 'timeout'` with `details.afterSeconds`; the conformance test asserts the new manifest count (14 manifests, including `test.json`); the `coder` prompt's "Verifying changes" section composes `typecheck` and `test` into one coherent, generic instruction (no `bun`/`tsc` hardcode). The tracked debt row (hardcoded `bun test`, removed in step 16) is already in `plan/README.md`, and step 16's deliverable 4 already calls out generalizing both checker-tool commands — no plan-README edit was needed.
