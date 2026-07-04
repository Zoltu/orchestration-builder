# MVC step 10 — Cleanup: delete old dead code, promote `mvc/` to canonical names

## Goal

Remove every line of code the MVC refactor replaces, and promote the new `mvc/` modules to the canonical flat names so the codebase has one flow view, one sequence view, one model, and one demo. After this step there is no trace of the `FlowModel`-as-a-type convention, the event-derived sequence view, the fixture-window reconstruction machinery, or the old demo harness. `bun run typecheck` and `bun test source/` stay green throughout.

## Context

Read [`PLAN.md`](PLAN.md) ("Methodology: parallel to the current demo") and the closeout of step 09. The old code was kept intact through steps 01–09 so it could be referred back to during development; with sign-off complete, it is now dead. Confirmed during scoping: `flow-view.js` and `sequence-diagram.js` are referenced only by `playback.js` and the tests (never wired into the product `app.js`/`index.html` — parent phase B never ran), so deleting them breaks nothing in the product UI.

## Deliverables

1. **Delete the old demo + fixtures + their tests:**
   - `source/web/static/playback.html`
   - `source/web/static/playback.js`
   - `source/web/static/fixtures.js`
   - `source/web/fixtures.test.ts` (if present)
2. **Delete the old view modules + their tests:**
   - `source/web/static/flow-view.js`
   - `source/web/static/sequence-diagram.js`
   - `source/web/flow-view.test.ts`
   - `source/web/sequence-diagram.test.ts`
3. **Delete the old SVG primitives + their test (replaced by `mvc/primitives.js`):**
   - `source/web/static/svg-primitives.js`
   - `source/web/svg-primitives.test.ts`
4. **Delete `source/web/static/pathfinding.js`** if the new sequence view does not use it (confirm via grep before deleting; it was retained on disk for the sequence diagram under the old plan, but the new sequence view's loopback/observe layout does not require it).
5. **Promote the `mvc/` modules to canonical flat names** (git mv + import-path edits):
   - `mvc/interaction-model.js` → `source/web/static/interaction-model.js`
   - `mvc/labels.js` → `source/web/static/labels.js`
   - `mvc/primitives.js` → `source/web/static/svg-primitives.js` (the canonical primitives name)
   - `mvc/flow-view.js` → `source/web/static/flow-view.js`
   - `mvc/sequence-view.js` → `source/web/static/sequence-diagram.js` (the canonical sequence name)
   - `mvc/scenarios.js` → `source/web/static/scenarios.js` (dev-only, kept for the demo; removed later when parent phase B retires the dev harness)
6. **Rename the tests** to match: `interaction-model.test.ts`, `labels.test.ts`, `svg-primitives.test.ts`, `flow-view.test.ts`, `sequence-diagram.test.ts`, `scenarios.test.ts`. Update import paths (`./mvc/*` → `./static/*`).
7. **`source/web/static/demo.js` and `demo.html`** — update imports to the promoted flat paths. `demo.html` is now the canonical dev harness (the old `playback.html` is gone).
8. **`source/web/static/styles.css`** — remove any CSS blocks that referenced the old demo's structure and are now unused; keep the shared `.flow-*`/`.seq-*`/`.graph-edge--*` classes the new views reuse. Sweep for orphaned rules.
9. **`plan/ui/PLAN.md`** (the parent UI plan) — add a dated note that the MVC sub-plan superseded the `FlowModel` contract, so parent steps 13 (live hookup), 14 (retire legacy), and 16 (backend flow model) now target `InteractionModel` and the new canonical view modules; the backend adapter (events → `InteractionModel`) is the successor to parent step 16's `deriveFlowModel`. This is a plan-edit only, no source change.
10. **Final hygiene sweep:** grep for `FlowModel`, `recentLog`, `deriveSequenceActivity`, `buildCallEdgeColumns`, `isRealDelegation`, `filterOrphanToolCalls`, `accumulateRecentLog`, `playback`, and the old `fixtures.js` references across `source/` — none should remain outside this plan directory. Re-read every changed file against `AGENTS.md` "Comments" and "Formatting."

## Module boundaries

- Web-only, deletion + rename + import-path edits. No behavior change — the new demo behaves exactly as it did at step 09 sign-off.
- No backend, no executor, no product-UI (`app.js`/`index.html`) changes.

## Acceptance criteria

- [ ] `bun run typecheck` and `bun test source/` pass after every deletion and every rename (commit-or-checkpoint incrementally so a broken import is caught immediately, not at the end).
- [ ] No file under `source/` references `FlowModel`, `recentLog`, `deriveSequenceActivity`, `buildCallEdgeColumns`, `isRealDelegation`, `filterOrphanToolCalls`, `accumulateRecentLog`, `playback`, or the old `fixtures.js`.
- [ ] `source/web/static/` contains exactly one flow view (`flow-view.js`), one sequence view (`sequence-diagram.js`), one model (`interaction-model.js`), one labels module (`labels.js`), one primitives module (`svg-primitives.js`), one demo (`demo.html` + `demo.js`), and the dev scenarios (`scenarios.js`). No `mvc/` subfolder remains.
- [ ] `demo.html` runs and behaves identically to the step-09 sign-off state.
- [ ] `plan/ui/PLAN.md` records the contract supersession; parent steps 13/14/16 are flagged for re-scoping.
- [ ] Comment/newline hygiene swept across all changed files; no plan/step references in source.
