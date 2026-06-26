# UI step 07 — Result modal + CTA + failure surfacing

## Goal

On run completion, show the result in a **modal only** (no persistent panel). Provide a clearly-placed **"View result"** CTA button to re-open it after the user closes it. Surface **failure** with red lines/nodes in the main area's active path and error status on the failing role's top-bar node, plus a copyable raw error block with honest framing — no happy-talk translation. Iterated against the success and error fixtures.

## Context

Read [`PLAN.md`](PLAN.md) ("Result = modal only", "Failure"), [`06-human-question-modal-you-node.md`](06-human-question-modal-you-node.md) (the modal pattern this reuses), `source/web/render.ts` (`RunView.result` — the `ResultCard` with status/summary/artifacts; `RunView.error` — the `{ kind, message }`), and `source/executor/types.ts` (`ResultCard`, `ErrorKind`). The run view already carries `result` and `error`; this step presents them as a completion modal + flow-view failure state.

## Deliverables

1. **`source/web/static/app.js`** — a `ResultModal` component fired once when the selected run transitions to a terminal status (`success`/`error`/`needs_clarification`), showing: the result summary (sanitized Markdown), status, and artifacts list (paths as text). On `error`, show the raw error `message` (sanitized Markdown) in a copyable block with honest framing ("Something went wrong — here's what the system reported; copy this to share with support or your own assistant"); hide the machine `kind`. A "copy raw" button copies the full error object as JSON. In the playback harness, the success and error fixtures exercise both paths.
2. **`source/web/static/app.js`** — a **"View result"** CTA button placed where it's easy to find (candidate: the sidebar run row's actions line next to re-run, or the run-summary area header — decide during implementation). Re-opens the `ResultModal` on demand. Quiet after first dismissal but always reachable.
3. **`source/web/static/flow-graph.js`** — extend the flow graph so a failed run colors the active path's edges/nodes red in the main area (`error` state, already supported by the step-02 primitives) and the failing role's top-bar node shows error status. Pure derivation; covered by `flow-graph.test.ts` against the error + retry fixtures.
4. **`source/web/static/styles.css`** — result modal + CTA + error-block styling, theme-aware. Red calibrated for both light and dark (not pure `#ff0000`).
5. **`docs/security.md`** — note the result summary and error message are sanitized Markdown; artifacts are text paths; the error `kind` is intentionally not surfaced to the user.

## Module boundaries

- Web-only, fixture-driven. No backend or endpoint changes. Reuses the modal overlay pattern from step 06.
- The completion modal is non-transient only in the sense that the CTA re-opens it; no dedicated persistent real estate (per `PLAN.md`).

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] Run completion (the success fixture) fires the result modal once; the "View result" CTA re-opens it.
- [ ] A failed run (the error fixture) colors the active path red in the main area and shows error status on the failing role's top-bar node; the error `message` (sanitized Markdown) shows with a copy-raw button; the `kind` is hidden.
- [ ] The result summary and artifacts render correctly; artifacts are text paths.
- [ ] Everything reads correctly in light and dark.

## Operator handoff

Load the success and error fixtures in the playback harness. Confirm the result modal fires, the CTA re-opens it, and the failure surfaces honestly with a working copy-raw. Report adjustments.
