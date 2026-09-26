# Run visualization

The web client renders an in-progress or completed run two ways: a **flow view** (the product surface — a stack-of-rows call graph) and a **sequence view** (the temporal debug surface — a UML-style lifeline diagram). Both read a single shared model, the `InteractionModel`, and neither borrows state from the other. This document captures the design of that model and the two views; the rendering security invariant is covered in [`docs/security.md`](security.md) "Web client rendering pipeline".

## Why a shared model

A run visualization needs to answer one question everywhere: *what is happening right now?* — which call is in flight, which participant is active, which line should animate. Two views that answer the question independently drift: every agreement between them must be forced with a special case, and each special case is tuned to a particular frame rather than being a rule. One shared derivation removes the drift.

The design is structural, not procedural: **one model answers the question once, and both views read that answer.** Every "what is happening right now" question is a pure helper over the model's operation list. The views never re-derive activity, so they cannot disagree.

## The model

The `InteractionModel` (`source/web/static/interaction-model.js`) is a **timeline of operations** over a set of participants, plus a run status. It is neither a current-state graph nor an event stream: it is the materialized record of what the run did, ordered chronologically, with each operation carrying its own lifecycle. A backend adapter (`source/web/interaction-model-adapter.ts`, served at `GET /api/runs/:id/flow`) turns raw executor `LogEvent`s into an `InteractionModel` and is the single place that knows the executor's event vocabulary; the product views read live data through it, and the dev harness iterates against fixtures fed through the same adapter (see "Backend adapter" below).

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
	metrics: OperationMetrics | null
}

interface InteractionModel {
	participants: Participant[]   // chronological first-appearance order
	operations: Operation[]       // chronological; the index is the sequence-view row
	status: RunStatus
	stacks?: StackRecord[]        // stack roots in push order (oldest first); emitted by producers that track stack pushes
}

interface StackRecord {
	id: string
	root: string                  // the stack's root participant id (the You root, an Interrupt instance, or an inquiry's human asker)
}
```

A freshly preempted stack (an interrupt has landed but its first call has not) carries no operations yet, so operations alone cannot name it; the optional `stacks` records carry every pushed stack's id and root so the views can show the fresh stack and its root before its first operation lands. When `stacks` is absent (hand-authored models), the helpers derive stack structure from operations and a zero-operation stack renders nothing.

The model carries no display prose — only `role`/`kind` identifiers, counters, costs, timestamps, and a run `status`. Localization is a view concern (see "Labels" below). It also carries no per-call detail bodies: an operation's detail markdown (task text, tool arguments/results, summaries) is fetched on demand from the run's flow endpoint (`GET /api/runs/:id/flow?operation=<id>`; see [`docs/reference.md`](reference.md)) when the inspector opens, because those bodies can be large and would otherwise ride every polled frame. The fetched markdown reaches the DOM only through the sanitized Markdown pipeline.

### Operation kinds

- **`call`** / **`return`** hand off activity between participants. A `call` is `in_flight` from the moment it starts until the callee delegates (a nested `call` lands on the same stack) or its matching `return` lands; a `return` is `in_flight` while its response leg is traveling. The outcome (`success`/`error`/`terminated`) lives on the `return` only — a view that needs a call's eventual outcome pairs the call with its closing return rather than reading a duplicated field.
- **`observe`** is a read-only cross-stack reference: a tool in the active stack reads a participant in a paused stack. It is instantaneous (`settledAt === startedAt`), never affects activity, never enters a call chain, and never animates. The sequence view draws it as a static dashed line with no arrowhead and no terminal node.
- **`terminate`** is a destructive close: a rewind tool in the active stack reverts a target node in a paused stack. Like `observe` it is instantaneous and spans stacks, but unlike `observe` it closes the targeted call (pops it from the open chain), so the node is removed immediately and no separate `terminated` return is needed for that call. It never hands off activity, so the active operation stays the interrupt's own call rather than the terminate.

## The single invariant both views read

> The active stack is the stack of the latest operation, with two refinements: a freshly preempted stack (pushed by an interrupt, carrying no operations yet — the preemption itself is the latest activity) is active on arrival, and a *resolved* stack (its root call has returned) yields activity to the innermost stack still carrying open work, staying active only when no stack carries open work. The active participant is the destination of the active stack's current focus: an in-flight return's destination while its response leg travels, else the innermost open call's destination, else the stack's root when the stack has no operations yet. `observe` and `terminate` never affect activity. A line animates iff it is `in_flight` **and** its stack is the active stack. Every other stack with open calls is *paused*; its lines are static and its participants are not active.

This is the whole rule. Both views read it off the same helpers (`activeStack`, `activeOperation`, `activeParticipant`, `isPaused` in `interaction-model.js`), so a change to the rule changes both views at once and they cannot drift. The model never flips `lifecycle` on pause — a paused stack's `in_flight` operation stays genuinely `in_flight`; the view freezes its animation, the model does not settle it.

## Interrupts

An interrupt spawns a **new call stack** rooted at a fresh `Interrupt` pseudo-participant instance (instance-per-interrupt, like every role) — with one exception: an operator inquiry roots its stack at a fresh human-asker participant (instance-per-invocation, like the `ask_human` answerer), because the person asking is that stack's caller. The stack begins with a `call` from the stack's root to the role that handles the interrupt (a loop detector, context manager, or inquiry responder); for an inquiry the call's on-demand details carry the operator's question.

- **Occur at any time, including mid-flight.** A paused stack may carry an `in_flight` operation; the view freezes its animation while the model keeps its `lifecycle` as `in_flight`.
- **Unbounded and nest.** An interrupt can interrupt an interrupt. Each gets a unique `stack` id; activity follows the single invariant above (a fresh preemption is active on arrival; a resolved stack yields to the innermost stack with open work), and fates cascade when stacks resolve inward.
- **The flow view renders each non-terminated stack as a row**: the main run (rooted at the human) is always the top row, and each preempting interrupt stack (rooted at an Interrupt instance, or at the human asker for an inquiry) sits below it in preemption order. Rows never reorder as activity moves — the active stack is conveyed by the pulsing node and marching lines, not by row position. `observe` and `terminate` lines cross from the active stack up into a paused row.
- **The executor emits the `observe` operations.** A handler's read-only cross-role inspection tool logs an `observe` event between its `tool_call` and `tool_result` when it successfully reads a suspended instance, and the adapter draws it as a cross-row dashed line into the paused row (`terminate` remains a fixture-only kind — no executor tool emits it).
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

Operation labels are templated entries that interpolate the source and destination participant labels (resolved at the same tier). A UI **tier toggle** swaps which tier the views render without touching the model — like locale switching. The fallback chain walks `detailed → friendly → whimsical` (then the title-cased role name), so a guild author who omits a tier still gets a readable line. The per-operation detail markdown (arguments/results/summaries) is not model data at all: it is fetched on demand by the inspector (see "The model" above), so localization never touches it.

The "now" caption distinguishes a call's two phases: the **transit** phase (the line animates, `lifecycle === 'in_flight'`) reads the operation label ("A is calling B…"); the **working** phase (the line goes solid, `lifecycle === 'settled'` — the destination has started producing) switches to the destination's **working label** ("B is planning…" / "Receiving tokens from B"). The working label is per-role (`role.workingLabel`, a `{participant}` template interpolated with the role's own label at the chosen tier); a role without one falls back to `visualization.workingTemplates[kind]` (generic per participant kind); a guild without either falls back to the operation label.

## The two views

Both views are **independent leaves** over the `InteractionModel`: each imports `interaction-model.js` and the SVG primitives, and neither imports the other. They share the single invariant but project it differently.

- **Flow view** (`source/web/static/flow-view.js`) — projects the model to a stack-of-rows layout. Each row lays its open call chain left-to-right by call depth, with the stack's root participant (`You`, an Interrupt instance, or a human asker) at the leftmost column. A return whose source has departed the open chain lingers as a node plus a return edge until the caller's next action. A top-bar strip aggregates every role/tool type that has ever run, with invocation counts and cumulative metrics. Node enter/depart lifecycle is computed by diffing two consecutive model frames (`deriveLifecycle`); a departing node travels from its previous row position to its top-bar slot in the shared SVG coordinate space. The "now" caption (`deriveNowCaption`) and ambient cost strip (`deriveCostStrip`) are pure derivations over the same model frame.
- **Sequence view** (`source/web/static/sequence-diagram.js`) — projects the model to a UML-style lifeline diagram: one column per guild role plus a shared `tools` column, one row per operation in chronological order. Routing is a pure function of the source and destination columns: distinct columns render a straight arrow; the same column (a same-role cross-instance call) renders a loopback U-turn. The inspector (the shared `tooltip.js` card) opens on hover/click and renders an operation's on-demand details through the sanitized Markdown pipeline.

Animation is layered on top of the settled structure via CSS class hooks the model carries no animation state for. The single invariant governs every motion class: a call/return edge animates iff it is `in_flight` and its stack is not paused — the active stack is never paused, and a resolved stack (its chain is empty) is not paused either, so a resolved stack's final return leg keeps marching in its outcome color while it travels; paused stacks' lines are frozen solid; `observe` and `terminate` never animate. The active participant's node pulses; participants in paused stacks do not.

## Dev harness

The dev iteration surface is `source/web/static/demo.html` + `demo.js`, which fetch frames derived server-side from event-stream fixtures (`source/web/demo-fixtures.ts`) fed through the real adapter — the same `LogEvent` → `InteractionModel` derivation `GET /api/runs/:id/flow` runs — so the harness exercises the product's data path rather than hand-authored model frames. The scenarios cover single-role completion, delegation chains, instance-per-invocation retries, deep call trees, pending questions (`ask_human`), an operator inquiry answered on a preempting human-asker stack, detected-loop interrupts, nested interrupts (two and three stacks coexisting), and the three interrupt fates (resume / rewind / terminate). (The hand-authored model-frame scenarios in `source/web/static/scenarios.js` remain as the in-memory test bed the view-module unit tests render.) The harness exposes a scenario select, frame scrubber, play/pause, theme toggle, and the label-tier toggle. What the harness may own, what it must inherit by import, and the manual drift check that holds it to that line are fixed in "The demo page is a fixture transport, not a sandbox" below.

## The demo page is a fixture transport, not a sandbox

The demo page exists to exercise the **production UI components** against recorded scenario frames — it is the transport that feeds fixtures into the real components, not a sandbox with its own copy of them. Everything a viewer sees or interacts with comes from the shared static modules the run view uses: the view modules and the model helpers they read (`flow-view.js`, `sequence-diagram.js`, `interaction-model.js`), the label resolver (`labels.js`), the sanitized Markdown pipeline (`markdown-render.js` over `markdown.js`), the inspector derivations and tooltip machinery (`inspector.js`, `tooltip.js`), the operation-details controller (`operation-details.js`), the modal components (`question-modal.js`, `result-modal.js`), and the shared clipboard leaf (`clipboard.js`), with the SVG primitives (`svg-primitives.js`) beneath them. A behavior the demo shows wrong is therefore a bug in a shared module or in `app.js`, and the fix belongs there — never patched around in `demo.js`.

What `demo.js` may own is the harness around those components:

- **Playback chrome** — the scenario select, frame scrubber, play/pause, jump-to-active, and the view/theme/label-tier toggles.
- **The fixture transport** — fetching `/api/demo/scenarios` and the `/api/demo/flow/:scenario/:frame` frames the adapter derives server-side (see "Backend adapter" below).
- **Container DOM construction** — the containers the shared components mount into, and the DOM-producing `h` factories that stand in for the product client's hyperapp renderer.
- **Fixture-specific descriptor synthesis** — demo frames carry no real result fields, so `deriveDemoResultDescriptor` synthesizes the terminal-result descriptor from the frame's status rather than inventing scenario-specific prose.
- **The debug text view** — the model's raw projection behind its toggle, the one surface the product client has no counterpart for.
- **Sequence-container scroll handling** — the deliberate app-only/demo-only split: the live view follows new content with `scroll-follow.js` because only live polling grows content between user actions, while the harness's scroll handling (jump-to-active, preserving `scrollTop` across a frame rebuild) belongs to its playback chrome because frames are navigated, not streamed.

What it must never do is reimplement shell behavior the shared modules already carry — the tooltip machinery (`tooltip.js`, `inspector.js`), the operation-details caching (`operation-details.js`), the modal components (`question-modal.js`, `result-modal.js`). When shell behavior changes in `app.js` and the shared modules, the demo inherits the change by importing, not by copying: a copy renders correctly the day it is made and drifts silently at the next shell change.

### Reviewer checklist for demo drift

No automated check guards this contract, and that is a considered decision: a mechanical drift check would be hole-prone — an import graph cannot tell a faithful import from a divergent re-derivation one inline callback away, and a rendered-output diff pins only what a snapshot thought to pin. The check is manual and is part of reviewing any change that touches `app.js` or a shared static module:

1. Check `demo.js` imports the touched behavior rather than reimplementing it.
2. Render a demo frame side-by-side with a live run view and compare.
3. Confirm new shell features ship to both shells or are explicitly demo/app-only with a reason (the scroll split above is the current example of the latter).

## Backend adapter

The backend adapter (`source/web/interaction-model-adapter.ts`) produces the `InteractionModel` from the executor's `LogEvent` stream and is the single place that knows the executor's event vocabulary. The product UI reads it live at `GET /api/runs/:id/flow` (and the `/api/run/flow` alias); the dev harness iterates against the same derivation by feeding fixture event streams through it (`GET /api/demo/flow/:scenario/:frame`). The view modules never parse log events themselves, so a change to the executor's event vocabulary lands in exactly one place.
