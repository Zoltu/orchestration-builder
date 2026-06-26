# UI redesign — flow-graph run view

This is a sub-plan for a radical redesign of the web run view, produced by the step-29 brainstorm session. It lives under `plan/ui/` so the main `plan/` sequence stays focused on the executor/Foundry track; the steps here are numbered independently and sequenced among themselves. A short pointer is added to `plan/README.md`; the main plan is not renumbered.

## The problem

The current run view (steps 14–21, 27, 28) is a flat list of debug-oriented panels: role-activity table, raw log rows, config dump. It is a good **development iteration** UI but wrong for the product audience — a **non-developer** left with the page open 24/7. It shows metrics and debugging data, not *what is happening*. A long run looks like an undifferentiated scrolling wall of `planner · llm call` rows.

## The design

Two views, toggled. **Flow** is the default and the product surface; **Sequence** is the debug/investigation surface behind a toggle.

### Flow view (default)

An ambient **graph** is the centerpiece. Nodes are the guild's roles plus a **"You" (Human) node** that is the root — the run begins from the human's question, so the Human node lights up first. Tools are a cluster at the bottom. **Edges** represent agent→agent and agent→tool calls.

- **Static layout for the life of a run.** The node set is seeded from `/api/config` (which reflects the guild loaded at server startup — the guild is read once at startup, never re-read or mutated; see `source/serve.ts`). The layout (Human root → entry role → workers → `context_manager`/`recovery` → tools cluster) is computed once and never moves, so the page is calm — no layout thrash as a run progresses.
- **Repeated invocations are not new nodes.** A role called many times shows a **counter badge** on its node (accumulated invocations) and accumulated **time + tokens**; the active invocation is expanded/highlighted, completed ones fold into the counter. This keeps a 200-call run legible.
- **Flow animation along the active path.** The edge to the currently-active receiver "flows" (CSS `stroke-dasharray` animation) and the receiving node pulses. At **turn granularity** (non-streaming, what we ship first): an agent→agent edge flows from `agent_call`/`role_start` until the child's **first `llm_call`** (first turn done); an agent→tool edge flows from `tool_call` to `tool_result`; the tool→agent return flows on `tool_result`. Token-level "flow until first byte" is a future enhancement (step 15) that depends on streaming / a new `llm_call_start` executor event.
- **Human-friendly node labels.** Every role and tool carries a tiered `label` and `description` (`detailed` required; `playful`/`friendly` optional) added to the guild schema (step 12). The UI renders the **`friendly`** tier by default (falling back to `detailed`, then title-cased name) and offers a tier toggle. Guild authors may be playful ("Baking cookies…").
- **"Now" caption.** One plain-language line under the graph derived from the active role/tool — meaning the graph's structure alone can't convey to a non-developer.
- **Costs.** Per-node accumulated time + tokens; a quiet ambient strip in the page border (elapsed · tokens · effort) always present. Dollar pricing is a trivial later addition if priced.
- **Human question = modal.** `ask_human` opens a **per-run-view modal** (covers the main view, not the page, so a future multi-run world lets the user switch away and back). The "You" node shows the question arriving and the answer leaving; it behaves like any other node (biological, not silicon) — counter accumulates Q&A, persists for the whole run as part of the record. Flash + beep cover the away-from-keyboard case (existing).
- **Result = modal only**, fired on completion, no persistent panel. A clearly-placed **"View result"** CTA button re-opens it. The assistant's final response is rendered as sanitized Markdown (step 27 path).
- **Failure.** Red lines/nodes; the raw error is surfaced in a copyable block with honest framing ("Something went wrong — here's what the system reported; copy this to share with support or your own assistant"). The machine `kind` is hidden; the `message` is sanitized Markdown. No happy-talk translation.
- **Tooltips.** Hovering/clicking a node or edge shows a **friendly-formatted** detail view (labeled blocks, pretty-printed JSON for arguments/results, assistant prose as sanitized Markdown — reusing the `LogDetailSection` shaping from `source/web/render.ts`). A **"copy raw"** button copies the raw JSON for sharing, when visual space allows; the formatted view is for reading.

### Sequence view (debug toggle)

An SVG **sequence diagram**: one column per role plus a "tools" column, messages as horizontal lines on a vertical time axis. Hovering a line shows the request/response; hovering an object at a line's end shows intermediate thinking. Because it is SVG with a `viewBox`, **zoom-to-scroll and pan are nearly free** (tweak the viewBox on wheel/drag); a zoomed-out minimap is deferred until a real need arises. The hover inspector reuses the tooltip/detail components built for the flow view. This view is pragmatic for investigating a completed or stuck run, not for ambient monitoring — it grows long, which is acceptable for a debug surface. "Is it stuck?" investigation lives here, not in the flow view.

### Around the views (unchanged from today)

The left **sidebar** keeps the run list with an obvious "selected" state (one task per row, task on its own line as sanitized Markdown — the step-28 reformat). The **new-run editor** (multiline textarea, Enter=newline, Tab=tab, Ctrl/Cmd+Enter=submit) and **effort slider** stay in the main column above the view. No run label is duplicated on the page — the sidebar selection carries identity.

## Methodology: fixture-first, backend-last

UI work iterates heavily, and iterating against real runs is slow — reproducing a retry, a pending question, an error, or a deep delegation just to see how the UI presents each is wasteful. So this sub-plan is split into two phases:

- **Phase A (steps 01–11): nail the visualization against fixture data.** A rich set of mock run snapshots (as frame sequences, so animation can be iterated) plus a mock config with inline friendly labels is the test bed. Every derivation function is designed to consume the **real** `/api/config` + `/api/runs/:id` shape (including the future label/description tiers as if they already exist), so it is fed fixture data of that exact shape. The dev playback harness cycles through a fixture's frames, re-deriving the graph each frame — this is both the iteration surface and the operator review surface. No backend changes in phase A.
- **Phase B (steps 12–14): backend changes + hookup, then retire the legacy UI.** Only after the operator signs off on the visualization do we make the backend changes the nailed-down UI needs (the guild label/description schema, step 12), wire the derivation functions to real `/api/config` + `/api/runs/:id` (step 13 — a data-source swap, not a rewrite, because phase A consumed the real shape), and retire the legacy panels (step 14).

This means we never build a backend field the UI turns out not to need, and the heavy visual iteration happens against instant, deterministic, hand-editable fixtures.

## Cross-cutting decisions

- **Light/dark theme follows the browser** via `prefers-color-scheme`. Both palettes must look good; step 02 establishes the token system that supports both.
- **Hand-rolled SVG, no new dependency.** Evaluated d3/dagre/elk/cytoscape — none clear the bar (auditable, no transitive deps, preserves the `textContent` security invariant). The guild graph is constrained enough that a ~30-line tier+index layout suffices; dagre (layout-only) is a possible *second* operator-approved exception if manual layout proves limiting for weird guild shapes, but we start dependency-free. Hyperapp renders SVG as vnodes; edges are `<path>`, nodes `<g>`, labels `<text>` (textContent — security invariant holds).
- **SVG structure for maintainability.** Every node is a self-contained component laid out against its own local origin (`0,0`); the graph layout only assigns each node an `(x, y)` translate. Edges are a separate layer reading node anchor positions. No hardcoded padding/margins inside the SVG — borders/padding live on the container. This makes moving a node a one-number change and keeps UI trial-and-error cheap.
- **Security invariant preserved.** Role/tool names, timestamps, counters, and costs are SVG `<text>` textContent. Any agent-authored prose (prompts, responses, summaries, reasoning, error messages, task text) flows only through the step-27 sanitized Markdown pipeline, never `innerHTML`. `docs/security.md` is extended as each step lands.
- **Guild/run mismatch is not handled.** A historical run viewed after a server restart that changed the guild may reference roles the current guild lacks. We write **no code** for this maybe-not-real problem; if it becomes real, it is addressed then.
- **Mobile is out of scope** for this sub-plan. The flow graph and sequence diagram are desktop-first; mobile will need a radically different, separate brainstorm later. Noted for the future.
- **Accessibility is deprioritized** per operator direction. The "now" caption is retained as a product-meaning surface (not an a11y feature), but no special screen-reader work is in scope.

## Module boundaries (whole sub-plan)

- **Phase A is web-only and changes no backend.** The derivation functions live in `source/web/render.ts` (pure, tested in `render.test.ts` against fixtures); the view components, primitives, and dev playback harness live in `source/web/static/`. Phase A may proceed in parallel with the main plan's executor track (steps 30–32).
- **Phase B touches the backend once:** step 12 adds the guild label/description schema (`source/executor/types.ts`, `validation.ts`, `loader.ts`, the seed guild, `renderConfig`) — a small, well-contained, data-only change with no runtime behavior change. Step 13 wires the phase-A derivation functions to live data. Step 14 retires legacy panels. Step 15 (deferred) is the only executor-runtime change and is gated on the main-plan executor unfreeze (step 30).
- No new runtime dependencies (the SVG work is built-ins + the existing hyperapp + step-27 showdown/highlight.js). No new endpoints beyond what step 12 adds to `/api/config`.
- Every step leaves `bun run typecheck` and `bun test source/` green and the repository clean.

## Steps

| # | Step | Phase | Touches | Depends on |
|---|---|---|---|---|
| 01 | Fixture data set + dev playback harness | A | `source/web/fixtures.*`, `source/web/static/` (dev playback) | — |
| 02 | Visual foundation: light/dark tokens + SVG primitives | A | `source/web/static/` | 01 |
| 03 | Flow graph: static layout + data derivation | A | `source/web/render.ts`, `source/web/static/` | 02 |
| 04 | Flow graph: animation + active-path highlighting | A | `source/web/render.ts`, `source/web/static/` | 03 |
| 05 | Product surfaces: "now" caption + budget bar + cost strip | A | `source/web/render.ts`, `source/web/static/` | 03 |
| 06 | Human question modal + "You" node as root | A | `source/web/render.ts`, `source/web/static/` | 03 |
| 07 | Result modal + CTA + failure surfacing | A | `source/web/render.ts`, `source/web/static/` | 06 |
| 08 | Tooltip interaction: friendly detail + copy-raw | A | `source/web/static/` | 02, 03 |
| 09 | Sequence diagram view (debug toggle): scaffold + toggle | A | `source/web/render.ts`, `source/web/static/` | 02, 08 |
| 10 | Sequence diagram interaction: inspector + zoom/pan | A | `source/web/static/` | 09, 08 |
| 11 | Visualization sign-off + polish (phase A close) | A | `source/web/static/` | 04, 05, 06, 07, 08, 10 |
| 12 | Guild human-facing label/description tiers | B | `source/executor/*`, `guild/`, `source/web/render.ts` | 11 |
| 13 | Hook up to real backend (replace fixtures with live data) | B | `source/web/static/` | 12 |
| 14 | Make flow view the default; retire legacy panels; polish | B | `source/web/static/`, `source/web/render.ts`, `docs/security.md` | 13 |
| 15 | *(Deferred, executor-dependent)* `llm_call_start` / streaming for token-level flow | — | `source/executor/` | main-plan step 30 |

Steps 04–08 are largely independent once 03 lands and may be parallelized across workers; 09–10 are an independent track off 02/08; 11 is the phase-A integration + sign-off; 12–14 are sequential (backend → hookup → retire). Step 15 is documented but not sequenced until the executor unfreezes.

## Operator handoffs

UI work requires human eyes on the rendered result. Every step from 02 onward ends with an **operator browser review** of the fixture-driven view (phase A) or the live view (phase B). The in-environment portion (code, in-memory tests, typecheck) is complete and green before each handoff; the operator confirms the visual/interaction result and the agent iterates the CSS/SVG from feedback until sign-off. Phase A's handoffs use the dev playback harness against fixtures, so no real LLM run is needed to review any scenario — the operator sees retries, pending questions, errors, and deep delegations instantly by selecting a fixture.
