# Step 04 — `typecheck` tool

## Goal

Add a `typecheck` native tool so the agent can run the workspace typechecker (`bun --bun tsc --noEmit`) and read its diagnostics to iterate. Together with the `test` tool (step 05), this gives the coding agent the two checkers it most needs to succeed on TypeScript coding tasks *without* opening the arbitrary-shell surface that `run_shell` (step 27) carries. `run_shell` is deferred until its containment is in place (the deployment environment; per-run isolation lands with the Foundry, step 31); `typecheck` and `test` are safe enough to ship now because they run a single fixed command with no model-chosen argv, no network, and no installs.

## Context

Read [`00-foundation-completed.md`](00-foundation-completed.md) (the v1 tool layer and the read-only native tools) and [`27-run-shell-tool.md`](27-run-shell-tool.md) (the deferred general shell tool and its containment dependency). The v1 tool layer is otherwise complete: native tools live as factories in `source/executor/tools/` and are assembled by `createToolHandlers` in `source/executor/tools.ts`; manifests live as `guild/tools/*.json` and are conformance-tested by `source/executor/tool-manifests.test.ts`.

Why a dedicated tool instead of `run_shell`: `run_shell` runs arbitrary model-chosen commands — that is exactly why it is gated behind isolation. A `typecheck` tool that runs only `bun --bun tsc --noEmit` (cwd pinned to the workspace, no argv from the model) adds essentially no new attack surface over the existing read-only tools: `tsc --noEmit` performs no I/O writes and no network; `bun test` (step 05) only executes `.test.*` files already in the workspace. The residual risk (a malicious benchmark shipping a test file that spawns a destructive command) is a benchmark-trust problem identical to `run_shell`'s and is likewise deferred to the deployment environment and per-run isolation (step 31). Per `docs/executor.md`, a non-zero exit is a **normal tool result** the role reads, not an executor error.

Over-optimization guardrail: the tool is named `typecheck` (generic checker), not `tsc`. Its manifest description says "run the workspace typechecker (currently Bun/TSC)." The `coder` prompt wording stays generic ("use the typecheck tool to verify your changes"). This keeps the guild from over-fitting to TypeScript; when environment isolation + multi-language support land (step 16), the hardcoded command is generalized to a per-workspace toolchain command. That generalization is tracked debt (see below), and its removal step is step 16 — so the over-fit window is exactly the window where every benchmark is TypeScript and over-fitting is harmless.

## Deliverables

1. `guild/tools/typecheck.json` — manifest. Parameters: `timeoutSeconds` (number, optional; capped by `defaultToolTimeoutSeconds`). No `command` parameter — the command is fixed by the tool, not chosen by the model.
2. `source/executor/tools/typecheck.ts` — leaf factory `createTypecheck(workspaceRoot, defaultTimeoutSeconds)` returning a `ToolHandler` that:
   - Spawns `bun --bun tsc --noEmit` with `cwd` set to `workspaceRoot` (Bun `Bun.spawn` or `node:child_process`).
   - Enforces the timeout (default from config, overridden up to the cap by `timeoutSeconds`). On timeout, kills the process and returns `{ kind: 'timeout', message, details: { afterSeconds } }`.
   - Captures stdout/stderr (cap their size to avoid blowing context; truncate with a clear marker, reusing the engine's truncation helper where sensible).
   - Returns `{ kind: 'success', data: { exitCode, stdout, stderr } }` even on non-zero exit. Reserve error `kind` for spawn/IO failures and timeouts, not non-zero exit. A failing typecheck (exit code 1 with diagnostic output) is a normal result the role reads and iterates on.
   - Does not take a path or command argument; the command is fixed. No allowlist/denylist logic (the command surface is a single fixed string, so there is nothing to allowlist).
3. `source/executor/tools/typecheck.test.ts` — in-memory tests using a temp directory under `os.tmpdir()` (cleaned up after). Cover: a clean `.ts` project returns exit code 0 with captured (empty or version) stdout; a `.ts` project with a deliberate type error returns a non-zero exit code as a **success** result with the diagnostic in stdout; a command that exceeds the timeout returns `kind: 'timeout'`; stdout truncation kicks in past the cap. Use a tiny `tsconfig.json` + one `.ts` file per fixture so the test is hermetic and fast.
4. Wire `typecheck` into `createToolHandlers` (`source/executor/tools.ts`).
5. Update `source/executor/tool-manifests.test.ts` (`expectedSignatures`, the native-names set, and the manifest-file count +1) and `source/executor/seed-guild.test.ts` (`expectedToolNames`).
6. Update `guild/guild.json`: add the manifest path and give the `coder` role the `typecheck` tool.
7. Update `guild/prompts/coder.md`: instruct the coder to run `typecheck` to verify its changes before finishing, and to read failing diagnostics rather than guessing. Keep wording generic ("the typecheck tool"); step 05 finalizes the coherent prompt text covering both `typecheck` and `test` together so the two steps do not write conflicting instructions.

## Module boundaries

- `typecheck.ts` is a leaf factory closing over `workspaceRoot` and the timeout cap.
- It must not duplicate path logic — `typecheck` does not take a path argument, it uses `cwd`.
- The fixed command string lives in the leaf, not in the manifest, so the model cannot influence it.

## Acceptance criteria

- [ ] `bun run typecheck` passes.
- [ ] `bun test source/` passes, including `typecheck.test.ts` and the updated conformance/seed-guild tests.
- [ ] A non-zero typecheck exit code is returned as `{ kind: 'success', data: { exitCode, ... } }`, not as an error.
- [ ] A timed-out typecheck returns `{ kind: 'timeout', details: { afterSeconds } }`.
- [ ] The conformance test asserts the new manifest count.

## Tracked technical debt

- **`typecheck` hardcodes `bun --bun tsc --noEmit`.** The tool is named generically and the command is fixed so the guild cannot over-fit to TypeScript, but the implementation is Bun/TSC-specific. Generalize to a per-workspace toolchain command (read from a benchmark `environment`/`package.json` field) when environment isolation + multi-language support land in step 16. Add a row to the [Tracked technical debt](README.md#tracked-technical-debt) table in `README.md` naming step 16 as the remover, and ensure step 16's file calls out generalizing the checker-tool commands.

## End-of-step evaluation

Re-read `typecheck.ts` and the sibling tools (`read-file.ts`, `search-text.ts`, etc.). Confirm the timeout path kills the child (no orphaned processes in tests). Ensure stdout/stderr caps use the same truncation helper as the engine (avoid two truncation mechanisms). Confirm the `coder` prompt's new typecheck guidance does not contradict the existing "small, testable changes" guidance, and that step 05's test-tool guidance composes with it rather than duplicating it.

## Estimated effort

Small to medium — a single fixed-command subprocess leaf with timeout/capture, plus tests. Smaller than `run_shell` (step 27) because there is no argv surface to design.

## Operator handoff

None — fully in-memory (tests use temp-dir TS fixtures). No real safety properties depend on deployment; the fixed command has no network and no writes.

## Closeout

Implemented as written, with one adaptation to the testing approach recorded here so future sessions inherit reality.

**Adaptation — injectable subprocess runner instead of real-`tsc` temp-dir fixtures.** Deliverable 3 as written suggested spawning real `bun --bun tsc --noEmit` against tiny temp-dir TS fixtures to exercise exit-code mapping. That conflicts with the project's hard "in-memory, fast, no external services" testing rule and the "leaf functions are not unit-tested" architecture: spawning `tsc` couples the unit suite to the installed toolchain and makes it slow. The leaf (`createBunSubprocessRunner`, the `Bun.spawn` wrapper) is therefore injectable, mirroring the `fetch-url.ts` / `fetcher` precedent: `createTypecheck(workspaceRoot, defaultTimeoutSeconds, runner)` takes a `SubprocessRunner` leaf. `typecheck.test.ts` exercises the orchestration (timeout cap, exit-code-as-success mapping, timeout → `kind: 'timeout'` with `details.afterSeconds`, stdout/stderr truncation via the shared `truncateToolOutput` helper, spawn-failure → error result, argument validation) with a fake runner — fully in-memory. One real-subprocess test of `createBunSubprocessRunner` itself verifies the timeout-kills-the-child safety property (no orphaned processes) that a fake cannot express; it spawns `bun -e` (always available in the test runtime) with a 200 ms timeout and asserts `timedOut`. `createToolHandlers` wires the real `createBunSubprocessRunner()` internally, so existing callers (`main.ts`, conformance tests) are unchanged.

All acceptance criteria met: `bun run typecheck` and `bun test source/` pass (349 tests); a non-zero exit is a `success` result with `exitCode`; a timeout returns `kind: 'timeout'` with `details.afterSeconds`; the conformance test asserts the new manifest count (13 manifests). The tracked debt row (hardcoded `bun --bun tsc --noEmit`, removed in step 16) is already in `plan/README.md` and step 16's deliverable 4 already calls out generalizing the checker-tool commands — no plan-README edit was needed.
