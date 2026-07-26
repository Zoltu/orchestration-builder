# Step 30 — `run_shell` tool

## Goal

Add a `run_shell` native tool so the agent can execute arbitrary shell commands inside the run workspace (run builds, inspect output, drive tools the dedicated checker tools do not cover). This is the general-purpose shell capability. The two safe checker tools (`typecheck`, step 04; `test`, step 05) already cover the coding-critical checkers without opening this surface.

## Context

Read `docs/security.md` ("Attack surface", "Mitigations") and `docs/architecture.md` ("Isolation"). The v1 tool layer is sandboxed to the run workspace. `run_shell` runs a command with the workspace as its working directory, under a timeout, and returns stdout/stderr/exit code. Per `docs/reference.md` the failure mode is "Native tool non-zero exit or I/O error → complete the tool call" (the result JSON carries `status: "error"` plus output), so a non-zero exit is **not** an executor error — it is a normal tool result the role can read.

Containment for `run_shell` is expected to come from the deployment environment (non-root user, restricted egress, read-only filesystem, confined writes to `/workspace`). Per-run environment isolation (scoped `PATH`/`HOME`, no global pollution) is part of the Foundry's evaluation setup and will be addressed when the Foundry is built (step 35). This step implements the tool itself; it does not re-solve isolation.

## Deliverables

1. `guild/tools/run_shell.json` — manifest. Parameters: `command` (string, required), `timeoutSeconds` (number, optional; capped by `defaultToolTimeoutSeconds`).
2. `source/executor/tools/run-shell.ts` — leaf factory `createRunShell(workspaceRoot, defaultTimeoutSeconds)` returning a `ToolHandler` that:
   - Spawns the command with `cwd` set to `workspaceRoot` (Bun `Bun.spawn` or `node:child_process`).
   - Enforces the timeout (default from config, overridden up to the cap by `timeoutSeconds`). On timeout, kills the process and returns `{ kind: 'timeout', message, details: { afterSeconds } }`.
   - Captures stdout/stderr (cap their size to avoid blowing context; truncate with a clear marker).
   - Returns `{ kind: 'success', data: { exitCode, stdout, stderr } }` even on non-zero exit. Reserve error `kind` for spawn/IO failures and timeouts, not non-zero exit.
3. `source/executor/tools/run-shell.test.ts` — in-memory tests using a temp dir. Cover: a successful command returns exit code 0 and captured stdout; a failing command returns its non-zero exit code as a **success** result; a command that exceeds the timeout returns `kind: 'timeout'`; stdout truncation kicks in past the cap. Use portable commands (`echo`, `printf`, `false`) so tests are environment-robust; guard with `test.skipIf` where a platform difference is unavoidable.
4. Wire `run_shell` into `createToolHandlers` (`source/executor/tools.ts`).
5. Update `source/executor/tool-manifests.test.ts` (`expectedSignatures`, native-names set) and `source/executor/seed-guild.test.ts` (`expectedToolNames`).
6. Update `guild/guild.json`: add the manifest path and give the `coder` role `run_shell` (so it can run builds/tools the dedicated checkers do not cover). Consider whether the review roles need it (probably not for v1).
7. Update `guild/prompts/coder.md`: instruct the coder that `run_shell` is for commands the dedicated `test`/`typecheck` tools do not cover (builds, ad-hoc inspection), and to prefer the dedicated checker tools for test/typecheck runs. Read failing output rather than guessing.

## Module boundaries

- `run-shell.ts` is a leaf factory closing over `workspaceRoot` and the timeout cap.
- It must not duplicate path logic; `run_shell` does not take a path argument, it uses `cwd`.
- No shell-allowlist logic in v1 — containment comes from the deployment environment, not from an in-tool command filter.

## Acceptance criteria

- [x] `bun run typecheck` passes.
- [x] `bun test source/` passes, including `run-shell.test.ts` and the updated conformance/seed-guild tests.
- [x] A non-zero exit code is returned as `{ kind: 'success', data: { exitCode, ... } }`, not as an error.
- [x] A timed-out command returns `{ kind: 'timeout', details: { afterSeconds } }`.
- [x] The conformance test asserts the new manifest count.

## End-of-step evaluation

Re-read `run-shell.ts` and the sibling tools (including the step-04/05 checker tools). Confirm the timeout path kills the child (no orphaned processes in tests). Ensure stdout/stderr caps use the same truncation helper as the engine where sensible (avoid two truncation mechanisms). Confirm the coder prompt's `run_shell` guidance does not contradict the dedicated-checker-tool guidance from steps 04/05 — `run_shell` is the fallback for uncovered commands, not the primary way to run tests/typecheck.

## Estimated effort

Medium — subprocess + timeout handling needs care, and tests must be platform-robust.

## Operator handoff

None for the tool code — fully in-memory (tests use portable commands). The real safety properties (no egress, non-root, hermetic fs) are the deployment environment's responsibility and should be in place before this tool is exercised against a real run with untrusted input.

## ⚠️ Testing caution

`run_shell` executes arbitrary shell commands. When testing against a real LLM, the model may generate destructive commands (e.g. `rm -rf`, process spawning, network calls). Test only in an isolated environment (a throwaway container or VM) with the workspace mounted as a throwaway copy. Do not test in the development environment — a confused model can wreck it.

## Closeout (2026-07-23)

✅ complete (in-environment). `bun run typecheck` and `bun test source/` green (779 pass). No real-LLM smoke run was done: the testing caution above forbids exercising `run_shell` against a real model in the development environment, and the step's gate is the in-memory suite (which includes real-`sh` temp-dir tests through `createBunSubprocessRunner`).

### Deviations from the plan wording

- **`run-shell.ts` reuses the shared subprocess machinery instead of duplicating it.** The deliverable text implied a standalone leaf; instead `SubprocessToolConfig.command` became a `CommandSource` union — a fixed argv for the checkers (pinned in the leaf, as before) or a resolver for `run_shell` that validates the `command` argument and builds `['sh', '-c', command]`, returning an error result rather than throwing. `createRunShell` is then as thin as `createTypecheck`/`createTest`, and there is exactly one timeout-clamp / truncation / result-shaping path (`createSubprocessTool` → `truncateToolOutput`), as the end-of-step evaluation requires. `sh -c` gives real shell semantics (pipes, redirects, `&&`), covered by a real-runner test.
- **The runner's timeout path was fixed for shell grandchildren.** `createBunSubprocessRunner` previously awaited pipe end after killing the child; a killed shell's orphaned grandchildren keep the pipes open, so a timed-out `sh -c 'sleep 10'` hung the tool result for the full 10s (reproduced in-environment). Streams are now drained through an explicit reader (`drainStream`) whose `cancel` the timeout path awaits, settling promptly with the partial output captured before the kill. Without this fix the acceptance criterion "a timed-out command returns `kind: 'timeout'`" fails through the real shell path. The checkers are unaffected (their direct child holds the pipes). A killed command's grandchildren are still not reaped (no portable process-group kill through `Bun.spawn`); they run to completion in the background — reaping is the deployment environment's job, per this step's containment stance.
- **Three stale doc lines updated.** `docs/reference.md` ("lands after per-run environment isolation"), `docs/security.md` ("ships only after per-run environment isolation lands"), and `docs/architecture.md` ("future work that unblocks the `run_shell` tool") all described `run_shell` as not-yet-landed; they now state the step-29 containment stance (containment from the deployment environment; per-run isolation is Foundry work; no in-tool allowlist). The `run_shell` allowlist debt row in `plan/README.md` (owned by step 29, removed in step 35) is intentionally left in place.
- **Review roles were not given `run_shell`** (the step's "probably not for v1" consideration): the step-29 brainstorm pinned reviewers as read-only leaves, so only the `coder` received it.
- **`tools.test.ts`'s handler-key list was updated** alongside the conformance tests the deliverables named; it pins the same native tool set.

### End-of-step confirmation

The timeout path kills the child and returns promptly (the real-runner `sleep 10` test returns `kind: 'timeout'` with `details.afterSeconds` in ~0.2s; the full suite runs in under 3s). stdout/stderr caps use the single shared truncation helper. The coder prompt's "Running other commands" section positions `run_shell` strictly as the fallback for commands the dedicated checkers do not cover and defers to `typecheck`/`test` for test/typecheck runs — no contradiction with the "Verifying changes" section. No `as` casts, no non-null assertions, no control-flow try/catch introduced (the runner's spawn try/catch is the pre-existing exceptional-case boundary).
