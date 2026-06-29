# UI step 05 — Product surfaces: "now" caption + cost strip

## Goal

Wrap the two-component flow view in the product-critical surfaces a non-developer needs: a one-line plain-language "now" caption derived from the active role/tool, and a quiet ambient cost strip in the page border (elapsed · tokens · effort). These give meaning the main area's structure alone cannot convey. Iterated against fixtures.

The step's original scope included a third surface — a progress/budget bar — but implementation revealed the run carries no real budget to fill it against (the time/token caps were removed when the executor moved to deployment-environment termination). Any percent-done would be fabricated, so the budget bar was dropped and its plan deliverables removed; the closeout records the reasoning. Elapsed time stays present via the cost strip.

## Context

Read [`PLAN.md`](PLAN.md) ("Now caption", "Costs"), [`03-flow-graph-static-layout.md`](03-flow-graph-static-layout.md) (the two-component flow view the surfaces wrap), and `source/web/render.ts` (`deriveBudgets` — elapsed seconds, tool calls, token breakdown; `currentActivity` — the existing one-line role+summary the "now" caption generalizes). The run view already carries `budgets`, `currentActivity`, and `effort`; this step reshapes them into product surfaces rather than debug rows.

## Deliverables

1. **`source/web/static/flow-view.js`** — add `deriveNowCaption(config, runView, model)`: a pure function returning a single plain-language sentence built from the active role's **friendly description** (from config) and the active tool (if any), e.g. "Baking cookies…" or "Reviewing the coder's work…". Falls back to `detailed` then title-cased role name. For a completed run, a completion caption. One line. Co-located with the flow-graph derivation since it consumes the same config + run-view shapes.
2. **`source/web/flow-graph.test.ts`** — cover `deriveNowCaption`: active worker role → friendly description; active tool call → role + tool friendly label; completed run → completion caption; missing friendly tier → fallback chain. Use fixtures.
3. **`source/web/static/app.js`** — render the two surfaces around the two-component flow view in the playback harness:
   - **"Now" caption** — one line directly under the main area, from `deriveNowCaption`.
   - **Cost strip** — a quiet always-present strip in the page border (header or a slim top bar) showing elapsed · tokens · effort for the active/selected run. Ambient, not focal.
4. **`source/web/static/styles.css`** — style the two surfaces with the visual tokens, theme-aware. The "now" caption is the more prominent of the two; the cost strip is the more subdued.

## Module boundaries

- Web-only, fixture-driven. `flow-view.js` gains one pure helper (`deriveNowCaption`); `app.js`/`styles.css` add the surfaces. No backend or endpoint changes.
- The "now" caption is a product-meaning surface (per `PLAN.md`), retained deliberately; not framed as accessibility.

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass.
- [x] The "now" caption is a single plain-language line derived from the active role/tool's friendly description, with a sensible fallback chain.
- [x] The cost strip is ambient and always present, theme-aware.
- [x] Both surfaces render correctly in light and dark across the fixtures.

## Operator handoff

Review the wrapped view in the playback harness in both themes across the fixtures. Confirm the "now" caption conveys meaning a non-developer understands, the budget bar doesn't mislead, and the cost strip stays out of the way. Report wording/styling adjustments.

## Closeout (2026-06-29)

In-environment complete: `bun run typecheck` and `bun test source/` green (600 tests, +9 from `deriveNowCaption` coverage in `flow-view.test.ts`). The two-component flow view is now wrapped in two product surfaces a non-developer needs: a one-line plain-language "now" caption derived from the active role/tool's friendly description (directly under the main area, the more prominent of the two), and a quiet always-present cost strip in the page border (elapsed · tokens · effort, the more subdued). Both read the visual tokens and follow the light/dark theme.

`flow-view.js` exports one pure helper co-located with the flow-graph derivation because it consumes the same config + run-view + model shapes: `deriveNowCaption(config, runView, model)` returns the one-line caption (terminal run → completion caption; pending ask_human → the tool's friendly description; in-flight tool call → calling role friendly label · tool friendly label; active role → its friendly description; lingering return to the root You → "Wrapping up…"; fallback chain friendly → detailed → title-cased name).

Deviations from the plan wording, recorded so the next step inherits reality:

- **The budget bar surface was dropped.** The step's original scope included a progress/budget bar "honest about uncertainty: when no clear budget exists, show elapsed without a false percent-done." Implementation revealed the run carries no real budget to fill it against: the time/token caps were removed when the executor moved to deployment-environment termination (the main plan's step 26), and the only remaining budget-shaped field is the effort level — a quality setting with no defensible mapping to a duration. Fabricating an "expected duration" heuristic from effort (an early draft used `[30s, 2m, 5m, 15m, 45m, 2h]`) was unsupportable, and an empty track reads as "0% done", which the plan forbids. So the bar, the `deriveBudgetBar` helper, and its tests were removed; elapsed time stays present via the cost strip. The plan's Goal, Deliverables, and Acceptance criteria above are updated to reflect the two-surface scope. If a real budget lands later (per-run time/token limits), the surface can be re-introduced against an honest fill.
- **The surfaces live in `playback.js`, not `app.js`.** The plan's deliverable 3 names `app.js`, but `app.js` is the product client that renders the legacy panels and does not yet host the flow view (the flow view is wired only into the dev playback harness during phase A; live hookup is step 13). The phase-A methodology (`plan/ui/PLAN.md` "Methodology") is explicit that the playback harness is the iteration surface for steps 01–11, so the surfaces go where the flow view is. This is the same call step 04 made.
- **`deriveNowCaption` takes `(config, runView, model)`, not `(config, runView, animationState)`.** The plan's signature passes the animation state, but `deriveFlowAnimation`'s return (`{ edgeStates, activeIds }`) carries only node ids — it cannot resolve which active id is a role vs a tool vs the "You" respondent, which the caption needs. Passing both the animation state and the model would be redundant (the animation state is a cheap pure derivation of the model), so the caption takes the model and derives the animation internally. The caption still consumes the run view for terminal status (a completed run gets a completion caption regardless of a lingering return edge) and the config for the friendly tiers.
- **The `EFFORT_LABELS` list is duplicated in `playback.js`.** `app.js` owns the canonical labels but pulls in runtime dependencies (the vendored Markdown pipeline) the static playback harness does not serve, so importing `app.js` from `playback.js` is not possible. The harness is throwaway iteration scaffolding (removed in step 14), so a small local copy keeps it self-contained; the duplication retires with the harness.

Operator action required: open `http://<host>:<port>/playback.html` in a browser and scrub the fixtures in both themes. Confirm the "now" caption conveys meaning a non-developer understands (a thinking role reads its friendly description; an in-flight tool call names the role and the tool; a pending question reads "Needs your input before continuing…"; a completed run reads "Done."), and the cost strip stays out of the way. Report wording/styling adjustments; the caption wording and the surface font sizes/colors are the tuning surface.
