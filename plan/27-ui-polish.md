# Step 27 — UI polish

## Goal

Pretify the web UI into a legible, calm interface a non-developer can live with — visual hierarchy, spacing, color, typography, and responsive layout — without changing the data model or endpoints. This is the design pass over the functional UI delivered by steps 14–21 and 26, after the seed Guild (step 25) is real-world-exercised and the Markdown rendering (step 26) is in.

## Context

Read the closeout of [`25-seed-guild-buildout.md`](25-seed-guild-buildout.md) (real-world UI pain points the operator surfaced), [`14-multi-run-ui.md`](14-multi-run-ui.md) and [`17-per-run-view-readability.md`](17-per-run-view-readability.md) (the current UI surface and its security invariant), `source/web/static/index.html`, `source/web/static/styles.css`, and `source/web/static/app.js`. The UI today is functional but utilitarian: a flat list of panels, default form controls, dense monospace log rows, and no visual indication of state beyond colored status text.

This step is intentionally a pure CSS/HTML/DOM-structure pass. It lands after the Markdown-rendering step (26) so the document-style result/summary rendering is in place to design around, and after the seed-Guild buildout (25) so the design is informed by real runs rather than fixtures.

## Deliverables

1. `source/web/static/styles.css` (rewrite/extend) — a cohesive visual system:
   - A defined color palette (status colors, neutrals, accents) and consistent spacing scale, used uniformly across panels.
   - Clear visual hierarchy: panel headers, the active run as the focal point, secondary panels (role activity, log) visually subordinate.
   - Responsive layout: the run list and the run view stack on narrow viewports; the page never produces a horizontal scrollbar (the step-17 wrapping fixes established this; the polish step confirms and extends it).
   - Calm empty and loading states (no jarring flashes during the per-run poll).
   - Consistent form controls (the create-run input, the question answer form, any interrupt input from steps 30/31).
2. `source/web/static/index.html` (extend) — semantic structure where the design needs it (e.g. grouping the run-summary header and the current-activity line, a clear active-run affordance). No new panels; this is reorganization for the design.
3. `source/web/static/app.js` (minimal touches) — add/remove class hooks the CSS needs (e.g. a `is-active` class on the active run's list item, state classes on the create-run form). No logic changes; the security invariant (`textContent`/sanitized-Markdown only) from steps 14 and 26 is preserved.
4. `docs/security.md` (touch) — confirm the polish pass introduced no new untrusted-content insertion paths; every new class hook is applied to trusted (non-agent) structure only.

## Module boundaries

- CSS and HTML structure only, plus class-hook touches in `app.js`. No `render.ts`, no server, no executor changes.
- No new endpoints, no new data fields.
- The security invariant is untouched: agent-authored text still flows only through the step-26 sanitized Markdown path or `textContent`; this step adds no `innerHTML` on untrusted content.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The UI presents a clear visual hierarchy with the active run as the focal point.
- [ ] The layout is responsive: usable on a narrow viewport with no horizontal scrollbar.
- [ ] Status, role activity, log, and questions are visually distinct and consistently spaced.
- [ ] No untrusted content reaches the DOM as markup beyond the step-26 sanitized Markdown path.

## End-of-step evaluation

Re-read every CSS rule and class hook added in `app.js`; confirm none inject agent text as HTML. Confirm the layout does not regress the step-17 log-row wrapping or the step-26 Markdown rendering. Confirm the design works against a real multi-role run (not just fixtures) — re-run the operator's representative task from step 25 and judge the UI against its output.

## Estimated effort

Small to medium — pure design work, no logic; the value is in iteration against real runs.

## Operator handoff

Review the redesigned UI in a browser against a real multi-role run. Confirm the visual hierarchy, spacing, and responsive behavior read well, and report any panel that still feels dense or confusing. The agent iterates the CSS in-environment until the operator signs off.
