# Run visualization

The web client renders an in-progress or completed run two ways: a **flow view** (the product surface — a stack-of-rows call graph) and a **sequence view** (the temporal debug surface — a UML-style lifeline diagram). Both read a single shared model, the `InteractionModel`, and neither borrows state from the other. This document captures the design of that model and the two views; the rendering security invariant is covered in [`docs/security.md`](security.md) "Web client rendering pipeline".

## Why a shared model

A run visualization needs to answer one question everywhere: *what is happening right now?* — which call is in flight, which participant is active, which line should animate. The two views used to answer it independently (the flow view derived activity from a current-state graph; the sequence view derived its diagram from raw log events and borrowed the flow view's precomputed animation state). Dual sourcing is what made the two views drift: every agreement between them had to be forced with a special case, and each special case was a hack tuned to a particular demo frame rather than a rule.

The fix is structural, not procedural: **one model answers the question once, and both views read that answer.** Every "what is happening right now" question is a pure helper over the model's operation list. The views never re-derive activity, so they cannot disagree.

## The model

The `InteractionModel` (`source/web/static/interaction-model.js`) is a **timeline of operations** over a set of participants, plus a run status. It is neither a current-state graph nor an event stream: it is the materialized record of what the run did, ordered chronologically, with each operation carrying its own lifecycle. A backend adapter that turns raw executor `LogEvent`s into an `InteractionModel` is the single place that knows the executor's event vocabulary — that adapter is the future backend half of this design and is not built yet; the views iterate today against hand-authored model fixtures.

```ts
interface Participant {
	id: string                // instance-scoped, unique per invocation — the flow-view node key
	role: string              // role/tool name; 'human' or 'interrupt' for the pseudo-roles; the sequence-view column key
	kind: 'human' | 'interrupt' | 'role' | 'tool'
}

interface Operation {
	id: string
	kind: 'call' | 'return' | 'observe' | 'terminate'
	stack: string             // call-stack id; the active stack is the one containing the latest operation
	source: string            // participant id; for observe/terminate this may sit in a different (active) stack than destination
	destination: string       // participant id; never equals source for call/return
	startedAt: string
	settledAt: string | null  // null while in_flight; equals startedAt for observe and terminate (both instantaneous)
	lifecycle: 'in_flight' | 'settled'
	outcome: 'success' | 'error' | 'terminated' | null   // returns only; observe and terminate are always null
	details: string | null    // adapter-formatted markdown body for tooltip/detail surfaces (data, not localization)
	metrics: OperationMetrics | null
}

interface InteractionModel {
	participants: Participant[]   // chronological first-appearance order
	operations: Operation[]       // chronological; the index is the sequence-view row
	status: RunStatus
}
```

The model carries no display prose — only `role`/`kind` identifiers, counters, costs, timestamps, and a run `status`. Localization is a view concern (see "Labels" below). The one piece of per-call runtime content is each operation's `details` markdown field, which the adapter formats and which reaches the DOM only through the sanitized Markdown pipeline.

### Operation kinds

- **`call`** / **`return`** hand off activity between participants. A `call` is `in_flight` from the moment it starts until the callee delegates (a nested `call` lands on the same stack) or its matching `return` lands; a `return` is `in_flight` while its response leg is traveling. The outcome (`success`/`error`/`terminated`) lives on the `return` only — a view that needs a call's eventual outcome pairs the call with its closing return rather than reading a duplicated field.
- **`observe`** is a read-only cross-stack reference: a tool in the active stack reads a participant in a paused stack. It is instantaneous (`settledAt === startedAt`), never affects activity, never enters a call chain, and never animates. The sequence view draws it as a static dashed line with no arrowhead and no terminal node.
- **`terminate`** is a destructive close: a rewind tool in the active stack reverts a target node in a paused stack. Like `observe` it is instantaneous and spans stacks, but unlike `observe` it closes the targeted call (pops it from the open chain), so the node is removed immediately and no separate `terminated` return is needed for that call. It never hands off activity, so the active operation stays the interrupt's own call rather than the terminate.

## The single invariant both views read

> The active stack is the stack of the latest operation. The active participant is the destination of the latest `call`/`return` in the active stack. `observe` and `terminate` never affect activity. A line animates iff it is `in_flight` **and** its stack is the active stack. Every other stack with open calls is *paused*; its lines are static and its participants are not active.

This is the whole rule. Both views read it off the same helpers (`activeStack`, `activeOperation`, `activeParticipant`, `isPaused` in `interaction-model.js`), so a change to the rule changes both views at once and they cannot drift. The model never flips `lifecycle` on pause — a paused stack's `in_flight` operation stays genuinely `in_flight`; the view freezes its animation, the model does not settle it.

## Interrupts

An interrupt spawns a **new call stack** rooted at a fresh `Interrupt` pseudo-participant instance (instance-per-interrupt, like every role). The stack begins with a `call` from the Interrupt instance to the role that handles the interrupt (typically a loop detector).

- **Occur at any time, including mid-flight.** A paused stack may carry an `in_flight` operation; the view freezes its animation while the model keeps its `lifecycle` as `in_flight`.
- **Unbounded and nest.** An interrupt can interrupt an interrupt. Each gets a unique `stack` id; the active stack is the latest; fates cascade when stacks resolve inward.
- **The flow view renders each non-terminated stack as a row**: the main run (rooted at the human) at the top, each preempting interrupt stack (rooted at an Interrupt instance) below it, active stack at the bottom. `observe` and `terminate` lines cross from the active stack up into a paused row.
- **A paused stack's fate is read off its own operations after the preemption point, not stored as a field** (`fateOf`): **resume** (the next op lands back on the old stack id), **rewind** (a run of `terminated` returns followed by a fresh `call` from an ancestor — backing out a leg and restarting it), or **terminate** (`terminated` returns all the way to the root). A stack with no open calls left is **terminated**; the active stack is **active**.
- **The `interrupt` column/root appears only on first use.** A normal run with no interrupts is not cluttered with an interrupt lifeline. `human` is always present — every run starts with a human-submitted task.

## Labels

Labels are **localization**, and the localization data lives in the **Guild** so a swapped Guild re-flavors the views without a frontend change. The model carries no prose; the resolver (`source/web/static/labels.js`, a `createLabelResolver(config)` factory) reads three data sources the frontend already loads via `GET /api/config`:

- **Real role labels** — `role.label` on each role definition; `role.workingLabel` carries the active/working-state text (with a `{participant}` placeholder) used when a settled call's destination is doing its own work.
- **Real tool labels** — `tool.humanLabel` on each tool manifest; `tool.humanCallLabel` is a per-tool call-operation template (with `{source}` and optionally `{destination}`) that overrides the generic `role->tool` / `interrupt->tool` operation template; `tool.humanWorkingLabel` is the per-tool working-state text (optionally with `{participant}`) that overrides the generic tool working template.
- **The `visualization` section** (`guild.json`) — `pseudoRoleLabels` for the `human`/`interrupt`/`tools` pseudo-roles the views invent, `operationTemplates` and `genericOperationTemplates` keyed by operation kind and a `sourceKind->destinationKind` discriminator, and `workingTemplates` (generic per-participant-kind fallback for the working state when a role/tool has no per-entry `workingLabel`/`humanWorkingLabel`).

Three tiers serve different audiences:

- **whimsical** — fanciful and reality-disconnected, used to show lively progress rather than report state. Whimsical wins strongly over precise.
- **friendly** — informative and mildly accurate for non-technical users.
- **detailed** — extremely precise for technical users.

Operation labels are templated entries that interpolate the source and destination participant labels (resolved at the same tier). A UI **tier toggle** swaps which tier the views render without touching the model — like locale switching. The fallback chain walks `detailed → friendly → whimsical` (then the title-cased role name), so a guild author who omits a tier still gets a readable line. The `details` markdown field on each operation is the rich per-call runtime content (arguments/results/summaries); that is data, not localization, so it lives on the model and the adapter formats it.

The "now" caption distinguishes a call's two phases: the **transit** phase (the line animates, `lifecycle === 'in_flight'`) reads the operation label ("A is calling B…"); the **working** phase (the line goes solid, `lifecycle === 'settled'` — the destination has started producing) switches to the destination's **working label** ("B is planning…" / "Receiving tokens from B"). The working label is per-role (`role.workingLabel`, a `{participant}` template interpolated with the role's own label at the chosen tier); a role without one falls back to `visualization.workingTemplates[kind]` (generic per participant kind); a guild without either falls back to the operation label, so a minimal guild keeps the prior behavior.

## The two views

Both views are **independent leaves** over the `InteractionModel`: each imports `interaction-model.js` and the SVG primitives, and neither imports the other. They share the single invariant but project it differently.

- **Flow view** (`source/web/static/flow-view.js`) — projects the model to a stack-of-rows layout. Each row lays its open call chain left-to-right by call depth, with the stack's root participant (`You` or an Interrupt instance) at the leftmost column. A return whose source has departed the open chain lingers as a node plus a return edge until the caller's next action. A top-bar strip aggregates every role/tool type that has ever run, with invocation counts and cumulative metrics. Node enter/depart lifecycle is computed by diffing two consecutive model frames (`deriveLifecycle`); a departing node travels from its previous row position to its top-bar slot in the shared SVG coordinate space. The "now" caption (`deriveNowCaption`) and ambient cost strip (`deriveCostStrip`) are pure derivations over the same model frame.
- **Sequence view** (`source/web/static/sequence-diagram.js`) — projects the model to a UML-style lifeline diagram: one column per guild role plus a shared `tools` column, one row per operation in chronological order. Routing is a pure function of the source and destination columns: distinct columns render a straight arrow; the same column (a same-role cross-instance call) renders a loopback U-turn. The inspector (the shared `tooltip.js` card) opens on hover/click and renders an operation's `details` through the sanitized Markdown pipeline.

Animation is layered on top of the settled structure via CSS class hooks the model carries no animation state for. The single invariant governs every motion class: a call/return edge animates iff it is `in_flight` and its stack is the active stack; paused stacks' lines are frozen solid; `observe` and `terminate` never animate. The active participant's node pulses; participants in paused stacks do not.

## Dev harness

The dev iteration surface is `source/web/static/demo.html` + `demo.js`, which cycle through hand-authored `InteractionModel` frame sequences in `source/web/static/scenarios.js`. Each scenario is authored as a story (operation specs: who called whom, who returned what) and a frame builder derives lifecycle, `settledAt`, and transit/working frame pairs from that story — so the fixtures exercise the model's rules rather than hand-tuning them. The scenarios cover single-role completion, delegation chains, instance-per-invocation retries, deep call trees, pending questions (`ask_human`), detected-loop interrupts, nested interrupts (two and three stacks coexisting), and the three interrupt fates (resume / rewind / terminate). The harness exposes a scenario select, frame scrubber, play/pause, theme toggle, and the label-tier toggle.

## Backend adapter (future)

The `InteractionModel` is designed to be the contract a future backend adapter produces from the executor's `LogEvent` stream — the successor to the original server-side flow-model derivation. That adapter is the single place that knows the executor's event vocabulary; once it exists, the product UI wires these view modules to live data. Until then the views iterate against the hand-authored fixtures in the dev harness.
