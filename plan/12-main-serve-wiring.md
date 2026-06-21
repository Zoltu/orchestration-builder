# Step 12 — `main.ts --serve` wiring

## Goal

Wire the web server into the CLI so `bun source/main.ts --serve <port> --human-backend web ...` starts the executor and the web UI together, with `ask_human` answered through the browser. End-to-end human-in-the-loop now works.

## Context

Read [`02-cli-entry-point.md`](02-cli-entry-point.md) (the CLI exists), [`10-web-human-backend.md`](10-web-human-backend.md), and [`11-web-ui-server.md`](11-web-ui-server.md). The `--serve` flag and `--human-backend web` select the web backend and start the server. The executor runs its sequential loop; when a role calls `ask_human`, the web backend parks the active role until the operator answers in the UI.

## Deliverables

1. `source/main.ts` (extend) — parse `--serve <port>` and `--human-backend <stub|foundry|web>`. When `--serve` is set, construct the web human backend and the web server (step 11) sharing the same run state, start the server, then run the executor. When the run completes, shut the server down.
2. `source/main-args.ts` (extend the pure arg helper from step 02) — handle the new flags; update its tests.
3. Graceful shutdown: on run completion or `SIGINT`, stop the server and write `meta.json`. Keep this thin.
4. `README.md` — document `--serve` and `--human-backend web`.

## Module boundaries

- `main.ts` is the only place assembling the web backend + server + executor together.
- No new logic in the server or backend modules — just wiring.

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass (including updated arg tests).
- [x] `--serve` + `--human-backend web` are parsed correctly (pure-arg test).
- [x] `bun source/main.ts --help` documents the new flags.
- [x] `README.md` documents the web-UI invocation.

## End-of-step evaluation

Confirm `main.ts` did not acquire logic — it assembles leaves only. Ensure the arg helper remains pure and fully tested. Verify the shutdown path does not leave the server hanging (testable via the ephemeral-port server test from step 11 if extended).

## Estimated effort

Small — mostly wiring on top of steps 10–11.

## Operator handoff

Run a real web-UI session: `bun source/main.ts --serve 8080 --human-backend web --guild guild --workspace benchmarks/hello_001 --task "..."`. Open `http://localhost:8080`, confirm the run status and log render, and (if the run asks a question) answer it in the UI and confirm the run resumes. Report any UI or plumbing bugs; the agent fixes them in-environment.

## Closeout (2026-06-21)

Complete. `bun run typecheck` and `bun test source/` both pass (367 tests across 31 files). The arg parser adds 7 tests (`source/main-args.test.ts`); the rest of the suite is unchanged.

Changed files:

- `source/main-args.ts` — `ParsedCliArgs` gains `serve?: number`; `--serve` joins `VALUE_FLAGS`; a `parsePort` helper accepts only plain decimal-digit strings in `1..65535` (rejecting `0x1a`, `1e3`, `8080.0`, ` 8080 ` rather than letting `Number()` coerce them); `usage()` documents `--serve`.
- `source/main-args.test.ts` — coverage for `--serve <port>`, `--serve=<port>`, absent `--serve`, non-numeric / out-of-range / `0` rejection, and `usage()` mentioning `--serve`.
- `source/executor/index.ts` — the barrel now also exports `createWebHumanBackend`/`WebHumanBackend`, `createRunState`/`RunState`, and `createReadRunSnapshot`/`ReadRunSnapshot` so `main.ts` can assemble the web wiring through the public surface.
- `source/main.ts` — `assembleHumanBackend(cli, runId)` is the wiring point: when `--serve` is set it builds one `WebHumanBackend`, wraps it in a `RunState` and a `createReadRunSnapshot` leaf pointed at the same run dir the executor writes, and starts the web server; the same backend instance is handed to the executor so `ask_human` parks and the UI answers. `run()` wraps `runExecutor` in `try/finally` so the server stops on completion or failure; a `SIGINT` handler stops the server and exits `130`. `buildHumanBackend` (non-serve path) now rejects `web` (needs `--serve`) and `foundry` (needs the Foundry loop).
- `README.md` — `--serve` documented in the flags list; a "Web UI (human-in-the-loop)" subsection shows the `--serve <port>` invocation and the answer/resume flow.

Deviations from the plan wording (authoritative):

- **`main.ts` now imports `createWebServer` from `./web/server.js` directly, not via the executor barrel.** Step 02's closeout established "main.ts imports exclusively from `./executor/index.js` and `./main-args.js`." Re-exporting `source/web/server.ts` from `source/executor/index.ts` would create a circular barrel dependency (`executor/index` → `web/server` → `executor/persistence` + `executor/run-state`), so the web server is imported from its own module. The executor-resident pieces (`createWebHumanBackend`, `createRunState`, `createReadRunSnapshot`) still come through the barrel. `main.ts` imports from exactly three modules: `./main-args.js`, `./executor/index.js`, `./web/server.js`.
- **`--serve` implies `--human-backend web`; the compatibility check lives in `main.ts`, not the parser.** The parser stays purely syntactic (it still accepts all three `--human-backend` modes standalone, so the step-02 "accepts all documented human-backend modes" test is unchanged). `main.ts` enforces the runtime contract: `--serve` rejects an explicit `stub`/`foundry` backend, and `--human-backend web` without `--serve` is rejected (nothing could answer a parked question). These are configuration-resolution decisions in the integration shell, not testable business logic, so they are not unit-tested per the testing policy.
- **`meta.json` on `SIGINT` is not written.** The plan said "on run completion or `SIGINT`, stop the server and write `meta.json`." On completion the executor already writes `meta.json` (unchanged). On `SIGINT` the run is interrupted mid-flight and the executor's result state is not available at the `main` level, so fabricating a `meta.json` would be guesswork; the handler instead stops the server and exits `130`. "Keep this thin" governed this decision.
- **The server's `readRunSnapshot` reads the same on-disk `meta.json`/`log.jsonl` the executor writes**, so the UI tails the live run without any new coupling between the server and executor internals. No logic was added to `server.ts` or `human-backend.ts` — only wiring.

End-of-step grep check: the only *new* leaf-factory assembly site introduced by this step is `source/main.ts` (it now also assembles `createWebHumanBackend`, `createRunState`, `createReadRunSnapshot`, `createWebServer`). The step-11 `server.test.ts` and step-10 backend tests assemble the same factories in-memory and are unchanged.

No new technical debt introduced.
