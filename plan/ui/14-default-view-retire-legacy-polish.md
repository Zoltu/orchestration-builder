# UI step 14 — Make flow view the default; retire legacy panels; final polish

## Goal

Promote the flow-graph view to the **default run view**, remove the now-superseded legacy panels (role-activity table, raw log panel, the step-28 inline questions panel, the standalone config dump) and the phase-A dev playback harness, and do a final polish pass across the whole UI in both light and dark themes. After this step the run view is the product surface described in `PLAN.md`, driven by live data — the sub-plan's completion (minus the deferred step 15).

## Context

Read [`PLAN.md`](PLAN.md) (the complete design) and the closeouts of steps 11–13. By this point the flow view is wired to live data (13) and the visualization was signed off against fixtures (11). The legacy panels from steps 14–21/27/28 are still rendered alongside. This step retires them and finalizes.

## Deliverables

1. **`source/web/static/app.js`** — remove the legacy `RolesPanel`, `LogPanel` (the raw-log panel; the sequence diagram supersedes it for investigation), the inline `QuestionsPanel` (superseded by the step-06 modal), and the standalone `ConfigPanel` (the flow view + node tooltips convey role/tool info; if a static config reference is still wanted, keep a minimal collapsible reference — decide during implementation). Remove the phase-A dev playback harness and the step-02 demo scaffolding. The run view is now: new-run editor + effort (top), sidebar run list (left), and the two-component Flow/Sequence centerpiece with the product surfaces (05) and modals (06, 07).
2. **`source/web/static/flow-graph.js`** — remove any derivation rendered only by the retired panels if no longer referenced. Do not break the `/api/runs/:id` contract; if a field becomes unused by the UI but the server still serves it, leave the server alone and just stop rendering it.
3. **`source/web/static/styles.css`** — final polish: consistent spacing, the focal hierarchy, light and dark both calibrated, no leftover styles for retired panels or the playback harness. Re-read against `AGENTS.md` "Formatting".
4. **`docs/security.md`** — final confirmation that the product run view renders untrusted content only via the step-27 sanitized Markdown path and `textContent`, with all surfaces (flow, sequence, modals, tooltips, product surfaces) covered.
5. **`plan/ui/PLAN.md`** — mark the sub-plan complete (minus deferred step 15) with a dated closeout.

## Module boundaries

- Web-only (plus the browser-pure derivation cleanup in `flow-graph.js`/`sequence-diagram.js`). No backend or endpoint changes this step.
- This is the integration + cleanup step; it must not introduce new features, only assemble (live) and retire.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The two-component flow view is the default run view; the sequence diagram is the debug toggle.
- [ ] The legacy role-activity table, raw-log panel, inline questions panel, config dump, and the dev playback harness are removed.
- [ ] No dead code or orphaned styles remain for retired panels or the harness.
- [ ] The full UI reads well in both light and dark; the focal hierarchy is clear.
- [ ] `docs/security.md` confirms the security invariant holds for the final live view.

## Operator handoff

Final end-to-end review in a browser in both themes against a real multi-role run (local Ollama): submit a task, watch the two-component flow view animate (nodes enter the main area, linger on return, depart to the top bar and merge), answer a question via the modal, reach completion, re-open the result via the CTA, toggle to Sequence and investigate, trigger an error and confirm honest failure surfacing. Sign-off closes the sub-plan (minus deferred step 15); remaining adjustments become follow-up steps if any.
