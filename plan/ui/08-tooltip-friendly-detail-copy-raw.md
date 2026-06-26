# UI step 08 — Tooltip interaction: friendly-formatted detail + copy-raw

## Goal

Make nodes and edges in the flow view inspectable: hovering/clicking a node or edge (in the main area or the top bar) shows a **friendly-formatted** detail view (labeled blocks, pretty-printed JSON for arguments/results, assistant prose as sanitized Markdown), with a **"copy raw"** button that copies the raw JSON for sharing when visual space allows. The formatted view is for reading; the copy is for paste-to-share. This builds the reusable tooltip module that the sequence diagram (steps 09–10) also uses. Iterated against fixtures.

## Context

Read [`PLAN.md`](PLAN.md) ("Tooltips"), [`02-visual-foundation-tokens-svg-primitives.md`](02-visual-foundation-tokens-svg-primitives.md) (the `TooltipShell` primitive), `source/web/render.ts` (`formatLogDetailSections` — the existing paired-detail shaping: sent/received/finish reason/usage for `llm_call`; arguments/result for `tool_call`/`tool_result`; summary/error for `role_finished`), and `source/web/static/markdown.js` (the sanitized Markdown renderer). The detail shaping already exists; this step renders it human-friendly inside a tooltip and adds copy-raw.

## Deliverables

1. **`source/web/static/tooltip.js`** (new module) — a `Tooltip` component built on the step-02 `TooltipShell` that takes a `LogDetailSection[]` (or a node's role/counter/cost summary) and renders each section: a labeled block, with the content formatted friendly — pretty-printed JSON (indent, no raw `\n` escapes) for object/array content, sanitized Markdown (step-27 `renderMarkdown`) for prose content (assistant responses, summaries, error messages, task text), and plain text for scalars. Includes a "copy raw" button (present when space allows) that copies the raw JSON of the section content via `navigator.clipboard`.
2. **`source/web/static/tooltip.test.ts`** (new, in-memory) — assert the tooltip renders each content kind to the right vnode shape (pretty-printed JSON as a `<pre>` text node, prose as sanitized-Markdown vnodes, scalar as text) and that the copy-raw button is wired with the raw JSON. Use the fake-`h` pattern; no DOM, no real clipboard (assert the payload, not the side effect).
3. **`source/web/static/app.js`** — wire hover/click on flow-view nodes and edges (both main-area and top-bar) to open the tooltip with the relevant `LogDetailSection`s (for edges, the `llm_call`/`tool_call`/`tool_result`/`role_finished` detail; for main-area nodes, the role's current-invocation activity summary + status; for top-bar nodes, the role's cumulative summary + counter + cost). Clicking a tooltip's copy-raw button copies; clicking elsewhere closes the tooltip. Text selection inside the tooltip still works (hence a button, not copy-on-any-click). Against fixtures, every detail-populated event type is reachable.
4. **`source/web/static/styles.css`** — tooltip styling: a positioned card that doesn't overflow the viewport (flip/clip as needed), theme-aware, with readable pretty-printed JSON and Markdown. The "copy raw" button is compact.
5. **`docs/security.md`** — note the tooltip renders prose via the sanitized Markdown path and pretty-printed JSON as text nodes; copy-raw copies JSON (no markup), so no untrusted content reaches the clipboard as anything but text.

## Module boundaries

- Web-only, fixture-driven. Reuses `formatLogDetailSections` from `render.ts` (no change to the shaping) and `renderMarkdown` from `markdown.js`. No backend or endpoint changes.
- The tooltip module is deliberately standalone so steps 09–10 (sequence diagram) reuse it without modification.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] Hovering/clicking a flow-view node or edge (main area or top bar) shows a friendly-formatted tooltip with the relevant detail sections.
- [ ] JSON content is pretty-printed; prose content is sanitized Markdown; scalars are plain text.
- [ ] A "copy raw" button copies the raw JSON (when space allows); text selection inside the tooltip still works.
- [ ] The tooltip doesn't overflow the viewport and reads correctly in light and dark.
- [ ] No untrusted content reaches the DOM as markup except via the step-27 sanitized Markdown path.

## Operator handoff

Hover/click nodes and edges across the fixtures (especially the `llm_call` sent/received, `tool_call` arguments, `tool_result` result, and `role_finished` error detail). Confirm the friendly formatting reads well, pretty-printed JSON is legible, Markdown prose renders, and copy-raw works. Report formatting/placement adjustments.
