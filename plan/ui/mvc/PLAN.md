# MVC refactor — shared `InteractionModel` for Flow + Sequence views

This is a sub-plan under [`plan/ui/`](..). It supersedes the event-derived, cross-view-coupled sequence view built in [`../09-sequence-diagram-scaffold-toggle.md`](../09-sequence-diagram-scaffold-toggle.md) and the `FlowModel`-as-a-type convention established in [`../03-flow-graph-static-layout.md`](../03-flow-graph-static-layout.md). It is sequenced independently among its own steps; the parent UI plan is not renumbered.

## The problem

The flow view and sequence view do not share a model. The flow view consumes a hand-authored `FlowModel` (current-state graph) and derives its own animation state; the sequence view derives its diagram inline from raw `recentLog` events **and** borrows the flow view's precomputed animation state (`deriveSequenceActivity` reads `flowModel` + `flowAnimation`). That dual sourcing is the root cause of the special-case crust that accreted during step 09: dropping a delegated child's `role_start` to match flow-view row count, filtering overseer `agent_call`s via the flow model's call-edge set, hidden-tool activity compensation, the terminal-frame Human override, fixture-window reconstruction (`accumulateRecentLog`), and orphan-tool-call filtering. Each patch exists to force the two views to agree on "what is happening right now" instead of reading one shared answer.

## The design

One model, two views. The model is a **timeline of operations** (`InteractionModel`), not a current-state graph and not an event stream. Both views are leaves over it; neither borrows state from the other. An adapter that turns raw executor `LogEvent`s into `InteractionModel`s is the single place that knows the executor's event vocabulary — that adapter is **out of scope** here (it is the future backend half, the successor to parent step 16) and lands later; this sub-plan is web-only and iterates against hand-authored `InteractionModel` fixtures.

### The model (settled design)

```ts
interface Participant {
	id: string                // instance-scoped, unique per invocation — flow-view node key
	role: string              // role/tool name; 'human' or 'interrupt' for the pseudo-roles; sequence-view column key
	kind: 'human' | 'interrupt' | 'role' | 'tool'
}

interface Operation {
	id: string
	kind: 'call' | 'return' | 'observe'
	stack: string             // call-stack id; the active stack is the one containing the latest operation
	source: string            // participant id; for 'observe' this may be in a different (active) stack than destination
	destination: string       // participant id; never === source for call/return
	startedAt: string
	settledAt: string | null  // null while in_flight; === startedAt for observe (instantaneous)
	lifecycle: 'in_flight' | 'settled'
	outcome: 'success' | 'error' | 'terminated' | null   // returns only; observe always null
	details: string | null    // adapter-formatted markdown body for detail/tooltip surfaces
	metrics: OperationMetrics | null
}

interface InteractionModel {
	participants: Participant[]   // chronological first-appearance order
	operations: Operation[]       // chronological; index === sequence-view row
	status: RunMeta['status'] | 'unknown'
}
```

### The single invariant both views read

> The active stack is the stack of the latest operation. The active participant is the destination of the latest `call`/`return` in the active stack. `observe` never affects activity. A line animates iff it is `in_flight` **and** its stack is the active stack. All other stacks with open calls are *paused*; their lines are static and their participants are not active.

### Interrupts (settled design)

- An interrupt spawns a **new call stack** rooted at a fresh **`Interrupt` pseudo-participant instance** (instance-per-interrupt, like every other role). The stack begins with `call` from the Interrupt instance → the overseer.
- Interrupts can occur at **any time**, including mid-flight. A paused stack may carry an `in_flight` operation; the view freezes its animation (model `lifecycle` is unchanged — it is still genuinely in flight, just suspended).
- The flow view renders each non-terminated stack as a **row**: the main run (rooted at `You`) at the top, each preempting interrupt stack (rooted at an Interrupt instance) below it, active stack at the bottom. `observe` lines cross from the active stack up into a paused row.
- Interrupts are **unbounded and nest** (an interrupt can interrupt an interrupt). Each gets a unique `stack` id; active = latest; fates cascade when stacks resolve.
- A paused stack's **fate** is read off the operations that follow the preempting stack's final `return`, not from a fate field: **resume** (next op on the old stack id), **rewind** (a run of `terminated` returns then a fresh `call` from an ancestor), or **terminate** (a run of `terminated` returns to the root).
- The `interrupt` column/root appears **only on first use** (a normal run with no interrupts is not cluttered). `human`/`You` is always present (every run starts with a human-submitted task).

### Labels (settled design)

Labels are **localization, a view concern**. The model carries no prose — only `role`/`kind` identifiers. A localization registry maps participant `role`/`kind` and operation `kind` → three tiers `{ fun, helpful, detailed }`:

- **fun** — playful, targeted at children/playful users ("chef", "baking a cake"). Fun wins strongly over precise.
- **helpful** — informative and mildly accurate for non-technical users.
- **detailed** — extremely precise for technical users.

Operation labels are templated entries that interpolate the source/destination role labels. A UI **tier toggle** swaps which tier the views render, without touching the model. The `details` markdown field on each operation carries the rich per-call runtime content (arguments/results/summaries) for tooltips — that is data, not localization, so it lives on the model and the adapter formats it.

## Methodology: parallel to the current demo

The current fixture/demo page (`playback.html` + `playback.js` + `fixtures.js` + the event-derived `sequence-diagram.js` + the `FlowModel`-based `flow-view.js`) stays **intact and untouched** until the final cleanup step, so it can be referred back to during development. All new code lives under a `source/web/static/mvc/` subfolder with an explicit new demo entry point:

- `source/web/static/demo.html` — the new demo page (parallel to `playback.html`).
- `source/web/static/demo.js` — the new demo harness (imports `./mvc/*`).
- `source/web/static/mvc/interaction-model.js` — the model (browser-pure JS, JSDoc typedefs + pure helpers).
- `source/web/static/mvc/labels.js` — the localization registry + tier resolver.
- `source/web/static/mvc/primitives.js` — SVG primitives for the new views (parallel to the old `svg-primitives.js`).
- `source/web/static/mvc/flow-view.js` — the new flow view renderer (consumes `InteractionModel`).
- `source/web/static/mvc/sequence-view.js` — the new sequence view renderer (consumes `InteractionModel`).
- `source/web/static/mvc/scenarios.js` — the rewritten demo scenarios as `InteractionModel` frame sequences.

Tests live flat in `source/web/` (matching the existing `flow-view.test.ts` convention): `interaction-model.test.ts`, `labels.test.ts`, `mvc-flow-view.test.ts`, `mvc-sequence-view.test.ts`, `mvc-scenarios.test.ts`.

The final cleanup step promotes the `mvc/` modules to canonical flat names, deletes the old dead code, and rewires the demo entry point.

## Module boundaries (whole sub-plan)

- **Web-only.** No backend, no endpoints, no executor changes. The `InteractionModel` is designed to be the contract the future backend adapter (successor to parent step 16) produces from `LogEvent`s, but that adapter is not built here.
- **Browser-pure modules** under `source/web/static/mvc/` import only their siblings (`./interaction-model.js`, `./primitives.js`, `../svg-primitives.js` where reusable) so the static server serves them and the test runner imports them from the filesystem — mirroring the existing `flow-view.js` convention. The model is browser-pure JS with JSDoc typedefs (not a `.ts`) so the browser view modules can import its runtime helpers; the TS tests import the `.js` and pick up the JSDoc types.
- **Reused unchanged:** `tooltip.js`, `question-modal.js`, `result-modal.js`, `markdown.js`, `markdown-render.js` are not `FlowModel`-coupled and are reused by the new demo as-is. They are not dead after cleanup.
- **No new runtime dependencies.** Hand-rolled SVG + the existing hyperapp + step-27 showdown/highlight.js.
- Every step leaves `bun run typecheck` and `bun test source/` green and the repository clean. The old demo remains functional throughout (it is only deleted in the final step).
- Plan hygiene: source files must never reference this plan — no "mvc step N", `plan/` paths, or step language in comments/identifiers/test names. Comments that need design context point at `docs/*.md` or sibling module paths.

## Cross-cutting notes

- **Supersedes parent UI step 16's contract.** Parent step 16 was to produce a `FlowModel` server-side. After this sub-plan, the contract is `InteractionModel`; a follow-up (not in this sub-plan) updates parent step 16 to produce `InteractionModel` and updates parent steps 13/14 (live hookup, retire legacy) to target the new canonical view modules. This sub-plan does not touch the product UI (`app.js`/`index.html`) — the old flow view was never wired into it (confirmed: `flow-view.js`/`sequence-diagram.js` are referenced only by `playback.js` and the tests), so the refactor is confined to the dev harness.
- **Security invariant preserved.** Identifiers, counters, costs, timestamps are SVG `<text>` textContent. The `details` markdown and any tiered prose flow only through the step-27 sanitized Markdown pipeline. `docs/security.md` is re-confirmed at the polish step.

## Steps

| # | Step | Touches | Depends on |
|---|---|---|---|
| 01 | `InteractionModel`: types + pure derivation helpers | `source/web/static/mvc/interaction-model.js`, `source/web/interaction-model.test.ts` | — |
| 02 | Demo scenarios (rewrite fixtures as `InteractionModel`s) + demo harness scaffold | `source/web/static/mvc/scenarios.js`, `source/web/mvc-scenarios.test.ts`, `source/web/static/demo.html`, `source/web/static/demo.js` | 01 |
| 03 | Label localization registry + tier resolver + toggle | `source/web/static/mvc/labels.js`, `source/web/labels.test.ts`, `source/web/static/demo.js` | 02 |
| 04 | Flow view — static layout from `InteractionModel` | `source/web/static/mvc/primitives.js`, `source/web/static/mvc/flow-view.js`, `source/web/mvc-flow-view.test.ts`, `source/web/static/demo.js` | 02, 03 |
| 05 | Flow view — animation + node lifecycle | `source/web/static/mvc/flow-view.js`, `source/web/static/demo.js`, `source/web/mvc-flow-view.test.ts` | 04 |
| 06 | Sequence view — static layout from `InteractionModel` | `source/web/static/mvc/sequence-view.js`, `source/web/mvc-sequence-view.test.ts`, `source/web/static/demo.js` | 04 |
| 07 | Sequence view — animation + inspector + zoom/pan | `source/web/static/mvc/sequence-view.js`, `source/web/static/demo.js`, `source/web/mvc-sequence-view.test.ts` | 06 |
| 08 | Interrupts & nested interrupts — stress/integration across both views | `source/web/static/mvc/scenarios.js`, `source/web/static/mvc/flow-view.js`, `source/web/static/mvc/sequence-view.js`, tests | 05, 07 |
| 09 | Product surfaces (now caption + cost strip) + polish + sign-off | `source/web/static/mvc/`, `source/web/static/demo.js`, `source/web/static/styles.css`, `docs/security.md` | 08 |
| 10 | Cleanup: delete old dead code, promote `mvc/` to canonical names | `source/web/static/`, `source/web/*.test.ts`, `source/web/static/styles.css` | 09 |

Steps 04→05 and 06→07 are sequential within each view track; 04 and 06 may overlap once 04's primitives are settled. 08 is the integration/stress step for the interrupt concept across both views. 09 is the gate before cleanup. 10 is the only step that deletes or renames anything.

## Sign-off

**Code-side gate met (2026-06-30):** step 09 closes with `bun run typecheck` and `bun test source/` green, the "now" caption and cost strip ported to read off `InteractionModel` (`deriveNowCaption` / `deriveCostStrip` in `source/web/static/mvc/flow-view.js`), both wired into `demo.js` per frame, `docs/security.md` re-confirmed for the refactored visualization, and the styles.css polish pass applied across both themes. The old `playback.html`/`playback.js`/`fixtures.js` remain untouched and functional. Step 10 (cleanup: delete old dead code, promote `mvc/` to canonical names) begins from this known-good refactor. Operator visual sign-off across every scenario in both themes and both tiers is the remaining gate and is requested via the step-09 operator handoff; this entry records only that the code-side gate is met, not that the operator has signed off.
