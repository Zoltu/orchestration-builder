# Step 18 — `main.ts --serve` wiring

## Goal

Wire the web server into the CLI so `bun source/main.ts --serve <port> --human-backend web ...` starts the executor and the web UI together, with `ask_human` answered through the browser. End-to-end human-in-the-loop now works.

## Context

Read [`02-cli-entry-point.md`](02-cli-entry-point.md) (the CLI exists), [`16-web-human-backend.md`](16-web-human-backend.md), and [`17-web-ui-server.md`](17-web-ui-server.md). The `--serve` flag and `--human-backend web` select the web backend and start the server. The executor runs its sequential loop; when a role calls `ask_human`, the web backend parks the active role until the operator answers in the UI.

## Deliverables

1. `source/main.ts` (extend) — parse `--serve <port>` and `--human-backend <stub|foundry|web>`. When `--serve` is set, construct the web human backend and the web server (step 17) sharing the same run state, start the server, then run the executor. When the run completes, shut the server down.
2. `source/main-args.ts` (extend the pure arg helper from step 02) — handle the new flags; update its tests.
3. Graceful shutdown: on run completion or `SIGINT`, stop the server and write `meta.json`. Keep this thin.
4. `README.md` — document `--serve` and `--human-backend web`.

## Module boundaries

- `main.ts` is the only place assembling the web backend + server + executor together.
- No new logic in the server or backend modules — just wiring.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass (including updated arg tests).
- [ ] `--serve` + `--human-backend web` are parsed correctly (pure-arg test).
- [ ] `bun source/main.ts --help` documents the new flags.
- [ ] `README.md` documents the web-UI invocation.

## End-of-step evaluation

Confirm `main.ts` did not acquire logic — it assembles leaves only. Ensure the arg helper remains pure and fully tested. Verify the shutdown path does not leave the server hanging (testable via the ephemeral-port server test from step 17 if extended).

## Estimated effort

Small — mostly wiring on top of steps 15–16.

## Operator handoff

Run a real web-UI session: `bun source/main.ts --serve 8080 --human-backend web --guild guild --workspace benchmarks/hello_001 --task "..."`. Open `http://localhost:8080`, confirm the run status and log render, and (if the run asks a question) answer it in the UI and confirm the run resumes. Report any UI or plumbing bugs; the agent fixes them in-environment.
