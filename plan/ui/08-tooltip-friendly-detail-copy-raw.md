# UI step 08 — Tooltip interaction: friendly-formatted detail on hover

## Goal

Make nodes and edges in the flow view inspectable: hovering a node or edge (in the main area or the top bar) shows a **friendly-formatted** detail view (labeled blocks, pretty-printed JSON for arguments/result, assistant prose as sanitized Markdown). The formatted view is read-only and disappears when the pointer leaves the hovered element. This builds the reusable tooltip module that the sequence diagram (steps 09–10) also uses. Iterated against fixtures.

## Context

Read [`PLAN.md`](PLAN.md) ("Tooltips"), [`02-visual-foundation-tokens-svg-primitives.md`](02-visual-foundation-tokens-svg-primitives.md) (the `TooltipShell` primitive), `source/web/render.ts` (`formatLogDetailSections` — the existing paired-detail shaping: sent/received/finish reason/usage for `llm_call`; arguments/result for `tool_call`/`tool_result`; summary/error for `role_finished`), and `source/web/static/markdown.js` (the sanitized Markdown renderer). The detail shaping already exists; this step renders it human-friendly inside a hover tooltip.

## Adaptation from the original plan

The plan as written called for an SVG tooltip built on the step-02 `TooltipShell` and wired into `app.js`. Both proved wrong on contact with the rendering pipeline, and the plan was adapted rather than the code forced to match:

- **HTML overlay, not the SVG `TooltipShell`.** The card must render sanitized-Markdown vnodes (HTML `<p>`/`<ul>`/… the `markdown-render` pipeline produces) and a wrapping `<pre>` for pretty-printed JSON; SVG cannot host HTML elements (no `<foreignObject>` is in use), so the tooltip follows the question/result modal pattern — an HTML `<div>` overlay scoped to the run view. `TooltipShell` stays on disk for any future SVG-text-only tooltip; this card is what the flow view and the future sequence diagram reuse.
- **Hover, not click.** The original plan said hover/click; the operator directed hover-only. The card is `pointer-events: none` so it never intercepts the pointer — the hover target stays the node/edge beneath it, and leaving that geometry is what dismisses the card (no flicker, no close-on-empty-click, no hover-bridge). The card carries no buttons (no copy-raw — see below), so it needs no pointer interaction.
- **No "copy raw" button.** The original plan included a copy-raw button; the operator judged it provides no value in this view and directed its removal. The card is read-only: the formatted view is for reading while the pointer rests on the node/edge.
- **Wired into the playback harness (`source/web/static/playback.js`), not `app.js`.** `app.js` renders the legacy panels; the flow view is rendered only by the dev playback harness today, and the live hookup is a later phase-B step (13). The wiring therefore lives in `playback.js` (state, `OpenTooltip`/`CloseTooltip` actions, `onNode`/`onEdge` activate handlers returning `onmouseenter`, a shared `CloseTooltip` `onmouseleave`, the `TooltipOverlay`) plus a small `interactions` parameter added to `renderFlowView` so the renderer attaches the caller-supplied hover handlers to nodes and edges without knowing what a hover does. `app.js` will receive the identical wiring when step 13 swaps the fixture model for live data.

## Deliverables

1. **`source/web/static/tooltip.js`** (new module) — a `Tooltip` component that takes a `LogDetailSection[]` (or a node's role/counter/cost summary) and renders each section: a labeled block, with the content formatted friendly — pretty-printed JSON (`JSON.stringify(content, null, 2)`, indented, no raw `\n` escapes) for object/array content, sanitized Markdown (step-27 `renderMarkdown`) for prose content (assistant responses, summaries, error messages, task text, question text), and plain text for scalars (a `scalar: true` flag the derivation sets on status words, counts, and formatted times; numbers/booleans are scalars by type). A string content is first probed with `JSON.parse` so a JSON-encoded tool-arguments string pretty-prints rather than rendering as a one-line Markdown paragraph. The card is read-only (no buttons) and `pointer-events: none`. The module also exports the pure `deriveTooltipForNode` / `deriveTooltipForEdge` mappings (node/edge + current frame → `{ title, sections }`) so the wiring is a thin caller.
2. **`source/web/tooltip.test.ts`** (new, in-memory) — assert the tooltip renders each content kind to the right vnode shape (pretty-printed JSON as a `<pre>` text node, prose as sanitized-Markdown vnodes, scalar as text), that a JSON-encoded string is probed and pretty-printed, that the `scalar` flag forces plain text, and that the card carries no buttons and no `onclick`. Also pins the node/edge → sections derivations. Uses the fake-`h` pattern; no DOM.
3. **`source/web/static/flow-view.js`** — `renderFlowView` gains an optional `interactions` parameter (`{ onNodeActivate, onEdgeActivate, onLeave }`); the value `onNodeActivate`/`onEdgeActivate` returns becomes that element's `onmouseenter`, and `onLeave` is attached to every element's `onmouseleave`, so the caller can open/close a tooltip on hover without the renderer knowing what a hover does. `GraphEdge` (svg-primitives) passes optional `onmouseenter`/`onmouseleave` through to the `<path>`.
4. **`source/web/static/playback.js`** — wire hover on flow-view nodes and edges (both main-area and top-bar) to open the tooltip with the relevant `LogDetailSection`s (for edges, the `llm_call`/`tool_call`/`tool_result`/`role_finished`/`ask_human` detail; for main-area nodes, the role's activity + status + finish summary, the tool's most recent call/result detail, or the root You's task; for top-bar nodes, the role's cumulative summary + counter + cost). The pointer leaving the hovered element closes the tooltip; the tooltip clears on every frame change so a card opened on a departed node never lingers. Against fixtures, every detail-populated event type is reachable.
5. **`source/web/static/styles.css`** — tooltip styling: a `position: fixed` `pointer-events: none` card that doesn't overflow the viewport (inline `left/top` or `right/bottom` resolved at hover time to flip near an edge, plus `max-width`/`max-height` clamps and inner scrolling), theme-aware, with readable pretty-printed JSON and Markdown. Hoverable nodes and edges carry `cursor: help`.
6. **`docs/security.md`** — note the tooltip renders prose via the sanitized Markdown path and pretty-printed JSON as text nodes, and that the card is read-only/`pointer-events: none` with no copy path; no untrusted content reaches the DOM as markup except via the sanitized Markdown path.

## Module boundaries

- Web-only, fixture-driven. Reuses `formatLogDetailSections` from `render.ts` (no change to the shaping — the fixtures' `recentLog` entries already carry the paired `detailSections`) and `renderMarkdown` from `markdown-render.js`. No backend or endpoint changes.
- The tooltip module is deliberately standalone so the sequence diagram (steps 09–10) reuses it without modification.

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass.
- [ ] Hovering a flow-view node or edge (main area or top bar) shows a friendly-formatted tooltip with the relevant detail sections; the tooltip disappears when the pointer leaves. *(operator review)*
- [ ] JSON content is pretty-printed; prose content is sanitized Markdown; scalars are plain text. *(operator review)*
- [ ] The tooltip doesn't overflow the viewport and reads correctly in light and dark. *(operator review)*
- [x] No untrusted content reaches the DOM as markup except via the step-27 sanitized Markdown path.

## Operator handoff

Hover nodes and edges across the fixtures (especially the `llm_call` sent/received, `tool_call` arguments, `tool_result` result, and `role_finished` error detail). Confirm the friendly formatting reads well, pretty-printed JSON is legible, Markdown prose renders, the card stays open while the pointer rests on the element and dismisses cleanly on leave, and the viewport-flip placement reads well. Report formatting/placement adjustments.
