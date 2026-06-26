# UI step 02 — Visual foundation: light/dark tokens + SVG primitives

## Goal

Establish the maintainable visual foundation the whole flow-graph UI builds on: (1) a design-token system that follows the browser's light/dark theme via `prefers-color-scheme`, and (2) a set of reusable, self-contained SVG primitives (node, edge, tooltip shell) laid out against their own local `0,0` origin so the graph can be assembled, moved, and iterated without re-lining-up internals each time. Rendered against the step-01 fixtures; no real graph yet.

## Context

Read [`PLAN.md`](PLAN.md) ("Hand-rolled SVG", "SVG structure for maintainability", "Light/dark theme"), [`01-fixture-data-set-and-playback-harness.md`](01-fixture-data-set-and-playback-harness.md) (the fixtures + playback harness the demo renders against), `source/web/static/styles.css` (the step-28 token system this extends — light-only and hardcoded today), and `source/web/static/app.js` (how hyperapp renders vnodes; SVG elements render as vnodes with the same `h(tag, props, children)` shape). UI work iterates heavily, so this step invests in modularity now: a node component owns its box/label/counter/cost layout internally; the graph layout (step 03) only assigns an `(x, y)` translate. Edges are a separate layer reading node anchor points. No hardcoded padding/margins inside the SVG — borders and padding live on the container.

## Deliverables

1. **`source/web/static/styles.css`** — extend the `:root` token block to a light/dark pair driven by `@media (prefers-color-scheme: dark)` (and an optional explicit `data-theme` attribute for forced testing). Every color token from step 28 gets a dark counterpart; both palettes are calibrated to look good (not just inverted). The existing panels continue to render correctly in both themes. Add tokens the SVG primitives need (node fill/border, edge color, flow-accent, active-pulse, error-red, success-green) in both themes.
2. **`source/web/static/svg-primitives.js`** (new module) — pure functions returning hyperapp vnode trees, each self-contained against local `0,0`:
   - `GraphNode({ label, sublabel, counter, costTime, costTokens, status, active })` → a `<g>` containing its box, label text, optional counter badge, optional cost line, and active/error/success visual states. Internal layout only; no absolute position.
   - `GraphEdge({ fromAnchor, toAnchor, state })` where `state` is `'static' | 'flowing' | 'returning' | 'error'` → a `<path>` with class hooks the CSS animates (`stroke-dasharray` flow for `flowing`/`returning`; solid red for `error`).
   - `TooltipShell({ title, children, onCopyRaw, copyAvailable })` → a positioned container shell (positioning decided by the caller) with a title, a body slot, and an optional "copy raw" button. Friendly formatting of the body is step 08; this step delivers only the shell + the copy button wiring.
3. **`source/web/static/svg-primitives.test.ts`** (new, in-memory) — assert each primitive returns the expected vnode shape (tag, classes, text content) for its states, with no DOM. Pure-shape tests, mirroring the `markdown.test.ts` fake-`h` pattern. Cover: node with/without counter/cost, each status; edge in each state; tooltip shell with/without copy button.
4. **`source/web/static/app.js`** — render a demo inside the step-01 playback harness showing the primitives composed at fixed coordinates using a fixture's friendly labels, so the operator can review the visual foundation in both light and dark. The demo is removed in step 14; for now it is the iteration surface.

## Module boundaries

- Web-only, fixture-driven. No backend, no `render.ts` data-derivation, no new endpoints.
- The demo is throwaway iteration scaffolding, isolated for clean removal.
- No new dependencies. SVG is hyperapp vnodes; the security invariant holds — the primitives take already-safe strings as props (machine fields as `<text>` textContent; no agent prose rendered by the primitives themselves).

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] The UI renders correctly in both light and dark (operator confirms both via the harness).
- [ ] Each SVG primitive is a self-contained pure function laid out against local `0,0`; moving a composed node changes only its translate, never its internals.
- [ ] No hardcoded padding/margins inside the SVG; borders/padding are on the container.
- [ ] `svg-primitives.test.ts` covers each primitive's states with no DOM.

## Operator handoff

Review the demo in the playback harness in **both light and dark** (toggle the OS/browser theme). Confirm the tokens read well in both and the primitives look like a sound foundation to build the graph on. Report palette/spacing adjustments; the agent iterates the CSS tokens until sign-off.
