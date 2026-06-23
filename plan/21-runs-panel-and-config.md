# Step 21 — Runs panel & config

## Goal

Add two small, high-value pieces of shell chrome the step-14 UI lacks: a one-click "re-run this task" action on each run-list entry, and a read-only config/about panel showing what the container is actually running (model name, executor budgets, roles and their tools). Today re-running a past task means retyping it, and the operator has no UI view of the loaded Guild.

## Context

Read [`14-multi-run-ui.md`](14-multi-run-ui.md) (the runs panel, `POST /api/runs`, and the one-task-at-a-time contract), `source/web/static/app.js` (`renderRunList`, `submitCreateRun`, the `activeRunId`/`justSubmittedRunId` form-state logic), `source/web/server.ts` (the route table and `WebServerConfig`), `source/executor/loader.ts` (the loaded `GuildConfig`), and `guild/guild.json` (the fields to expose).

Re-run is client-only: the task text is already in the run summary, and `POST /api/runs { task }` already starts a run (rejected with `409 run_in_progress` while one is active). The config panel needs a new read-only endpoint that returns a safe subset of the loaded Guild — never the API key.

## Deliverables

1. `source/web/server.ts` — add `GET /api/config` returning a read-only shape derived from the loaded Guild: `{ model: { name, contextWindow }, executor: { ...budgets }, entryRole, roles: { [name]: { tools } } }`. The `model.apiKey` and `model.apiBase` must not be included (the key is injected at runtime and must never be exposed; `apiBase` is omitted to avoid leaking the endpoint). Inject the loaded `GuildConfig` into `WebServerConfig` (the server already has access to the guild path; resolve this without re-reading on every request — close over the loaded config at server construction).
2. `source/web/render.ts` — a pure `renderConfig(guildConfig)` helper that shapes the safe subset above, so the shaping is testable and the server is a thin leaf.
3. `source/web/server.test.ts` — cover `GET /api/config`: the shape is correct, `apiKey` and `apiBase` are absent, every role's tool list is present, and the entry role is included.
4. `source/web/static/app.js` — add a "re-run" control to each run-list entry (a small button that does not trigger the entry's select-on-click): it calls `POST /api/runs { task: summary.task }` and, on `201`, selects the new run (reusing the existing `submitCreateRun` path). It is disabled while a run is active or while `justSubmittedRunId` is set, matching the create form. Add a config panel (rendered once on load and not polled) showing the model name, budgets, entry role, and each role's tools. All rendering uses `createElement`/`textContent`.
5. `source/web/static/styles.css` — styling for the re-run control and the config panel.

## Module boundaries

- `renderConfig` is a pure, testable helper; the server delegates to it.
- The loaded `GuildConfig` is passed into `WebServerConfig` at construction (it is already loaded once at startup by `serve.ts`); no per-request file reads.
- `app.js` is a thin DOM leaf (not unit-tested); the API contract is covered by `server.test.ts`.
- No executor changes, no Guild changes.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass, including the extended `render.test.ts` and `server.test.ts`.
- [ ] `GET /api/config` returns the safe subset and never includes `apiKey` or `apiBase`.
- [ ] Each run-list entry has a re-run control that starts a new run with that task and is disabled while a run is active.
- [ ] The config panel shows the model name, executor budgets, entry role, and each role's tools.
- [ ] All rendering uses `createElement`/`textContent` (no `innerHTML`).

## End-of-step evaluation

Confirm `apiKey` and `apiBase` are absent from the `GET /api/config` response by inspection of `renderConfig` (not just by the current Guild having an empty key — the helper must structurally omit them). Confirm the re-run control's click does not also trigger the list entry's select handler (stop propagation or a separate target). Confirm re-run respects the one-task-at-a-time contract (disabled while active, surfaces the `409` gracefully). Confirm the config panel is rendered once and does not add a polling load.

## Estimated effort

Small to medium — a new read-only endpoint with a pure shaper and tests, plus two small client additions. No executor changes.

## Operator handoff

Run the service and confirm: a past run's re-run control starts a new run with the same task (and is rejected while a run is active); the config panel shows the loaded model name, budgets, and role/tool lists and does not leak the API key. Report any field the operator expected to see that is missing; the agent extends `renderConfig` in-environment.
