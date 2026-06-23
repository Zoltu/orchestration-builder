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

- [ ] `bun run typecheck` and `bun test source/` pass (no source-under-test changes; only static assets change).
- [ ] The slider loads at the persisted project default (via `GET /api/settings`); changing it persists the new default (via `PUT /api/settings`).
- [ ] A submission includes the current slider value as the run's `effort`; the created run's view reflects it.
- [ ] The slider is disabled while a run is active and re-enabled on completion.
- [ ] All rendering uses `createElement`/`textContent` (no `innerHTML`); no untrusted content reaches the DOM as markup.

## End-of-step evaluation

Re-read `app.js` for `innerHTML` absence on every untrusted-content path (the slider labels are static and trusted, but the create-run flow and run views still render untrusted task text/results). Confirm the slider's persisted default does not race a submission: a `PUT` in flight when the operator hits submit must not leave the run's effort and the persisted default inconsistent (submit reads the slider's current value, which is the source of truth for the run; the `PUT` only updates the default for the *next* run). Confirm the disabled-while-active state cannot be bypassed (the slider, like the button, must not accept input while a run is in flight).

## Estimated effort

Small — a slider, a settings fetch on load, a persist-on-change, and threading the value into the existing submit. All against a stable API from step 23.

## Operator handoff

Run the service and exercise the slider in a browser: confirm it loads at the persisted default, changing it persists across a page reload, a submission carries the slider's value into the run's view, the slider disables during a run and re-enables on completion. The run's *behavior* will not change with the slider until step 25 lands the Guild prompts — verify only the control's mechanics. Report any UI bugs; the agent fixes them in-environment.
