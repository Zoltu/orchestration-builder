# Step 04 — `run_shell` tool

## Goal

Add a `run_shell` native tool so the agent can execute shell commands inside the run workspace (run tests, build, inspect output). This is the last missing capability needed for real coding benchmarks (Phase 6). It is intentionally added after the smoke path is green so it lands on a stable executor.

## Context

Read `docs/security.md` ("Model-generated shell commands", "Shell tool policy") and `docs/architecture.md`. The v1 tool layer is sandboxed to the run workspace. `run_shell` runs a command with the workspace as its working directory, under a timeout, and returns stdout/stderr/exit code. Per `docs/executor.md` the failure mode is "Native tool non-zero exit or I/O error → complete the tool call" (the result JSON carries `status: "error"` plus output), so a non-zero exit is **not** an executor error — it is a normal tool result the role can read.

## Deliverables

1. `guild/tools/run_shell.json` — manifest. Parameters: `command` (string, required), `timeoutSeconds` (number, optional; capped by `defaultToolTimeoutSeconds`).
2. `source/executor/tools/run-shell.ts` — leaf factory `createRunShell(workspaceRoot, defaultTimeoutSeconds)` returning a `ToolHandler` that:
   - Spawns the command with `cwd` set to `workspaceRoot` (Bun `Bun.spawn` or `node:child_process`).
   - Enforces the timeout (default from config, overridden up to the cap by `timeoutSeconds`). On timeout, kills the process and returns `{ kind: 'timeout', message, details: { afterSeconds } }`.
   - Captures stdout/stderr (cap their size to avoid blowing context; truncate with a clear marker).
   - Returns `{ kind: 'success', data: { exitCode, stdout, stderr } }` even on non-zero exit. Reserve error `kind` for spawn/IO failures and timeouts, not non-zero exit.
   - Does **not** implement an allowlist/denylist in v1 (the design defers strongest isolation to the deployment environment — see step 18). Document this in a comment-free manner via the manifest description and the deployment docs (step 18).
3. `source/executor/tools/run-shell.test.ts` — in-memory tests using a temp dir. Cover: a successful command returns exit code 0 and captured stdout; a failing command returns its non-zero exit code as a **success** result; a command that exceeds the timeout returns `kind: 'timeout'`; stdout truncation kicks in past the cap. Use portable commands (`echo`, `printf`, `false`) so tests are environment-robust; guard with `test.skipIf` where a platform difference is unavoidable.
4. Wire `run_shell` into `createToolHandlers` (`source/executor/tools.ts`).
5. Update `source/executor/tool-manifests.test.ts` (`expectedSignatures`, native-names set) and `source/executor/seed-guild.test.ts` (`expectedToolNames`).
6. Update `guild/guild.json`: add the manifest path and give the `coder` role `run_shell` (so it can run tests/builds to iterate). Consider whether `critic` needs it (probably not for v1).
7. Update `guild/prompts/coder.md`: instruct the coder to run tests/builds with `run_shell` to verify its changes before finishing, and to read failing output rather than guessing.

## Module boundaries

- `run-shell.ts` is a leaf factory closing over `workspaceRoot` and the timeout cap.
- It must not duplicate path logic; `run_shell` does not take a path argument, it uses `cwd`. (If a future variant needs path arguments, sandbox them via `resolveWithinWorkspace`.)
- No shell-allowlist logic in v1 — tracked as a deliberate limitation (see tracked debt below).

## Acceptance criteria

- [ ] `bun run typecheck` passes.
- [ ] `bun test source/` passes, including `run-shell.test.ts` and the updated conformance/seed-guild tests.
- [ ] A non-zero exit code is returned as `{ kind: 'success', data: { exitCode, ... } }`, not as an error.
- [ ] A timed-out command returns `{ kind: 'timeout', details: { afterSeconds } }`.
- [ ] The conformance test asserts exactly thirteen manifest files.

## Tracked technical debt

- **No shell allowlist/denylist in v1.** Strongest isolation is deferred to the deployment container (step 18). Add a row to the [Tracked technical debt](README.md#tracked-technical-debt) table in `README.md` naming step 18 as the remover, and ensure step 18's file calls out shipping a non-root, read-only-filesystem, no-egress container plus documenting an optional allowlist.

## End-of-step evaluation

Re-read `run-shell.ts` and the sibling tools. Confirm the timeout path kills the child (no orphaned processes in tests). Ensure stdout/stderr caps use the same truncation helper as the engine where sensible (avoid two truncation mechanisms). Confirm the coder prompt's new test-running guidance does not contradict the "small, testable changes" guidance.

## Estimated effort

Medium — subprocess + timeout handling needs care, and tests must be platform-robust.

## Operator handoff

None — fully in-memory (tests use portable commands). The real safety properties (no egress, non-root) are a deployment concern landed in step 18.
