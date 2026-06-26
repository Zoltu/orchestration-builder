# UI step 05 — Product surfaces: "now" caption + budget bar + cost strip

## Goal

Wrap the flow graph in the product-critical surfaces a non-developer needs: a one-line plain-language "now" caption derived from the active role/tool, a progress/budget bar, and a quiet ambient cost strip in the page border (elapsed · tokens · effort). These give meaning and "how far along" the graph's structure alone cannot convey. Iterated against fixtures.

## Context

Read [`PLAN.md`](PLAN.md) ("Now caption", "Costs"), [`03-flow-graph-static-layout.md`](03-flow-graph-static-layout.md) (the graph the surfaces wrap), and `source/web/render.ts` (`deriveBudgets` — elapsed seconds, tool calls, token breakdown; `currentActivity` — the existing one-line role+summary the "now" caption generalizes). The run view already carries `budgets`, `currentActivity`, and `effort`; this step reshapes them into product surfaces rather than debug rows.

## Deliverables

1. **`source/web/render.ts`** — add `deriveNowCaption(config, runView, animationState)`: a pure function returning a single plain-language sentence built from the active role's **friendly description** (from config) and the active tool (if any), e.g. "Baking cookies…" or "Reviewing the coder's work…". Falls back to `detailed` then title-cased role name. For a completed run, a completion caption. One line.
2. **`source/web/render.test.ts`** — cover `deriveNowCaption`: active worker role → friendly description; active tool call → role + tool friendly label; completed run → completion caption; missing friendly tier → fallback chain. Use fixtures.
3. **`source/web/static/app.js`** — render the three surfaces around the graph in the playback harness:
   - **"Now" caption** — one line directly under the graph, from `deriveNowCaption`.
   - **Progress/budget bar** — a thin bar above the graph showing elapsed time against the run's budget context (effort level → expected scale). Honest about uncertainty: when no clear budget exists, show elapsed without a false "percent done."
   - **Cost strip** — a quiet always-present strip in the page border (header or a slim top bar) showing elapsed · tokens · effort for the active/selected run. Ambient, not focal.
4. **`source/web/static/styles.css`** — style the three surfaces with the step-02 tokens, theme-aware. The "now" caption is the most prominent of the three; the cost strip is the most subdued.

## Module boundaries

- Web-only, fixture-driven. `render.ts` gains one pure helper (`deriveNowCaption`) and reuses `deriveBudgets`; `app.js`/`styles.css` add the surfaces. No backend or endpoint changes.
- The "now" caption is a product-meaning surface (per `PLAN.md`), retained deliberately; not framed as accessibility.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The "now" caption is a single plain-language line derived from the active role/tool's friendly description, with a sensible fallback chain.
- [ ] The progress/budget bar is honest (no false percent-done when no real budget exists).
- [ ] The cost strip is ambient and always present, theme-aware.
- [ ] All three surfaces render correctly in light and dark across the fixtures.

## Operator handoff

Review the wrapped view in the playback harness in both themes across the fixtures. Confirm the "now" caption conveys meaning a non-developer understands, the budget bar doesn't mislead, and the cost strip stays out of the way. Report wording/styling adjustments.
