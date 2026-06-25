# Step 24 — Effort slider UI

## Goal

Add the operator-facing control for the effort channel (step 23): a speed-vs-quality slider in the create-run form, defaulted from the project setting, adjustable before each task, and persisted to `.orchestration/settings.json` when changed. The slider is disabled while a run is active. This step consumes the `POST /api/runs { task, effort }`, `GET /api/settings`, and `PUT /api/settings` endpoints step 23 exposes; no executor changes.

## Context

Read [`23-effort-channel.md`](23-effort-channel.md) (the API this UI consumes and the 0–5 effort scale), [`14-multi-run-ui.md`](14-multi-run-ui.md) (the create-run form and the `justSubmittedRunId`/`activeRunId` form-state logic this extends), and `source/web/static/app.js` (`submitCreateRun`, `updateFormState`, the `textContent`-only security invariant).

The slider is the operator's primary per-task knob. It must read the project default on load, reflect a per-task override before submission, and persist a change so the next run inherits it. The semantics the operator approved: a 0–5 integer with quality-graded labels, not adjustable mid-run.

## Deliverables

1. `source/web/static/app.js` — add an effort slider (`<input type="range" min="0" max="5" step="1">`) beside the create-run input, with six quality-graded labels (e.g. `0` "fastest" … `5` "highest quality"). On load, fetch `GET /api/settings` and set the slider to the persisted default. On `change` (slider release) or on submit, `PUT /api/settings { effort }` to persist the new default so the next run inherits it. The submit includes the current slider value as `POST /api/runs { task, effort }`. The slider is disabled (with its label greyed) while `justSubmittedRunId !== null || activeRunId !== null`, matching the create-button disable logic. All rendering uses `createElement`/`textContent`.
2. `source/web/static/index.html` — add the slider and its label container to the create-run form, ahead of the submit button.
3. `source/web/static/styles.css` — styling for the slider, its labels, and the disabled state.

## Module boundaries

- This step touches only `source/web/static/` (HTML/CSS/JS). No server or executor changes — the API contract is step 23's concern.
- `app.js` is plain browser JS and is not unit-tested (per the testing policy, thin integration layers wired to the DOM are not tested); the server tests cover the API contract it consumes. The implementing agent verifies the UI manually (operator handoff).
- If the rewrite surfaces a genuine server-API gap (e.g. the slider needs a field the API does not return), that is a step-23 concern — record it and propose folding the server fix back into step 23 rather than expanding this step into the backend.

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass (no source-under-test changes; only static assets change).
- [x] The slider loads at the persisted project default (via `GET /api/settings`); changing it persists the new default (via `PUT /api/settings`).
- [x] A submission includes the current slider value as the run's `effort`; the created run's view reflects it.
- [x] The slider is disabled while a run is active and re-enabled on completion.
- [x] All rendering uses `createElement`/`textContent` (no `innerHTML`); no untrusted content reaches the DOM as markup.

## End-of-step evaluation

Re-read `app.js` for `innerHTML` absence on every untrusted-content path (the slider labels are static and trusted, but the create-run flow and run views still render untrusted task text/results). Confirm the slider's persisted default does not race a submission: a `PUT` in flight when the operator hits submit must not leave the run's effort and the persisted default inconsistent (submit reads the slider's current value, which is the source of truth for the run; the `PUT` only updates the default for the *next* run). Confirm the disabled-while-active state cannot be bypassed (the slider, like the button, must not accept input while a run is in flight).

## Estimated effort

Small — a slider, a settings fetch on load, a persist-on-change, and threading the value into the existing submit. All against a stable API from step 23.

## Operator handoff

Run the service and exercise the slider in a browser: confirm it loads at the persisted default, changing it persists across a page reload, a submission carries the slider's value into the run's view, the slider disables during a run and re-enables on completion. The run's *behavior* will not change with the slider until step 25 lands the Guild prompts — verify only the control's mechanics. Report any UI bugs; the agent fixes them in-environment.

## Closeout (2026-06-25)

`bun run typecheck` and `bun test source/` pass (476 tests; no source-under-test changed — only `source/web/static/`). The UI ships a **single** effort slider in the create-run form whose position is saved as the default for the next run, per operator direction (a second "Default effort" slider in the config panel was rejected as redundant — one control that remembers its last position is clearer than two controls for the same axis).

Behavior of the single slider:

- On load, `GET /api/settings` initializes the slider to the persisted position (or `DEFAULT_EFFORT` 3 when no position is saved yet or the fetch fails), so it opens where the operator last left it.
- `oninput` updates the readout live as the slider is dragged (pure state, no request).
- `onchange` (slider release) `PUT /api/settings { effort }` persists the chosen position — one request per adjustment, not a stream of in-flight PUTs — so the next run (and a page reload) inherits it. A "saving…" note shows while the PUT is in flight.
- The slider's current value is sent on every `POST /api/runs` (and on re-run) as the run's `effort`.
- The slider is disabled while a run is active (same condition as the Start button), matching the not-adjustable-mid-run contract.

Additional surfaces so the chosen effort is visible beyond the moment of submission: the selected run's "Effort" row in `RunSummaryPanel` (`<run effort> — <label>`), and an `effort <n>` pill on each run-list entry that has one. Both read the run's persisted `effort`, not the slider.

The slider uses the six quality-graded labels `fastest` / `quick` / `moderate` / `standard` / `thorough` / `highest quality` with a live `"<n> — <label>"` readout.

Deviations from the plan wording:

- **One slider, persisted-on-release, not two.** The plan's deliverable described a single slider that both submits the per-run effort and persists the default on change; an earlier draft of this step had split it into two controls (a per-run slider and a separate "Default effort" slider in the config panel). The operator directed the single-slider design back, which is what ships: one slider whose `onchange` saves its position as the default.
- **`index.html` is unchanged.** The UI is fully Hyperapp-rendered into `<div id="app">`; the slider is built in `app.js` like every other control, so no HTML edit is needed. The plan's reference to `submitCreateRun`/`updateFormState`/`index.html` form markup was aspirational and did not match the actual client architecture.
- **Security invariant.** The plan referenced `createElement`/`textContent`; the actual client uses hyperapp's `h()` with text-node arguments, which places untrusted content into text nodes and properties (never markup) — the same invariant, satisfied by the existing mechanism. `grep -rn innerHTML source/web/static/` returns nothing.

Operator handoff stands: verify the slider's mechanics in a browser (loads at the saved position, release persists across a page reload, submit carries the value into the run's view, disables during a run and re-enables on completion). Run behavior still does not change with the slider until step 25.
