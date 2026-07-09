# UI step 14 — Hook up to real backend (replace fixtures with live data)

## Goal

Swap the fixture data source for the live backend: the canonical view modules (`flow-view.js`, `sequence-diagram.js`) now read the live `InteractionModel` from `/api/run/flow` (step 13's endpoint) + the live `/api/config` (step 12's tiered labels), instead of the hand-authored `scenarios.js` fixtures. The visualization is unchanged — this is a data-source swap, not a rewrite, because phase A + the MVC refactor rendered the exact `InteractionModel` contract step 13 produces. The dev harness (`demo.html` / `demo.js`) is retained this step for parity comparison; it is removed in step 15.

## Context

Read [`PLAN.md`](PLAN.md) ("Methodology", "Around the views"), [`13-backend-interaction-model-adapter.md`](13-backend-interaction-model-adapter.md) (the live endpoint now serves the `InteractionModel` the views expect), `docs/visualization.md` ("Labels", "Backend adapter"), and the phase-A view modules (`source/web/static/flow-view.js`, `sequence-diagram.js`, `interaction-model.js`, `labels.js`). `labels.js`'s `createLabelResolver(config)` already consumes the `/api/config` shape (step 12's tiered labels). `flow-view.js` / `sequence-diagram.js` already consume an `InteractionModel` frame; in phase A the frame came from `scenarios.js`, now it comes from `/api/run/flow`.

## Deliverables

1. **`source/web/static/app.js`** — wire the product run view to fetch `/api/config` (once, on load — the guild is stable for the server's life) and `/api/run/flow` (or `/api/runs/:id/flow` for a selected historical run) on the existing poll, feed them to `createLabelResolver` and the canonical view modules, and render the two-component Flow / Sequence view from live data as the run centerpiece. The new-run editor, effort slider, sidebar run list, and the existing submit / select / run-switching logic stay. The pending-questions poll drives the question modal from live `/api/questions`; the answer submit posts to `/api/answer`. Run completion drives the result modal from the live `runView.result` / `error`. Decide during implementation whether the flow endpoint also carries `result` / `error` / `questionHistory` / `budgets` for the product surfaces, or the client fetches both `/api/run/flow` and `/api/runs/:id` — the latter is the smaller change (the run-view route already serves those fields).
2. **`source/web/static/flow-view.js` / `sequence-diagram.js`** — no derivation changes expected (they already consume the `InteractionModel` shape). If a live-data edge case reveals a gap (a log event shape the fixtures didn't cover, surfaced via step 13's adapter), fix the **adapter** (step 13) and add a fixture covering it so the renderer test stays in-memory; do not patch the renderer around an adapter bug.
3. **`source/web/static/app.js` / `index.html`** — keep the dev harness (`demo.html` / `demo.js`) accessible this step (e.g. behind a dev flag or a separate route) so the operator can compare the live view against the fixture-driven scenarios and confirm parity. Removed in step 15. (`scenarios.js` is the renderer's in-memory test bed and stays regardless.)
4. **`docs/security.md`** — confirm the live-data view preserves the security invariant: agent prose from live runs (operation `details`, task / result / error text) flows only through the step-27 sanitized Markdown path; machine fields (identifiers, counters, costs, timestamps) are `textContent` / JSON values. Live data is untrusted exactly as fixture data was.

## Module boundaries

- Web-only. No backend or endpoint changes (step 12 added the label fields to `/api/config`; step 13 added `/api/run/flow`; the run / log / questions / answer routes already exist). No new dependencies.
- The view modules are not rewritten — only their data source changes. If a derivation must change, that signals a step-13 adapter gap and a fixture must be added to cover it in-memory.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The Flow and Sequence views render from live `/api/config` + `/api/run/flow`.
- [ ] The question modal is driven by live `/api/questions` + `/api/answer`.
- [ ] The result modal fires on live run completion.
- [ ] The visualization against a live run matches the fixture-driven visualization for the equivalent scenario (operator confirms parity against the retained dev harness).
- [ ] The security invariant holds for live (untrusted) data.

## Operator handoff

Run a real task against a local Ollama model (see `AGENTS.md` "Local test model" — `qwen3.5:9b` for a basic multi-role smoke test) and watch the live Flow view: confirm the two-component view animates (nodes enter, linger, depart to the top bar), a real `ask_human` opens the modal, completion fires the result modal, and the live view matches the fixture-driven behavior. Compare against the dev harness for parity. Report any live-data edge case the fixtures (and step 13's adapter) missed.