# UI step 16 — Make flow view the default; retire legacy panels; final polish

## Goal

Promote the flow-graph view to the **default run view**, remove the now-superseded legacy panels and the phase-A dev harness, and do a final polish pass across the whole UI in both light and dark themes. After this step the run view is the product surface described in [`PLAN.md`](PLAN.md), driven by live data — the sub-plan's completion (minus the deferred step 17).

## Context

Read [`PLAN.md`](PLAN.md) (the complete design) and the closeouts of steps 12–15. By this point the flow view is wired to live data (14), the visualization tooltips are wired (15), and the visualization was signed off against fixtures (phase A / MVC step 09). The legacy panels from the earlier main-plan steps (role-activity table, raw log panel, inline questions panel, config dump) are still rendered alongside in `app.js`. This step retires them and finalizes.

## Deliverables

1. **`source/web/static/app.js`** — remove the legacy `RolesPanel`, `LogPanel` (the raw-log panel; the sequence diagram supersedes it for investigation), the inline `QuestionsPanel` (superseded by the question modal), and the standalone `ConfigPanel` (the flow view + node tooltips convey role / tool info; if a static config reference is still wanted, keep a minimal collapsible reference — decide during implementation). The run view is now: new-run editor + effort (top), sidebar run list (left), and the two-component Flow / Sequence centerpiece with the product surfaces and modals.
2. **`source/web/static/flow-view.js` / `sequence-diagram.js`** — remove any derivation rendered only by the retired panels if no longer referenced. Do not break the `/api/runs/:id` or `/api/run/flow` contracts; if a field becomes unused by the UI but the server still serves it, leave the server alone and just stop rendering it.
3. **`source/web/static/app.js` / `index.html`** — remove the dev-harness entry points (`demo.html`, `demo.js`). Keep `scenarios.js` — it is the renderer's in-memory test bed (consumed by `flow-view.test.ts` / `sequence-diagram.test.ts` / `scenarios.test.ts`), not part of the product UI; it stays as fixture data after the dev-harness UI is gone. Confirm removing `demo.html` / `demo.js` leaves the in-memory tests green (the tests import the view modules and `scenarios.js` directly, not via `demo.js`).

   > **Revision (operator direction, 2026-07-14):** the dev harness is **retained**, not removed. The operator judged it too valuable for ongoing UI iteration to delete: it is the sub-plan's "fixture-first" iteration surface — instant, deterministic playback of every scenario (retry, pending question, error, deep delegation) without a real run — and `scenarios.js` without `demo.js` is a fixture set with no viewer. `demo.html` / `demo.js` / `#demo-flow-view` styles / the `GET /demo.*` server tests stay. The rest of this deliverable's retire scope (the legacy product panels) is unchanged.
4. **`source/web/static/styles.css`** — final polish: consistent spacing, the focal hierarchy, light and dark both calibrated, no leftover styles for retired panels or the harness. Re-read against `AGENTS.md` "Formatting".
5. **`docs/security.md`** — final confirmation that the product run view renders untrusted content only via the step-27 sanitized Markdown path and `textContent`, with all surfaces (flow, sequence, modals, tooltips, product surfaces) covered.
6. **`plan/ui/PLAN.md`** — mark the sub-plan complete (minus deferred step 17) with a dated closeout.

## Module boundaries

- Web-only (plus the browser-pure derivation cleanup in the view modules). No backend or endpoint changes this step.
- This is the integration + cleanup step; it must not introduce new features, only assemble (live) and retire.

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass.
- [x] The two-component flow view is the default run view; the sequence diagram is the debug toggle.
- [x] The legacy role-activity table, raw-log panel, inline questions panel, and config dump are removed. The dev harness (`demo.html` / `demo.js`) is **retained** (operator direction) as the UI iteration surface; the legacy product panels are gone.
- [x] No dead code or orphaned styles remain for retired panels or the harness.
- [ ] The full UI reads well in both light and dark; the focal hierarchy is clear.
- [x] `docs/security.md` confirms the security invariant holds for the final live view.

## Operator handoff

Final end-to-end review in a browser in both themes against a real multi-role run (the Guild's configured model): submit a task, watch the two-component flow view animate (nodes enter the main area, linger on return, depart to the top bar and merge), hover nodes and edges to confirm the inspector (step 15) still reads after the retire, answer a question via the modal, reach completion, re-open the result via the CTA, toggle to Sequence and investigate, trigger an error and confirm honest failure surfacing. Sign-off closes the sub-plan (minus deferred step 17); remaining adjustments become follow-up steps if any.

## Closeout (2026-07-14)

In-environment complete: `bun run typecheck` and `bun test source/` green (708 tests). The legacy `RolesPanel`, `LogPanel`, the inline `QuestionsPanel`, and `ConfigPanel` are removed from `app.js`, along with the log pagination/export actions, `logRowKey`, `LOG_PAGE_SIZE`/`LOG_EXPORT_LIMIT`, and the `logPage`/`expandedLogRows`/`config` state fields they maintained (`GotConfig` still builds the `labelResolver`/`guildParticipants` the flow view needs; `GotSelectedRun`/`SelectRun`/`GotCreatedRun` no longer touch `logPage`). The dev harness (`demo.html` / `demo.js` / `#demo-flow-view` styles / the `GET /demo.*` server tests) is **retained** per operator direction — it stays the UI's instant, deterministic iteration surface for future work, and `scenarios.js` stays its fixture set (consumed by the in-memory view tests and the harness). `styles.css` drops every orphaned rule for the retired product panels (role-tree/role-pulse/log-*/config-*/question-history/question-form), the reduced-motion `.role-pulse` reference, and reframes the stale "(demo harness)" section headers where the surface is now the product's own; the wide-viewport grid is reduced to `runs`/`submit`/`flow`/`summary`. `RunSummaryPanel` is retained: it carries the task/run id/status/times/error/artifacts the flow view and modals do not surface, the step's explicit remove-list did not include it, and the design notes describe it as the supporting read beneath the focal flow panel. `docs/security.md` adds a final confirmation that the post-retire product run view's complete untrusted-content surface set (flow, sequence, question/result modals, inspector, run-summary markdown, run-list task markdown) reaches the DOM only via the step-27 sanitized Markdown pipeline or as `textContent`. Operator visual sign-off in both themes against a real multi-role run is the remaining gate; it closes the sub-plan minus the deferred, executor-dependent step 17.