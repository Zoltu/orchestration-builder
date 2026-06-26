# UI step 03 — Flow graph: static layout + data derivation

## Goal

Build the static flow graph: place every node (Human root, roles by tier, tools cluster) once from the config, and derive the graph's *state* (counters, statuses, costs, active path) from the run view. Render the full graph statically against the step-01 fixtures this step — no animation yet (step 04), no product surfaces (step 05). The layout is computed once and never moves for the life of a run.

## Context

Read [`PLAN.md`](PLAN.md) ("Static layout for the life of a run", "Repeated invocations are not new nodes"), [`02-visual-foundation-tokens-svg-primitives.md`](02-visual-foundation-tokens-svg-primitives.md) (the `GraphNode`/`GraphEdge` primitives and the light/dark tokens), [`01-fixture-data-set-and-playback-harness.md`](01-fixture-data-set-and-playback-harness.md) (the fixtures the graph derives from), `source/web/render.ts` (`deriveRoleTree` — the existing per-invocation tree with statuses and the single active node; the starting point for graph state), and `source/web/render.ts` (`deriveRoleActivity` and `deriveBudgets` — per-role counts and token/time sums the node counters/costs reuse). The fixtures match the real `/api/config` + `/api/runs/:id` shape, so the derivation consumes the same shape it will consume live in step 13.

## Deliverables

1. **`source/web/render.ts`** — add `deriveFlowGraph(config, runView)`, a pure function producing a `FlowGraph`:
   - `nodes`: one per role (from config) + one Human node (root) + one per tool (from config), each with its `friendly` label/description (fallback `detailed` → title-cased name), tier `('human' | 'entry' | 'worker' | 'side' | 'tool')`, and a fixed `(x, y)` from the layout function.
   - `edges`: the parent→child and agent→tool relationships observed in `runView.roleTree` plus tool calls, each tagged with its call count.
   - per-node `invocationCount`, `accumulatedTimeMs` and `accumulatedTokens` (summed across invocations), `status` of the latest/active invocation, and `active` (the single currently-running node, mirroring `deriveRoleTree`'s active flag).
   - The layout is a separate pure helper (`layoutFlowGraph(nodeTiers)`) assigning `(x, y)` by tier + index — Human at top center, entry role below, workers in a row, side roles (`context_manager`/`recovery`) to the side, tools in a cluster at the bottom. ~30 lines; no general graph-layout algorithm.
2. **`source/web/render.test.ts`** — add a `deriveFlowGraph` suite covering: node set seeded from config with friendly labels; counters accumulate across repeated invocations (use a fixture's two-coder-call retry); the single active node is marked; per-node time/token sums are correct; the Human node is present as root. Pure-shape tests, no DOM. Use the step-01 fixtures as inputs.
3. **`source/web/static/app.js`** — a `FlowGraph` view component that calls `deriveFlowGraph` and renders nodes/edges via the step-02 primitives at their assigned translates, wired into the playback harness so the operator can scrub through fixtures and see the static graph per frame. Static render only (no animation classes yet beyond what the primitives' `active`/`status` props already convey).
4. **`docs/security.md`** — extend the step-28 note: the graph renders role/tool names, counters, and costs as SVG `<text>` textContent; friendly labels come from config (trusted guild data, sanitized at load); no agent prose is rendered by the static graph.

## Module boundaries

- Web-only, fixture-driven. `render.ts` gains a new pure derivation (`deriveFlowGraph` + `layoutFlowGraph`); no existing derivation is changed. `app.js` gains a new view component rendered in the playback harness.
- No backend, no new endpoints. No new dependencies.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The graph's node set is seeded from config; the layout is computed once and is stable (same input → same positions).
- [ ] Repeated invocations of a role produce a counter on one node, not duplicate nodes (verified against the retry fixture).
- [ ] Per-node accumulated time/tokens and the single active node are correctly derived from the run view.
- [ ] The Human node is the root.
- [ ] No agent prose is rendered by the static graph; only `textContent`-safe machine fields and trusted labels.

## Operator handoff

Scrub through the fixtures in the playback harness. Confirm the layout reads well for every scenario: Human at top, roles by tier, tools clustered, counters/costs legible. Report layout/spacing adjustments; the agent iterates `layoutFlowGraph` and the primitives until sign-off.
