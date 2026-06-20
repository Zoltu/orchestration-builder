# Step 01 — `write_file` tool

## Goal

Add a `write_file` native tool to the v1 tool set so the executor can materialize file contents on disk. This resolves the Phase 4 closeout blocker: the `coder` role currently has to return file contents in its `finish` summary because no write tool exists, and the `hello_001` smoke benchmark cannot pass end-to-end without one.

## Context

Read [`00-foundation-completed.md`](00-foundation-completed.md), especially the Phase 4 "no file-write tool" note. The v1 tool layer is otherwise complete: native tools live as factories in `source/executor/tools/` and are assembled by `createToolHandlers` in `source/executor/tools.ts`; manifests live as `guild/tools/*.json` and are conformance-tested by `source/executor/tool-manifests.test.ts`. Path sandboxing is handled by `resolveWithinWorkspace` in `source/executor/tools/shared.ts`, which returns a `{ ok } | { error }` union and never throws (see Phase 3 closeout).

## Deliverables

1. `guild/tools/write_file.json` — canonical manifest. Parameters: `path` (string, required, workspace-relative), `content` (string, required). Validate via `validateToolManifest`.
2. `source/executor/tools/write-file.ts` — leaf factory `createWriteFile(workspaceRoot)` returning a `ToolHandler` that:
   - Resolves `path` via `resolveWithinWorkspace`; returns `resolution.error` on escape.
   - Creates parent directories as needed (within the workspace).
   - Writes `content` (UTF-8) and returns `{ kind: 'success', data: { path, bytes } }`.
   - Uses `fs.existsSync` before `fs.mkdirSync`/`fs.writeFileSync` where existence is an expected condition; reserves `try/catch` for genuine I/O errors only (per AGENTS.md "No Try/Catch for Code Flow").
3. `source/executor/tools/write-file.test.ts` — in-memory tests using a temp dir under `os.tmpdir()`, cleaned up in an `afterEach`/`afterAll`. Cover: writes a new file; overwrites an existing file; creates nested parent directories; rejects a path that escapes the workspace; rejects an empty/missing `path` argument; rejects a missing `content` argument.
4. Wire into `createToolHandlers` (`source/executor/tools.ts`).
5. Update `source/executor/tool-manifests.test.ts`: add `write_file.json` to `expectedSignatures`, add `write_file` to the native-names set, and confirm the directory-contents-equality test still passes (it asserts the exact set of manifest files).
6. Update `guild/guild.json`: add `"tools/write_file.json"` to `tools`, and add `write_file` to the `coder` role's `tools` array. (Optionally add to `critic` only if review genuinely needs to write — prefer not.)
7. Update `guild/prompts/coder.md`: replace the "produce contents in your finish summary" instructions with "use `write_file` to write the complete, syntactically valid file" guidance. Keep the "small, testable changes" and "read before editing" guidance.
8. Update `source/executor/seed-guild.test.ts` if its `expectedToolNames` set hard-codes the v1 set (it does) — add `write_file`.

## Module boundaries

- `write-file.ts` is a leaf factory closing over `workspaceRoot`, mirroring the sibling read-only tools.
- It must reuse `resolveWithinWorkspace` from `tools/shared.ts`; do not duplicate path logic.
- No changes to `engine.ts`, `executor.ts`, or `tool-dispatch.ts` — the dispatch mechanism already truncates serialized tool output in the engine.

## Acceptance criteria

- [ ] `bun run typecheck` passes.
- [ ] `bun test source/` passes, including the new `write-file.test.ts` and the updated `tool-manifests.test.ts` / `seed-guild.test.ts`.
- [ ] `write_file` rejects paths outside the workspace with `invalid_arguments` (no exceptions thrown for that expected condition).
- [ ] The conformance test asserts exactly twelve manifest files in `guild/tools/`.
- [ ] `coder.md` instructs the model to call `write_file`, not to return contents in the summary.

## End-of-step evaluation

Re-read `tools.ts`, `tools/shared.ts`, `write-file.ts`, and the updated manifests/tests. Confirm naming is consistent with siblings (`createWriteFile` matches `createReadFile`, etc.), no casts were introduced, and no dead code remains. If the coder prompt change makes any existing seed-guild assertion false, fix the assertion to match the new reality — do not weaken the prompt to satisfy an obsolete test.

## Estimated effort

Small — one new leaf module, one manifest, prompt rewording, and conformance-test updates.

## Operator handoff

None — fully in-memory and verifiable in this environment.
