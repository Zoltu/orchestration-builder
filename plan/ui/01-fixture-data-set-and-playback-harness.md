# UI step 01 — Fixture data set + dev playback harness

## Goal

Build the test bed for the entire visualization phase: a rich set of mock run snapshots (as frame sequences, so animation can be iterated) plus a mock guild config with inline friendly labels, all shaped exactly like the real `/api/config` and `/api/runs/:id` responses (including the future label/description tiers as if they already exist). Plus a dev-only playback harness that cycles through a fixture's frames, re-deriving the graph each frame — the iteration and operator-review surface for every later step. No real backend is touched in this step or any phase-A step.

## Context

Read [`PLAN.md`](PLAN.md) ("Methodology: fixture-first, backend-last"), `source/web/render.ts` (`RunView`, `RunMeta`, `LogEvent`, `RoleTreeNode`, `Budgets`, `QuestionHistory` — the real shapes the fixtures must match), `source/web/server.test.ts` (the `run-tree` / `run-retry` / `run-cached` / `run-3` fixtures — these are the seed scenarios to generalize into hand-editable frame sequences), and `source/web/render.ts` (`renderConfig` — the `/api/config` shape the mock config matches, extended with the future `label`/`description` tiers on roles and `humanLabel`/`humanDescription` on tools). The fixtures must be shaped so that swapping in real data later (step 13) is a data-source change, not a rewrite: the derivation functions built in steps 03+ consume these fixtures' shape identically to the real API shape.

The guild is loaded once at startup and never mutated (`source/serve.ts`), so the mock config is a stable stand-in for `/api/config` for the whole phase.

## Deliverables

1. **`source/web/fixtures.js`** (new, hand-editable) — a set of mock scenarios, each a sequence of frames where every frame is a full `{ config, runView, now }` snapshot. Config matches `renderConfig` output **plus** the future tiered `label`/`description` on each role and `humanLabel`/`humanDescription` on each tool (all three tiers: `detailed`/`playful`/`friendly`), so the UI tier toggle works against fixtures. Scenarios must cover every case the visualization must present:
   - single role in progress (planner thinking)
   - orchestrator → coder delegation in progress (agent→agent flow mid-flight)
   - a tool call in progress (agent→tool flow, no `tool_result` yet)
   - a retry (two coder invocations: first errors, second succeeds) — exercises counter + per-invocation status
   - a pending `ask_human` question (no answer yet) — exercises the question modal + You node incoming edge
   - a completed successful run (orchestrator → planner → coder → critic, with a result) — exercises result modal + static settled graph
   - a failed run (error with `kind` + `message`) — exercises failure surfacing
   - a run with `effort` set — exercises the cost strip
   - a deep multi-role tree (orchestrator → planner → coder, plus a `context_manager` side role) — exercises the tiered layout
   Each scenario's frames step through the run's progress so the animation (step 04) has a timeline to play. Frames reuse the `LogEvent` taxonomy from `source/executor/types.ts` (`role_start`, `agent_call`, `llm_call`, `tool_call`, `tool_result`, `role_finished`, `ask_human`, `human_answer`, `effort_set`).
2. **`source/web/fixtures.test.ts`** (new, in-memory) — assert every fixture frame conforms to the real `RunView`/config shape (validate with the existing `parseRunSnapshot`/`renderRunView` or direct shape checks), so a malformed fixture fails loudly rather than producing a confusing visual. Pure tests, no DOM.
3. **`source/web/static/app.js`** — a dev-only **playback harness**: a fixture selector + a play/pause/step/scrub control that loads a scenario and advances through its frames on a timer, rendering the current frame. Clearly isolated (a dev entry path or a clearly-marked dev panel) so step 14 removes it cleanly. For now it renders the raw frame data as a plain debug view (the graph comes in step 03); this step delivers the harness + selector, not the visualization.

## Module boundaries

- Web-only, no backend. The fixtures are placeholder data; the friendly labels in them are placeholders that approximate what a guild author would write — the real labels land in step 12.
- The dev playback harness is throwaway iteration scaffolding, isolated for clean removal in step 14.
- No new dependencies. Fixtures are a plain JS module; the harness is hyperapp + a timer.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass.
- [ ] Every fixture frame matches the real `RunView`/config shape (including the future tiered label fields); a malformed fixture fails the test.
- [ ] All nine scenarios are present with multi-frame timelines.
- [ ] The playback harness loads a scenario and plays/steps/scrubs through its frames.
- [ ] The harness is isolated so it can be removed without touching the real run view.

## Operator handoff

Open the playback harness in a browser, step through each fixture scenario, and confirm the scenarios cover the cases the visualization will need to present. Suggest any missing scenario or frame before the visualization steps build on this set.
