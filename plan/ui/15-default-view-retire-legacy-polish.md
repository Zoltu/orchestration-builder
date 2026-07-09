# UI step 15 — Make flow view the default; retire legacy panels; final polish

## Goal

Promote the flow-graph view to the **default run view**, remove the now-superseded legacy panels and the phase-A dev harness, and do a final polish pass across the whole UI in both light and dark themes. After this step the run view is the product surface described in [`PLAN.md`](PLAN.md), driven by live data — the sub-plan's completion (minus the deferred step 16).

## Context

Read [`PLAN.md`](PLAN.md) (the complete design) and the closeouts of steps 12–14. By this point the flow view is wired to live data (14) and the visualization was signed off against fixtures (phase A / MVC step 09). The legacy panels from the earlier main-plan steps (role-activity table, raw log panel, inline questions panel, config dump) are still rendered alongside in `app.js`. This step retires them and finalizes.

## Deliverables

1. **`source/web/static/app.js`** — remove the legacy `RolesPanel`, `LogPanel` (the raw-log panel; the sequence diagram supersedes it for investigation), the inline `QuestionsPanel` (superseded by the question modal), and the standalone `ConfigPanel` (the flow view + node tooltips convey role / tool info; if a static config reference is still wanted, keep a minimal collapsible reference — decide during implementation). The run view is now: new-run editor + effort (top), sidebar run list (left), and the two-component Flow / Sequence centerpiece with the product surfaces and modals.
2. **`source/web/static/flow-view.js` / `sequence-diagram.js`** — remove any derivation rendered only by the retired panels if no longer referenced. Do not break the `/api/runs/:id` or `/api/run/flow` contracts; if a field becomes unused by the UI but the server still serves it, leave the server alone and just stop rendering it.
3. **`source/web/static/app.js` / `index.html`** — remove the dev-harness entry points (`demo.html`, `demo.js`). Keep `scenarios.js` — it is the renderer's in-memory test bed (consumed by `flow-view.test.ts` / `sequence-diagram.test.ts` / `scenarios.test.ts`), not part of the product UI; it stays as fixture data after the dev-harness UI is gone. Confirm removing `demo.html` / `demo.js` leaves the in-memory tests green (the tests import the view modules and `scenarios.js` directly, not via `demo.js`).
4. **`source/web/static/styles.css`** — final polish: consistent spacing, the focal hierarchy, light and dark both calibrated, no leftover styles for retired panels or the harness. Re-read against `AGENTS.md` "Formatting".
5. **`docs/security.md`** — final confirmation that the product run view renders untrusted content only via the step-27 sanitized Markdown path and `textContent`, with all surfaces (flow, sequence, modals, tooltips, product surfaces) covered.
6. **`plan/ui/PLAN.md`** — mark the sub-plan complete (minus deferred step 16) with a dated closeout.

## Module boundaries

- Web-only (plus the browser-pure derivation cleanup in the view modules). No backend or endpoint changes this step.
- This is the integration + cleanup step; it must not introduce new features, only assemble (live) and retire.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The two-component flow view is the default run view; the sequence diagram is the debug toggle.
- [ ] The legacy role-activity table, raw-log panel, inline questions panel, config dump, and the dev harness are removed.
- [ ] No dead code or orphaned styles remain for retired panels or the harness.
- [ ] The full UI reads well in both light and dark; the focal hierarchy is clear.
- [ ] `docs/security.md` confirms the security invariant holds for the final live view.

## Operator handoff

Final end-to-end review in a browser in both themes against a real multi-role run (local Ollama): submit a task, watch the two-component flow view animate (nodes enter the main area, linger on return, depart to the top bar and merge), answer a question via the modal, reach completion, re-open the result via the CTA, toggle to Sequence and investigate, trigger an error and confirm honest failure surfacing. Sign-off closes the sub-plan (minus deferred step 16); remaining adjustments become follow-up steps if any.