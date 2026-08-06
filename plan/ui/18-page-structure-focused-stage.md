# UI step 18 — Page structure: focused stage, full-screen history, hero composer

## Goal

Restructure the product page so the run view (Flow default, Sequence behind the toggle) fills the screen while a run is being watched, and everything else moves behind deliberate navigation. The page becomes a single-screen console (no page scroll): a slim top bar, and one of three full-height screens — **Watch** (the flow/sequence stage), **History** (a full-screen run browser), **Compose** (the new-task hero, also the zero-state welcome). The `RunSummaryPanel` is retired; its unique content is re-homed, not lost.

## Context

The step-16 layout is a development-iteration arrangement: a permanent 24rem run-list sidebar rendering every task's full Markdown, a permanently-visible (and usually disabled) new-run panel, and a `Run` summary panel below the centerpiece. The result is a crowded page where the primary content gets a small fraction of the viewport. The one-task-at-a-time contract means the UI is naturally bimodal — the user is either watching a run or idle/browsing — so the layout should flip with that mode instead of rendering everything always.

Operator decisions (2026-08-02 brainstorm): history is a **full-screen view** (not a drawer or collapsible sidebar); the composer is the **hero in the stage when idle** (hidden while a run is active, since submission is impossible then); the interrupt form + history move to a **stage-scoped modal** behind an "Interrupt" button; the retired summary panel's technical data is **integrated into the primary surfaces** (top bar, result modal, history rows) rather than kept behind a separate "Details" affordance.

`RunSummaryPanel` inventory and where each piece goes:

- Result summary / error / artifacts — already in the result modal (kept; the modal gains the technical meta line below).
- Status — the top-bar status pill (existing `StatusLine` behavior, restyled).
- Elapsed / tokens — the stage's cost strip (kept).
- Task / run id / effort — the top bar's viewed-run label (task first line, run id + relative start as microcopy) and the History rows.
- Exact start/end times, tool-call count — a small meta block added to the result modal (derived from the already-fetched run view) and to the History row's expanded details.
- Interrupt form + history — the new stage-scoped interrupt modal (form and history together, so answers appear where you ask).
- `currentActivity` ("now: …") — dropped; the flow view's now-caption conveys it in friendlier language.

The `Flash` effect animates `#questions-panel`, which step 16 removed — it is dead code and goes with this step.

## Deliverables

1. **`source/web/static/app.js`** — restructure:
   - `Header` → a slim top bar: wordmark, live status pill (preserving the server-unavailable and "run in progress — click to view" behaviors), the viewed run's label (task first line, run id + relative start microcopy, effort chip), and nav: "New task" (disabled while a run is active), "History", the mute control.
   - `Main` → a screen switch on a new `screen: 'watch' | 'history' | 'compose'` state field. Initial `watch`; a zero-state (no runs, nothing selected) renders the compose hero as the welcome. Selecting a run or submitting one switches to `watch`.
   - Watch screen: controls row (Flow/Sequence toggle, label-tier select, cost strip, and an "Interrupt" button visible only when viewing the active run), the flex-filling stage (SVG + existing question/result/tooltip overlays), the now-caption. The `h2` "Run view" and `.panel` chrome go away; the stage canvas carries the sunken background.
   - History screen: full-screen scrollable list. Rows are compact: status chip, the task's first line (one line, ellipsized), effort badge, relative start time, re-run button, and an expand toggle. The expanded area renders the full task as sanitized Markdown, the result summary / error (terminal runs) as sanitized Markdown, and a technical meta line (run id, exact started/ended, effort). This is the browsing surface designed for large prompts and results.
   - Compose screen: the centered hero editor (large textarea, effort slider, start button), reusing the existing submit path and busy/disabled contract unchanged.
   - Interrupt modal: stage-scoped overlay (the question/result modal pattern) pairing `InterruptHistory` with `InterruptForm`, moved out of the deleted `RunSummaryPanel`. Opens from the controls-row button; closes on backdrop and a close button. The modal is reachable only when viewing the active run (the server 409 contract is unchanged).
   - Delete `RunSummaryPanel`, `BudgetsLine`, the dead `Flash`/`runFlash`, and the state/effects only they used.
2. **`source/web/static/styles.css`** — single-screen layout: `body`/`#app` a full-viewport flex column; the top bar a slim band; each screen `flex: 1; min-height: 0`; the Watch stage flex-fills (the flow SVG already scales via `viewBox`/`preserveAspectRatio`; the sequence view keeps its internal scroll). Remove every rule orphaned by the retire (the wide-viewport grid/sticky sidebar, `#run-summary`/`#run-meta`/`dl` summary styles, `.current-activity`, `.budgets*`, `.run-error`/`.error-text`, `.run-artifacts`/`.artifact`, `.panel` if unused, `#flow-panel` chrome). Restyle the interrupt form/history inside the modal card. Keep every `.pb-*` rule the demo harness shares intact. Narrow viewports stack the same screens (no regression; mobile remains out of scope).
3. **`source/web/render.ts`** — `RunSummary` gains `result` and `error` passthroughs (the History expanded area browses results without a per-run fetch; both fields already ride `meta.json`). Update `render.test.ts` expectations.
4. **`source/web/static/result-modal.js`** — the descriptor gains an optional technical meta line (run id, effort, exact started → ended, tool-call count) derived in `deriveTerminalResult` from the run view it already receives; rendered as a small muted block. Optional on the descriptor so the demo harness (which passes none) is unaffected.
5. **`docs/security.md`** — update the untrusted-content surface set: the run-summary panel is gone; the History expanded rows render task/result/error Markdown and the interrupt modal renders answer Markdown through the same sanitized pipeline; the top-bar run label and history first-line are `textContent`.
6. **`plan/ui/PLAN.md`** — design-revision entry + status.

## Module boundaries

- Web client (`app.js`, `styles.css`, `result-modal.js`) plus an additive, passthrough-only `RunSummary` extension in `render.ts`. No executor changes, no endpoint changes, no new state fetches (History browses the run list the 1s poll already fetches; the result-modal meta derives from the run view the per-run poll already fetches).
- The demo harness (`demo.html`/`demo.js`) is untouched; shared components change only additively.

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass.
- [x] The Watch stage fills the viewport: top bar + controls + stage + caption, no page scroll, no persistent sidebar or submit panel.
- [x] History is a full-screen view with compact one-line rows and per-row expanded details (full task, result/error, technical meta).
- [x] The composer is the zero-state hero and is unreachable (button disabled) while a run is active.
- [x] Interrupt form + history live in the stage-scoped modal; the retired `RunSummaryPanel`, `BudgetsLine`, and dead `Flash` code are gone with no orphaned styles.
- [x] The result modal carries the technical meta line.
- [x] `docs/security.md` surface set updated.

## Operator handoff

Browser review of the restructured page in both themes: zero-state composer hero on a fresh service; submit a task and watch the stage fill the screen; History browsing with a long-prompt run (compact rows, expand for full task/result); interrupt modal on the active run; result modal meta line on completion; narrow-viewport stacking. Sign-off closes the step.

## Closeout (2026-08-02)

In-environment complete: `bun run typecheck` and `bun test source/` green (812 tests). The page is now a single-screen console: `.app-shell` is a full-viewport flex column with the slim top bar (wordmark, status pill(s) preserving the server-unavailable and jump-to-live behaviors, the viewed run's first-line/run-id/effort identity, New task / History / mute nav) and one screen below it — Watch (controls row + flex-filling stage + now-caption), History (full-screen browser: one-line rows with status/primary/effort/when/re-run/details, per-row expanded details with exact meta + full task + result/error Markdown), Compose (centered hero, also the zero-state welcome via a `Main` fallthrough). `RunSummaryPanel`, `BudgetsLine`, and the dead `Flash`/`runFlash` are deleted; the interrupt form + history moved into the stage-scoped `InterruptModalForRun` behind a controls-row "Interrupt" button (rendered only when viewing the active run). Deviations from the step wording: (1) the result-modal meta line is a preformatted `{ text, title }` prop built in `app.js` (`resultMetaLine`) rather than a `deriveTerminalResult` descriptor field — the formatting helpers live client-side and the demo harness passes none; (2) the product sequence view now mounts inside the `.pb-sequence-scroll` container (previously only the demo wrapped it — the page scroll absorbed the overflow; the no-page-scroll layout requires the internal scroll); (3) `styles.css` dropped the now-unused `--shadow-panel`/`--shadow-focal` tokens along with every orphaned rule. The `RunSummary` result/error passthrough landed with render + server test updates; `docs/security.md` records the new surface set. Verified end-to-end against a real run on the local endpoint (submit → watch → completion). Operator visual sign-off in both themes is the remaining gate.
