# UI step 02 — Visual foundation: light/dark tokens + SVG primitives

## Goal

Establish the maintainable visual foundation the whole flow-graph UI builds on: (1) a design-token system that follows the browser's light/dark theme via `prefers-color-scheme`, and (2) a set of reusable, self-contained SVG primitives (node, edge, tooltip shell) laid out against their own local `0,0` origin so the graph can be assembled, moved, and iterated without re-lining-up internals each time. Rendered against the step-01 fixtures; no real graph yet.

## Context

Read [`PLAN.md`](PLAN.md) ("Hand-rolled SVG", "SVG structure for maintainability", "Light/dark theme"), [`01-fixture-data-set-and-playback-harness.md`](01-fixture-data-set-and-playback-harness.md) (the fixtures + playback harness the demo renders against), `source/web/static/styles.css` (the step-28 token system this extends — light-only and hardcoded today), and `source/web/static/app.js` (how hyperapp renders vnodes; SVG elements render as vnodes with the same `h(tag, props, children)` shape). UI work iterates heavily, so this step invests in modularity now: a node component owns its box/label/counter/cost layout internally; the layout (step 03) only assigns each node an `(x, y)` translate. Edges are a separate layer routed by the pathfinding library (`source/web/static/pathfinding.js`). No hardcoded padding/margins inside the SVG — borders and padding live on the container.

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

- [x] `bun run typecheck` and `bun test source/` pass.
- [x] The UI renders correctly in both light and dark (operator confirms both via the harness).
- [x] Each SVG primitive is a self-contained pure function laid out against local `0,0`; moving a composed node changes only its translate, never its internals.
- [x] No hardcoded padding/margins inside the SVG; borders/padding are on the container.
- [x] `svg-primitives.test.ts` covers each primitive's states with no DOM.

## Operator handoff

Review the demo in the playback harness in **both light and dark** (toggle the OS/browser theme). Confirm the tokens read well in both and the primitives look like a sound foundation to build the graph on. Report palette/spacing adjustments; the agent iterates the CSS tokens until sign-off.

## Closeout (2026-06-26)

In-environment complete: `bun run typecheck` and `bun test source/` green (525 tests, +20 from the new `svg-primitives.test.ts`). The token system is a light/dark pair driven by `@media (prefers-color-scheme: dark)` with an explicit `:root[data-theme='dark'|'light']` override for forced review; light values are declared once on `:root`, dark values are declared in both the media block and the forced-dark block, and the forced blocks win via attribute-selector specificity so the operator pin is authoritative regardless of the OS setting. Every step-28 color token gained a calibrated (not inverted) dark counterpart; the inline-code hardcoded `#24292e` became a `--color-code-text` token so existing panels read correctly in both themes. New `--svg-*` tokens (node fill/border/label, edge, flow-accent, active-pulse, error, success, counter, tooltip) are derived from the surface/accent/signal tokens so the two palettes stay calibrated together.

`svg-primitives.js` exports `GraphNode`, `GraphEdge`, `TooltipShell`, `nodeAnchor`, and the `NODE_WIDTH`/`NODE_HEIGHT`/`TOOLTIP_*` constants. Each primitive is a pure function taking `h` as its first argument (mirroring `markdown.js`'s `htmlNodesToVnodes(nodes, h)`), so the module stays browser-pure, free of hyperapp coupling, and exercisable in tests with a fake `h`. Nodes lay out against local `0,0` (box, label, optional sublabel, optional counter badge, optional cost line, active/success/error class hooks); the demo composes them by wrapping each in a translating `<g>`, so moving a node is a one-number translate change. Edges are a separate `<path>` layer reading `nodeAnchor` points, with `static`/`flowing`/`returning`/`error` class hooks the CSS animates (marching-ants `stroke-dasharray` for flow, solid red for error). The tooltip shell carries a background rect, title, body slot (caller-supplied children), and a `copyAvailable`-gated copy-raw button wired to `onCopyRaw`; friendly body formatting is deferred to step 08. The security invariant holds: the primitives take already-safe strings as `<text>` textContent and render no agent prose themselves.

Deviations from the plan wording, recorded so the next step inherits reality:

- **The primitives take `h` as a first argument rather than importing it.** The plan's signatures read `GraphNode({ ... })`, but the test deliverable calls for "mirroring the markdown.test.ts fake-`h` pattern," and `markdown.js` establishes the convention of passing `h` in so the module is free of hyperapp coupling and testable without a DOM. Real callers (the playback demo) pass the imported `h`; tests pass a fake. This keeps `svg-primitives.js` browser-pure and import-free, matching `markdown.js`.
- **A `/svg-primitives.js` static-asset route was added to `server.ts`** (plus one `server.test.ts` case), mirroring the step-01 precedent for `fixtures.js`/`playback.*`. The module lives under `static/` but the server serves a curated allowlist rather than the whole directory, so the browser import would 404 without the additive route. No new endpoints, no logic.
- **The playback harness gained a Light/Dark/Auto theme toggle and base `.pb-*` styles.** Step 01 shipped the harness with raw-frame controls but no `.pb-*` stylesheet, so the controls rendered unstyled; step 02 adds the harness base styles (controls, frame dump, demo container) alongside the primitive styles so the visual foundation is reviewable. The toggle sets `data-theme` on the root element (the forced-theme path the token system supports), and `applyTheme('auto')` runs on load.

Operator action required: open `http://<host>:<port>/playback.html` in a browser and review the "Visual foundation — SVG primitives" demo in both Light and Dark (use the toggle, or the OS theme). Confirm the tokens read well in both palettes and the primitives look like a sound foundation to build the flow graph on; report palette/spacing adjustments for iteration.

## Operator sign-off (2026-06-26)

Operator confirmed in browser (both light and dark): tokens legible in both themes, primitive states (node active/success/error, edge flowing/returning/static/error) distinct, fit-to-page behavior correct, no right overflow, no edge clipping, no scroll. Palette deferred to final-theme review — acceptable for now, colors are CSS variables (`--svg-*` / `--color-*` tokens) so a later restyle touches one place, not graph code.

Constraints recorded for step 03:
- **Edge routing is via the pathfinding library, not straight anchors.** Step 03 routes edges orthogonally through `source/web/static/pathfinding.js` (`routeEdges`): out on the right face, in on the left face, two-elbow paths that avoid node interiors and never intersect. The `nodeAnchor` function from this step is retained for cases the pathfinding library doesn't cover (e.g. the step-02 demo), but the flow view's edges are `routeEdges` output rendered as SVG `<path>` elements, not straight `nodeAnchor` lines.
- **Inset is container padding, not SVG coordinates.** Nodes root at viewBox edges (`0,0`); the container's `padding` + `box-sizing: border-box` keeps them off the screen, and `overflow: visible` on the SVG paints edge-centered strokes that would otherwise clip at `overflow: hidden` (a node at `x:0` draws half its 1px stroke at coordinate `-0.5`).
- **Tooltips are hover-triggered, not persistent.** The static demo no longer renders a `TooltipShell`; step 08 builds the real hover interaction.

Step 02 closed.
