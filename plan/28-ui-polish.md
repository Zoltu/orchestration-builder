# Step 28 — UI polish

## Goal

Pretify the web UI into a legible, calm interface a non-developer can live with — visual hierarchy, spacing, color, typography, and responsive layout — without changing the data model or endpoints. This is the design pass over the functional UI delivered by steps 14–21 and 27, after the seed Guild (step 25) is real-world-exercised and the Markdown rendering (step 27) is in.

## Context

Read the closeout of [`25-seed-guild-buildout.md`](25-seed-guild-buildout.md) (real-world UI pain points the operator surfaced), [`14-multi-run-ui.md`](14-multi-run-ui.md) and [`17-per-run-view-readability.md`](17-per-run-view-readability.md) (the current UI surface and its security invariant), `source/web/static/index.html`, `source/web/static/styles.css`, and `source/web/static/app.js`. The UI today is functional but utilitarian: a flat list of panels, default form controls, dense monospace log rows, and no visual indication of state beyond colored status text.

This step is intentionally a pure CSS/HTML/DOM-structure pass. It lands after the Markdown-rendering step (27) so the document-style result/summary rendering is in place to design around, and after the seed-Guild buildout (25) so the design is informed by real runs rather than fixtures.

## Deliverables

1. `source/web/static/styles.css` (rewrite/extend) — a cohesive visual system:
   - A defined color palette (status colors, neutrals, accents) and consistent spacing scale, used uniformly across panels.
   - Clear visual hierarchy: panel headers, the active run as the focal point, secondary panels (role activity, log) visually subordinate.
   - Responsive layout: the run list and the run view stack on narrow viewports; the page never produces a horizontal scrollbar (the step-17 wrapping fixes established this; the polish step confirms and extends it).
   - Calm empty and loading states (no jarring flashes during the per-run poll).
   - Consistent form controls (the create-run input, the question answer form, any interrupt input from step 31).
2. `source/web/static/index.html` (extend) — semantic structure where the design needs it (e.g. grouping the run-summary header and the current-activity line, a clear active-run affordance). No new panels; this is reorganization for the design.
3. `source/web/static/app.js` (minimal touches) — add/remove class hooks the CSS needs (e.g. a `is-active` class on the active run's list item, state classes on the create-run form). No logic changes; the security invariant (`textContent`/sanitized-Markdown only) from steps 14 and 27 is preserved.
4. `docs/security.md` (touch) — confirm the polish pass introduced no new untrusted-content insertion paths; every new class hook is applied to trusted (non-agent) structure only.

## Module boundaries

- CSS and HTML structure only, plus class-hook touches in `app.js`. No `render.ts`, no server, no executor changes.
- No new endpoints, no new data fields.
- The security invariant is untouched: agent-authored text still flows only through the step-27 sanitized Markdown path or `textContent`; this step adds no `innerHTML` on untrusted content.

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass.
- [x] The UI presents a clear visual hierarchy with the active run as the focal point.
- [x] The layout is responsive: usable on a narrow viewport with no horizontal scrollbar.
- [x] Status, role activity, log, and questions are visually distinct and consistently spaced.
- [x] No untrusted content reaches the DOM as markup beyond the step-27 sanitized Markdown path.

## End-of-step evaluation

Re-read every CSS rule and class hook added in `app.js`; confirm none inject agent text as HTML. Confirm the layout does not regress the step-17 log-row wrapping or the step-27 Markdown rendering. Confirm the design works against a real multi-role run (not just fixtures) — re-run the operator's representative task from step 25 and judge the UI against its output.

## Estimated effort

Small to medium — pure design work, no logic; the value is in iteration against real runs.

## Operator handoff

Review the redesigned UI in a browser against a real multi-role run. Confirm the visual hierarchy, spacing, and responsive behavior read well, and report any panel that still feels dense or confusing. The agent iterates the CSS in-environment until the operator signs off.

## Future improvements (deferred)

Hints recorded for a potential follow-up; not in scope for this step.

- **Auto-collapsing role tree.** In a large multi-role run the fully-expanded Role tree consumes significant vertical space. A future pass could collapse the tree up to the level of the currently-running invocation by default, expanding only the path to a node when it spawns a child — keeping the active agent visible while the rest stays compact. The user could click a row to expand/collapse manually, with the manual override winning by default. A completed run (no active invocation) would render mostly collapsed. This needs collapse state held in `app.js` state (reset on run switch, mirroring `expandedLogRows`) and an active-path set computed each render; no executor/log changes required since `deriveRoleTree` already emits `active` per invocation.
- **Expandable leaf detail with per-invocation stats.** Collapsed leaf nodes could show only success/failure; expanding one would reveal token usage, context size, and the final response for that invocation. This requires `deriveRoleTree` to attribute `llm_call`/`tool_call` events to the stack-top invocation (the running role) during its existing pass, since the executor is strictly sequential and depth-first. New `RoleTreeNode` fields: `llmCalls`, `toolCalls`, `promptTokens`, `completionTokens`, `lastPromptTokens` (context size), and `lastAssistantContent` (final response). The expanded-detail rendering would reuse the `LogDetailSection` paired-section pattern so the raw-toggle security invariant (text nodes only) is preserved.

## Closeout (2026-06-26)

Complete in-environment. `bun run typecheck` and `bun test source/` both pass (497 tests across 30 files). The change is CSS + two class-hook touches in `app.js` + a `docs/security.md` confirmation; no `render.ts`, server, executor, or endpoint changes, and no new data fields.

Deliverables delivered:

- `source/web/static/styles.css` — rewritten as a cohesive visual system. Design tokens (color palette: status colors, neutrals, accent; a six-step spacing scale; radii; shadows; mono/body font stacks) are declared once on `:root` and referenced uniformly so the panels read as one interface. Visual hierarchy: the active run's summary panel carries a subtle accent ring (`--shadow-focal`) as the focal point; secondary panels (role activity, log, config) get muted headers and flat shadows. Responsive layout: `main` is a single stacked column below `64rem` (the run list, then the run view panels in source order) and a two-column grid above it — the run list becomes a sticky `22rem` sidebar (with an internally scrollable list) and the run-summary / roles / questions / config / log panels flow into a focal column via `grid-template-areas`. Every column is `minmax(0, …)` and every text surface wraps (`overflow-wrap: anywhere`; log rows and Markdown code keep the step-17 `pre-wrap`/`word-break` wrapping), so the page never produces a horizontal scrollbar. Form controls (create-run input/button, question form, effort slider, re-run/log/export buttons) share the token palette and consistent radii/padding plus a `:focus-visible` accent ring. Calm empty/loading states are preserved via the existing `:empty` hides and muted italic placeholders. The step-27 `.markdown` document styles are preserved (hardcoded colors swapped for equal-valued tokens) so rendered agent Markdown is not regressed.
- `source/web/static/index.html` — semantic/helpful additions only, no new panels: a `theme-color` meta (matches the header so the browser chrome reads as one surface), a `description` meta, and a `<noscript>` fallback message. The hyperapp-rendered structure is unchanged.
- `source/web/static/app.js` — two class-hook touches, no logic changes: the active (in-progress) run's list item gains `is-active` (computed from the existing `deriveActiveRunId`) and the create-run form gains `is-busy` while a run is active or a submission is in flight. Both hooks are applied to trusted client-built structure (the `<li>` and the `<form>`), never to agent-authored content; all prose fields still flow through the step-27 sanitized Markdown path and every other field stays a text node.
- `docs/security.md` — added a paragraph under "Web client rendering pipeline" confirming the polish pass introduced no new untrusted-content insertion paths and that every new class hook is applied to trusted (non-agent) structure only. Also removed a pre-existing double blank line before "## Mitigations" while in the file.

Deviations / decisions (authoritative):

- **Sidebar approach via `grid-template-areas` rather than a wrapper div.** The deliverable allowed index.html reorganization for the design, but the run-view panels are direct children of `main` rendered by hyperapp. Rather than add a wrapper `<div>` in `app.js` (a structural change beyond "minimal class hooks"), the wide-viewport sidebar is achieved purely in CSS by placing `#runs-panel` in a `runs` grid area that spans every row of column 1 and assigning each run-view panel its own area in column 2. This keeps `app.js` to class-hook-only touches and leaves the narrow-viewport stack as the default source-order flow. `app.js`'s `Main` render order is unchanged.
- **`is-active` vs `selected` are distinct.** `selected` (existing) marks the run the operator is viewing; `is-active` (new) marks the one in-progress run. The active run is the focal point of the list (a leading accent bar via an inset box-shadow) and the selected run keeps its tint; the two compose when the active run is also selected. The focal-point treatment of the run-summary panel is independent of `is-active` (it is always the focal column on wide viewports) so a completed selected run still reads as the focal point.
- **No new assets or server allowlist entries.** The pass is CSS + HTML meta/noscript + two class hooks; no new static files, so `source/web/server.ts`'s `STATIC_ASSETS` is unchanged.

End-of-step checks: every CSS rule and both `app.js` class hooks were re-read — none inject agent text as HTML (`is-active`/`is-busy` are on the list item and form; agent prose still flows only through `sanitizeNodes` → vnodes, all other fields stay text nodes). The step-17 log-row wrapping (`#log li` `pre-wrap`/`word-break`, `.log-row` `flex-wrap`, `.log-detail` `pre-wrap`/`word-break`) and the step-27 Markdown rendering (`.markdown` block preserved verbatim modulo equal-valued token colors; fenced `pre` keeps `overflow-x: auto` and `pre code` keeps `pre-wrap`/`word-break`) are not regressed. The existing server tests confirm `/`, `/app.js`, `/styles.css`, and the vendored assets still serve with the correct content types, and `index.html` still contains `Adaptive Orchestrator`. The design against a real multi-role run (visual hierarchy, spacing, responsive behavior) is operator work per the handoff below.

## Operator handoff

Review the redesigned UI in a browser against a real multi-role run. Confirm the visual hierarchy, spacing, and responsive behavior read well, and report any panel that still feels dense or confusing. The agent iterates the CSS in-environment until the operator signs off.

No new technical debt introduced.

### Iteration (2026-06-26) — operator-directed

The operator reported two problems with the first pass: (1) the run-list rows crammed run id, status, effort badge, task, and re-run button onto one line, which wrapped badly in the narrow sidebar; and (2) the task entry was a single-line input inside the sidebar, far too small for the long Markdown task text a user may write. Both were addressed:

- The create-run form and effort slider moved out of `#runs-panel` into a new `#submit-panel` at the top of the focal column (grid area `submit`), giving the editor horizontal room. The task input became a multiline `<textarea>` (`rows=4`, `min-height: 8rem`, `resize: vertical`); Enter inserts a newline (textarea default), Tab inserts a real tab character at the caret via a new `TaskTextareaKeydown` action (`event.preventDefault()` + caret-aware value splice), and Ctrl/Cmd+Enter submits through `form.requestSubmit()`. The effort slider sits in a `.submit-controls` row beside the submit button. `SubmitRun` now reads `form.querySelector('textarea')` instead of the single-line input.
- Each run-list `<li>` is now a vertical stack: a `.run-meta-row` (run id + status), the task on its own line as `.run-task.markdown` (rendered through the same `renderMarkdown` sanitized path the per-run Task field uses, wrapped with `overflow-wrap: anywhere`), and a `.run-actions-row` (effort badge + re-run button, re-run pushed right with `margin-left: auto`). The sidebar widened to `24rem`. This removes the step-27 "run-list task stays `textContent`" deviation — the task is now uniformly sanitized Markdown everywhere it appears (recorded in `docs/security.md`).

`bun run typecheck` and `bun test source/` still pass (497 tests). No executor/render/server/endpoint changes; the new behavior is `app.js` + CSS only. The `ask_human` answer input stays a single-line `<input>` (answers are short). Operator browser sign-off on the reformatted list and the multiline editor remains pending.
