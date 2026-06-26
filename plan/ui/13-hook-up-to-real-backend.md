# UI step 13 — Hook up to real backend (replace fixtures with live data)

## Goal

Swap the fixture data source for the real backend: the phase-A derivation functions (designed from the start to consume the real `/api/config` + `/api/runs/:id` shape) now read live data. The visualization is unchanged — this is a data-source swap, not a rewrite, because phase A consumed the real shape against fixtures. The dev playback harness is retained this step for comparison; it is removed in step 14.

## Context

Read [`PLAN.md`](PLAN.md) ("Methodology: fixture-first, backend-last"), [`12-guild-human-facing-labels.md`](12-guild-human-facing-labels.md) (the live `/api/config` now carries the friendly labels the UI expects), and the phase-A derivation/view steps (03–10). The derivation functions (`deriveFlowGraph`, `deriveFlowAnimation`, `deriveNowCaption`, `deriveSequenceDiagram`) already consume `{ config, runView, now }`; in phase A `config` and `runView` came from fixtures, now they come from `/api/config` and `/api/runs/:id`. The polling loop in `app.js` already refreshes `/api/runs/:id`; the flow view re-derives on each poll (no streaming needed — see step 04).

## Deliverables

1. **`source/web/static/app.js`** — wire the run view to fetch `/api/config` (once, on load — the guild is stable for the server's life) and `/api/runs/:id` (on the existing poll), feed them to the phase-A derivation functions, and render the two-component Flow/Sequence view from live data. The new-run editor, effort slider, sidebar run list, and the existing submit/select/run-switching logic stay. The pending-questions poll drives the question modal from live `/api/questions`; the answer submit posts to `/api/answer` (existing routes). Run completion drives the result modal from the live `runView.result`/`error`.
2. **`source/web/static/flow-graph.js`** — no derivation changes expected (they already consume the real shape). If a live-data edge case reveals a derivation gap (e.g. a log event shape the fixtures didn't cover), fix the derivation and add a fixture covering it so the test stays in-memory.
3. **`source/web/static/app.js`** — keep the dev playback harness accessible this step (e.g. behind a dev flag) so the operator can compare the live view against the fixtures and confirm parity. Removed in step 14.
4. **`docs/security.md`** — confirm the live-data view preserves the security invariant: agent prose from live runs flows only through the sanitized Markdown path; machine fields are `textContent`. Live data is untrusted exactly as fixture data was.

## Module boundaries

- Web-only. No backend or endpoint changes (step 12 already added the label fields to `/api/config`; the run/log/questions/answer routes already exist). No new dependencies.
- The derivation functions are not rewritten — only their data source changes. If a derivation must change, that signals a phase-A gap and a fixture must be added to cover it in-memory.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The Flow and Sequence views render from live `/api/config` + `/api/runs/:id`.
- [ ] The question modal is driven by live `/api/questions` + `/api/answer`.
- [ ] The result modal fires on live run completion.
- [ ] The visualization against a live run matches the fixture-driven visualization for the equivalent scenario (operator confirms parity).
- [ ] The security invariant holds for live (untrusted) data.

## Operator handoff

Run a real task against a local Ollama model (see `AGENTS.md` "Local test model" — `qwen3.5:9b` for a basic multi-role smoke test) and watch the live Flow view: confirm the two-component view animates (nodes enter, linger, depart to the top bar), a real `ask_human` opens the modal, completion fires the result modal, and the live view matches the fixture-driven behavior. Compare against the playback harness for parity. Report any live-data edge case the fixtures missed.
