# Step 21 — `run_shell` tool

## Goal

Add a `run_shell` native tool so the agent can execute arbitrary shell commands inside the run workspace (run builds, inspect output, drive tools the dedicated checker tools do not cover). This is the general-purpose shell capability, and because it runs **arbitrary model-chosen commands** it is intentionally sequenced *after* environment isolation (step 20) lands — `run_shell` is the one tool whose risk profile requires containment. The two safe checker tools (`typecheck`, step 04; `test`, step 05) already cover the coding-critical checkers without opening this surface, so `run_shell` is not needed for the no-install TS benchmarks and waits until isolation makes it safe.

## Context

Read [`20-environment-isolation.md`](20-environment-isolation.md) (the prerequisite — `run_shell` builds on the hermetic per-run environment), `docs/security.md` ("Model-generated shell commands", "Shell tool policy"), and `docs/architecture.md`. The v1 tool layer is sandboxed to the run workspace. `run_shell` runs a command with the workspace as its working directory, under a timeout, and returns stdout/stderr/exit code. Per `docs/executor.md` the failure mode is "Native tool non-zero exit or I/O error → complete the tool call" (the result JSON carries `status: "error"` plus output), so a non-zero exit is **not** an executor error — it is a normal tool result the role can read.

The containment that makes `run_shell` safe is provided by step 20 (per-run isolation: non-root, no unapproved egress, hermetic filesystem). This step implements the tool itself on top of that environment; it does not re-solve isolation. If step 20 has not landed, this step is blocked — do not ship `run_shell` without isolation in place.

## Deliverables

1. `guild/tools/run_shell.json` — manifest. Parameters: `command` (string, required), `timeoutSeconds` (number, optional; capped by `defaultToolTimeoutSeconds`).
2. `source/executor/tools/run-shell.ts` — leaf factory `createRunShell(workspaceRoot, defaultTimeoutSeconds)` returning a `ToolHandler` that:
   - Spawns the command with `cwd` set to `workspaceRoot` (Bun `Bun.spawn` or `node:child_process`).
   - Enforces the timeout (default from config, overridden up to the cap by `timeoutSeconds`). On timeout, kills the process and returns `{ kind: 'timeout', message, details: { afterSeconds } }`.
   - Captures stdout/stderr (cap their size to avoid blowing context; truncate with a clear marker).
   - Returns `{ kind: 'success', data: { exitCode, stdout, stderr } }` even on non-zero exit. Reserve error `kind` for spawn/IO failures and timeouts, not non-zero exit.
   - Does **not** implement an allowlist/denylist in v1 — containment comes from the step-20 isolation environment (non-root, no unapproved egress, hermetic fs), not from an in-tool command filter. Document this via the manifest description.
3. `source/executor/tools/run-shell.test.ts` — in-memory tests using a temp dir. Cover: a successful command returns exit code 0 and captured stdout; a failing command returns its non-zero exit code as a **success** result; a command that exceeds the timeout returns `kind: 'timeout'`; stdout truncation kicks in past the cap. Use portable commands (`echo`, `printf`, `false`) so tests are environment-robust; guard with `test.skipIf` where a platform difference is unavoidable.
4. Wire `run_shell` into `createToolHandlers` (`source/executor/tools.ts`).
5. Update `source/executor/tool-manifests.test.ts` (`expectedSignatures`, native-names set) and `source/executor/seed-guild.test.ts` (`expectedToolNames`).
6. Update `guild/guild.json`: add the manifest path and give the `coder` role `run_shell` (so it can run builds/tools the dedicated checkers do not cover). Consider whether `critic` needs it (probably not for v1).
7. Update `guild/prompts/coder.md`: instruct the coder that `run_shell` is for commands the dedicated `test`/`typecheck` tools do not cover (builds, ad-hoc inspection), and to prefer the dedicated checker tools for test/typecheck runs. Read failing output rather than guessing.

## Module boundaries

- `run-shell.ts` is a leaf factory closing over `workspaceRoot` and the timeout cap.
- It must not duplicate path logic; `run_shell` does not take a path argument, it uses `cwd`. (If a future variant needs path arguments, sandbox them via `resolveWithinWorkspace`.)
- No shell-allowlist logic in v1 — containment is the step-20 environment's job, not this tool's (see tracked debt below).

## Acceptance criteria

- [ ] Step 20 (environment isolation) has landed; this step is unblocked.
- [ ] `bun run typecheck` passes.
- [ ] `bun test source/` passes, including `run-shell.test.ts` and the updated conformance/seed-guild tests.
- [ ] A non-zero exit code is returned as `{ kind: 'success', data: { exitCode, ... } }`, not as an error.
- [ ] A timed-out command returns `{ kind: 'timeout', details: { afterSeconds } }`.
- [ ] The conformance test asserts the new manifest count.

## Tracked technical debt

- **No shell allowlist/denylist in v1.** Containment comes from the step-20 per-run isolation environment (non-root, no unapproved egress, hermetic filesystem), not from an in-tool command filter. If a future threat model requires defense-in-depth at the tool level (e.g. an allowlist for environments where step-20 isolation is unavailable), add it then. The [Tracked technical debt](README.md#tracked-technical-debt) row naming this step's dependency on step 20 is the link; removal of the dependency (generalization to environments without full isolation) is deferred until a concrete need arises.

## End-of-step evaluation

Re-read `run-shell.ts` and the sibling tools (including the step-04/05 checker tools). Confirm the timeout path kills the child (no orphaned processes in tests). Ensure stdout/stderr caps use the same truncation helper as the engine where sensible (avoid two truncation mechanisms). Confirm the coder prompt's `run_shell` guidance does not contradict the dedicated-checker-tool guidance from steps 04/05 — `run_shell` is the fallback for uncovered commands, not the primary way to run tests/typecheck.

## Estimated effort

Medium — subprocess + timeout handling needs care, and tests must be platform-robust. Smaller than it would be without step 20, because isolation is already solved.

## Operator handoff

None for the tool code — fully in-memory (tests use portable commands). The real safety properties (no egress, non-root, hermetic fs) are step 20's responsibility and must be in place before this tool is exercised against a real run.
