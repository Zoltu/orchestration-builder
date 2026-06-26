# UI step 01 — Fixture data set + dev playback harness

## Goal

Build the test bed for the entire visualization phase: a rich set of mock run snapshots (as frame sequences, so animation can be iterated) plus a mock guild config with inline friendly labels, all shaped exactly like the real `/api/config` and `/api/runs/:id` responses (including the future label/description tiers as if they already exist). Plus a dev-only playback harness that cycles through a fixture's frames, re-deriving the graph each frame — the iteration and operator-review surface for every later step. No real backend is touched in this step or any phase-A step.

## Context

Read [`PLAN.md`](PLAN.md) ("Methodology: fixture-first, backend-last"), `source/web/render.ts` (`RunView`, `RunMeta`, `LogEvent`, `RoleTreeNode`, `Budgets`, `QuestionHistory` — the real shapes the fixtures must match), `source/web/server.test.ts` (the `run-tree` / `run-retry` / `run-cached` / `run-3` fixtures — these are the seed scenarios to generalize into hand-editable frame sequences), and `source/web/render.ts` (`renderConfig` — the `/api/config` shape the mock config matches, extended with the future `label`/`description` tiers on roles and `humanLabel`/`humanDescription` on tools). The fixtures must be shaped so that swapping in real data later (step 13) is a data-source change, not a rewrite: the derivation functions built in steps 03+ consume these fixtures' shape identically to the real API shape.

The guild is loaded once at startup and never mutated (`source/serve.ts`), so the mock config is a stable stand-in for `/api/config` for the whole phase.

## Deliverables

1. **`source/web/static/fixtures.js`** (new, hand-editable) — a set of mock scenarios, each a sequence of frames where every frame is a full `{ config, runView, now }` snapshot. Config matches `renderConfig` output **plus** the future tiered `label`/`description` on each role and `humanLabel`/`humanDescription` on each tool (all three tiers: `detailed`/`playful`/`friendly`), so the UI tier toggle works against fixtures. Scenarios must cover every case the visualization must present:
   - single role in progress (planner thinking)
   - orchestrator → coder delegation in progress (agent→agent flow mid-flight)
   - a tool call in progress (agent→tool flow, no `tool_result` yet)
   - a retry (two coder invocations: first errors, second succeeds) — exercises counter + per-invocation status
   - a pending `ask_human` question (no answer yet) — exercises the question modal + You node incoming edge
   - a completed successful run (orchestrator → planner → coder → critic, with a result) — exercises result modal + static settled graph
   - a failed run (error with `kind` + `message`) — exercises failure surfacing
   - a run with `effort` set — exercises the cost strip
   - a deep multi-role tree (orchestrator → planner → coder, plus a `context_manager` side role) — exercises a deep delegation tree
   Each scenario's frames step through the run's progress so the animation (step 04) has a timeline to play. Frames reuse the `LogEvent` taxonomy from `source/executor/types.ts` (`role_start`, `agent_call`, `llm_call`, `tool_call`, `tool_result`, `role_finished`, `ask_human`, `human_answer`, `effort_set`).
2. **`source/web/fixtures.test.ts`** (new, in-memory) — assert every fixture frame conforms to the real `RunView`/config shape (validate with the existing `parseRunSnapshot`/`renderRunView` or direct shape checks), so a malformed fixture fails loudly rather than producing a confusing visual. Pure tests, no DOM.
3. **`source/web/static/app.js`** — a dev-only **playback harness**: a fixture selector + a play/pause/step/scrub control that loads a scenario and advances through its frames on a timer, rendering the current frame. Clearly isolated (a dev entry path or a clearly-marked dev panel) so step 14 removes it cleanly. For now it renders the raw frame data as a plain debug view (the graph comes in step 03); this step delivers the harness + selector, not the visualization.

## Module boundaries

- Web-only, no backend. The fixtures are placeholder data; the friendly labels in them are placeholders that approximate what a guild author would write — the real labels land in step 12.
- The dev playback harness is throwaway iteration scaffolding, isolated for clean removal in step 14.
- No new dependencies. Fixtures are a plain JS module; the harness is hyperapp + a timer.

## Acceptance criteria

- [x] `bun run typecheck` and `bun test source/` pass.
- [x] Every fixture frame matches the real `RunView`/config shape (including the future tiered label fields); a malformed fixture fails the test.
- [x] All thirteen scenarios are present with multi-frame timelines (the original nine plus four added after operator review: self-delegation, detected-loop, user-interrupt, and a ~15-role large-guild stress case).
- [x] The playback harness loads a scenario and plays/steps/scrubs through its frames.
- [x] The harness is isolated so it can be removed without touching the real run view.

## Operator handoff

Open the playback harness in a browser, step through each fixture scenario, and confirm the scenarios cover the cases the visualization will need to present. Suggest any missing scenario or frame before the visualization steps build on this set.

## Closeout (2026-06-26)

In-environment complete: `bun run typecheck` and `bun test source/` green (505 tests). All thirteen scenarios ship with 2–3 hand-authored frames each, shaped exactly like the real `/api/config` (extended with the future tiered `label`/`description` on roles and `humanLabel`/`humanDescription` on tools) and `/api/runs/:id` `RunView`. `fixtures.test.ts` validates every frame against those shapes (reusing `isResultCard`, `isEffortLevel`, `isErrorKind` for the leaf guards) and pins the thirteen scenario ids and the monotonic-frame-`now`/stable-config invariants.

The four scenarios added after operator review (self-delegation, detected-loop, user-interrupt, large-guild) exercise cases the original nine did not cover: a role delegating to itself (same-named nodes at increasing depth), the loop-detector agent firing an interrupt, an operator inquiry pausing a run, and a ~15-role guild with a deep, wide invocation tree. The detected-loop and user-interrupt scenarios are forward-looking: they model event shapes the interrupt/inspect platform will emit (`interrupt_triggered`, the `loop_detector` role, the `trigger_interrupt` tool) and a future `interrupted` terminal status, so the visualization is ready when that platform lands. The large-guild scenario uses a separate `largeGuildConfig` (15 roles) since the base `mockConfig` carries 7 roles; the `frame()` helper accepts an optional config override, and the stable-config test checks within-scenario identity rather than global `mockConfig` identity. The base `mockConfig` was also expanded to include the real `recovery` role and the forward-looking `loop_detector` role, plus tool metadata for `edit_context`, `context_info`, `trigger_interrupt`, and the role-inspection tools.

Deviations from the plan wording, recorded so the next step inherits reality:

- **The dev playback harness is a separate entry page (`playback.html` + `playback.js`), not an addition to `app.js`.** The plan's deliverable text names `source/web/static/app.js` as the harness host, but `app.js` is the live run-view client (1020 lines) guarded by `server.test.ts` ("app.js contains `fetch`", "/ returns the Adaptive Orchestrator page"). Entangling a throwaway harness into it would risk the real UI and make step-14 removal messy. A dedicated `playback.html` entry that imports `./fixtures.js` and `playback.js` is the cleaner "dev entry path" the plan's isolation clause calls for: the real UI is untouched, and removal is deleting two files plus their routes.
- **Additive static-asset routes were added to `server.ts` (`/fixtures.js`, `/playback.html`, `/playback.js`).** Phase A is otherwise web-only, but the browser harness cannot load `fixtures.js` without it being served. The fixtures module lives under `source/web/static/` (moved from `source/web/` so a path-prefix reverse proxy that serves the `static/` directory directly can reach it — files outside `static/` are not served by the proxy and 404). The routes are purely additive asset serving (no new endpoints, no logic), covered by `server.test.ts` cases, and keep every existing test green.
- **`fixtures.js` is browser-pure (no imports) and hand-builds `RunView` objects via internal builders** rather than deriving them through `renderRunView`. Deriving in-module would require importing `render.ts`, which transitively pulls `executor/validation.ts` and `errors.ts` — modules the static server does not serve, so the browser import would 404. Hand-building keeps the module browser-safe; the shape test guarantees conformance. The builders fill the full field set with defaults so each frame spells out only what its scenario exercises.

Operator action required: open `http://<host>:<port>/playback.html` in a browser and review the nine scenarios, confirming the cases cover what the visualization will need to present and suggesting any missing scenario or frame before step 02 builds on this set.
