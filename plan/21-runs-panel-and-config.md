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

- [x] `bun run typecheck` and `bun test source/` pass, including the extended `render.test.ts` and `server.test.ts`.
- [x] `GET /api/config` returns the safe subset and never includes `apiKey` or `apiBase`.
- [x] Each run-list entry has a re-run control that starts a new run with that task and is disabled while a run is active.
- [x] The config panel shows the model name, executor budgets, entry role, and each role's tools.
- [x] All rendering uses `createElement`/`textContent` (no `innerHTML`).

## End-of-step evaluation

Confirm `apiKey` and `apiBase` are absent from the `GET /api/config` response by inspection of `renderConfig` (not just by the current Guild having an empty key — the helper must structurally omit them). Confirm the re-run control's click does not also trigger the list entry's select handler (stop propagation or a separate target). Confirm re-run respects the one-task-at-a-time contract (disabled while active, surfaces the `409` gracefully). Confirm the config panel is rendered once and does not add a polling load.

## Estimated effort

Small to medium — a new read-only endpoint with a pure shaper and tests, plus two small client additions. No executor changes.

## Closeout (2026-06-24)

Complete. `bun run typecheck` and `bun test source/` both pass (406 tests across 29 files).

Changed files:

- `source/web/render.ts` — new pure `renderConfig(config)` helper returning `GuildConfigView` (`{ model: { name, contextWindow }, executor, entryRole, roles: { [name]: { tools } } }`). Only `model.name` and `model.contextWindow` are carried; `apiKey` and `apiBase` are structurally omitted (the helper builds a fresh object picking those two fields only), so the endpoint can never leak the injected key or the endpoint URL regardless of what the loaded Guild contains. The executor budgets are passed through verbatim (operator-facing limits, not secrets); every role contributes its tool list so the panel shows the full role/tool matrix. Role-only fields (`systemPrompt`, `generation`, `budget`, `includeReasoning`) are dropped.
- `source/web/server.ts` — `WebServerConfig` gained a required `guildConfig: GuildConfig` field, closed over once at server construction (the server already has the guild loaded at startup; no per-request file reads). New `GET /api/config` route delegates to `renderConfig`. The route is registered before `/api/runs` so it is not swallowed by the `startsWith('/api/runs/')` branch.
- `source/serve.ts` — passes `loadedGuild.config` as `guildConfig` to `createWebServer` (the guild is already loaded once at startup; no new read).
- `source/web/render.test.ts` — a `renderConfig` describe block covering: the full safe shape; structural omission of `apiKey`/`apiBase` when the Guild carries them (asserted both via `not.toHaveProperty` and by inspecting the serialized JSON for the key value and endpoint host); the same omission when the key is the empty string (so the helper's safety does not depend on the current Guild happening to have an empty key); every role's full tool list including a role with no tools; and that role-only fields are dropped.
- `source/web/server.test.ts` — a `GET /api/config` describe block covering the safe shape, the structural absence of `apiKey`/`apiBase` (and their values in the serialized response), and the entry role plus every role's tool list end to end. A shared `sampleGuildConfig` fixture (carrying a real `apiKey` and `apiBase`) is wired into both the read-only shared server and the per-test submission server.
- `source/web/static/app.js` — two client additions:
  - **Re-run control** — each run-list entry gains a small `re-run` button carrying the task in a `data-task` attribute and bound to a bare-function `RerunTask` action. The action calls `event.stopPropagation()` so the click does not also select the entry, then reuses the create path (`POST /api/runs { task }` → `GotCreatedRun`) so the new run is selected and `justSubmittedRunId` guards the sub-second window before the run appears in the list. The button is disabled under the same condition as the create form (`justSubmittedRunId !== null || an active run exists`), and additionally when the entry has no task (an in-progress run whose meta is not yet written), so the one-task-at-a-time contract holds identically for re-runs. A `409 run_in_progress` (only reachable if a run started between the last poll and the click) resolves to `GotCreatedRun` returning state unchanged — graceful, no crash, no wedge — matching the create form's 409 behavior.
  - **Config panel** — a `ConfigPanel` view rendering the model name, context window, entry role, every executor budget, and each role's tool list (with an `(entry)` marker on the entry role). The config is fetched exactly once via an init effect (`Fetch({ url: 'api/config', ok: GotConfig, fail: FetchFailed })`) and stored in `state.config`; the panel re-renders on state changes but is never polled, so it adds no recurring load. The init state is now `[state, effect]` (hyperapp runs init effects and sets the state) with `config: null` showing a "Loading configuration…" placeholder until the single fetch resolves.
- `source/web/static/styles.css` — styling for the re-run button (matches the log toggle/export button family) and the config panel (meta definition list, budgets line, per-role tool list, entry-role marker).

Deviations / decisions (authoritative):

- **The re-run button reads its task from a `data-task` attribute rather than a hyperapp `[Action, payload]` tuple.** hyperapp passes the DOM event as the payload only to a bare-function handler (a `[Action, payload]` tuple dispatches `Action(state, payload)` without the event), and the action needs the event both to call `stopPropagation()` (so the click does not also trigger the enclosing list entry's `SelectRun`) and to read the task. Storing the task in `data-task` keeps `RerunTask` a stable top-level function (matching the file's other event handlers like `SubmitRun`) rather than a per-render closure, and `event.currentTarget.getAttribute('data-task')` is valid because the action runs synchronously inside the listener before `currentTarget` is reset.
- **The config panel is part of the reactive view, not a one-shot DOM write.** "Rendered once and not polled" is satisfied by fetching the config exactly once (an init effect, never a subscription) — the panel itself re-renders on every state change like every other panel, which is cheap and keeps it consistent with the rest of the hyperapp view. A separate imperative one-shot render would split rendering into two models and gain nothing.
- **The init state became `[state, effect]`.** hyperapp's `dispatch(props.init)` runs init effects and sets the state when init is a `[state, ...effects]` array, so the single config fetch is wired as an init effect rather than a subscription that fires once and immediately cancels.

End-of-step checks: `grep innerHTML source/web/static/` returns no matches. `renderConfig` builds a fresh object picking only `model.name` and `model.contextWindow`, so `apiKey`/`apiBase` cannot appear even when the loaded Guild carries them (covered by a test with a non-empty key and a test with an empty key). The re-run button calls `event.stopPropagation()`; the config fetch is an init effect with no matching subscription. `bun run typecheck` and `bun test source/` pass (406 tests).

No new technical debt introduced.

## Operator handoff

Run the service and confirm: a past run's re-run control starts a new run with the same task (and is rejected/disabled while a run is active); the config panel shows the loaded model name, budgets, and role/tool lists and does not leak the API key. Report any field the operator expected to see that is missing; the agent extends `renderConfig` in-environment.
