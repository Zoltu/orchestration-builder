// Flow-graph view renderer over an InteractionModel.
//
// The view projects the model to a stack-of-rows layout: one row per
// non-terminated call stack (stacksOf), oldest at the top and the active stack
// at the bottom. Each row lays its open call chain (callChainOf) left-to-right
// by call depth, with the stack's root participant (the You root or an Interrupt
// instance) at the leftmost column. A return whose source has departed the open
// chain lingers as a node plus a return edge back to its caller until the
// caller's next action — read straight off the operation list, never from a
// stored lingering flag. observe operations cross from the active stack up into
// a paused row as static dashed lines; terminate operations cross the same way
// as static red dashed lines, with an orange dashed border on the target. A
// top-bar strip aggregates every role/tool type that has ever run, with
// invocation counts and cumulative metrics drawn from the participants and
// their completing returns.
//
// Animation is layered on top of the settled structure via class hooks the
// existing CSS keyframes drive; the model carries no animation state. The
// single invariant governs every motion class: a call/return edge animates iff
// it is in_flight and its stack is the active stack — paused stacks' lines are
// frozen solid, and observe and terminate never animate. A call edge in the
// active stack carries 'flowing' only while its lifecycle is in_flight
// (settling to a solid static stroke once the callee delegates or returns); a
// lingering return edge in the active stack carries 'returning' (or 'error'
// on a failed outcome), because a return edge exists only while it is the
// current response leg in flight. The active participant (the destination of
// the latest non-observe, non-terminate operation in the active stack, via
// activeParticipant) pulses; participants in paused stacks do not.
//
// Frame-to-frame node lifecycle (entering/departing) is computed by
// deriveLifecycle from two consecutive InteractionModel frames: entering
// participants scale/fade in; a departing participant travels from its previous
// row position to its role's top-bar slot, both in the shared SVG coordinate
// space so the travel lands on the slot and reads as the counter incrementing.
// The travel/shrink/fade keyframes are the existing flow-node-* rules; only the
// from/to coordinates are passed in.
//
// The terminal-result CTA is a view concern layered on model.status, not model
// state: when the run reaches a terminal status the view renders a CTA node
// whose tone follows the status and whose active/modal state is harness-managed.
//
// `h` is passed in rather than imported so the module stays free of hyperapp
// coupling and the vnode shape is exercisable in tests with a fake `h`,
// mirroring the existing SVG primitive convention. The label resolver is passed
// in (rather than imported) alongside the selected tier so a caller can swap the
// resolver or tier without the view reaching for globals; node prose is
// localization, a view concern, and the model carries no prose. The module is
// plain browser JS, imports only its siblings, and touches no external system.

import { activeOperation, activeParticipant, activeStack, callChainOf, observesOf, stacksOf, terminatesOf } from './interaction-model.js'
import { GraphEdge, GraphNode, NODE_HEIGHT, NODE_WIDTH, nodeAnchor } from './svg-primitives.js'

// Horizontal gap between call-depth columns and vertical gap between rows. Generous horizontal spacing keeps the left-to-right call chain legible; the vertical gap separates the main run from each preempting interrupt stack.
export const COL_GAP = 96
const ROW_GAP = 104

// Top-bar small-node dimensions and wrapping. Each history slot is a small square holding just its invocation count; the role/tool name and cumulative token/time details surface via the native SVG <title> hover so a long run's history stays a compact strip. They wrap into rows so a large guild's many role/tool types never overflow horizontally.
const SMALL_SIZE = 28
const SMALL_GAP = 8
const TOP_BAR_PER_ROW = 14

// The minimum column count the flow view reserves horizontally. A run with a single active role still consumes this many columns of width so the centerpiece does not snap narrow on a one-column frame and then snap wide as delegation deepens; the high-water mark below only grows past it.
const DEFAULT_MIN_COLUMNS = 5

// Session-level high-water mark of the column count the flow view has rendered. A frame whose call chain is shallower than a previous frame still sizes to this width so nodes do not slide leftward when a deep delegation unwinds — a stable stage reads better than one that resizes per frame. It grows when a deeper frame appears and never shrinks back, persisting across frame navigation and scenario switches for the page-load lifetime (a fresh page load resets it because the module re-evaluates).
let columnHighWaterMark = DEFAULT_MIN_COLUMNS

// Vertical gap between the history top bar and the row stack. The two live in one shared SVG coordinate space so a node leaving a row for its top-bar slot travels in the same space (the counter increment is the point of the depart animation).
const TOPBAR_GAP = 24

function translate(x, y) {
	return `translate(${x},${y})`
}

function rowPixel(column, rowIndex, yOffset) {
	return { x: column * (NODE_WIDTH + COL_GAP), y: rowIndex * (NODE_HEIGHT + ROW_GAP) + yOffset }
}

function topBarPixel(index) {
	const row = Math.floor(index / TOP_BAR_PER_ROW)
	const col = index % TOP_BAR_PER_ROW
	return { x: col * (SMALL_SIZE + SMALL_GAP), y: row * (SMALL_SIZE + SMALL_GAP) }
}

function topBarWidth(count) {
	if (count === 0) return 0
	const cols = Math.min(count, TOP_BAR_PER_ROW)
	return cols * SMALL_SIZE + (cols - 1) * SMALL_GAP
}

function topBarHeight(count) {
	if (count === 0) return 0
	const rows = Math.ceil(count / TOP_BAR_PER_ROW)
	return rows * SMALL_SIZE + (rows - 1) * SMALL_GAP
}

// The motion state a call/return edge carries under the single invariant: a line animates iff it is in_flight and its stack is the active stack. A call animates 'flowing' only while its lifecycle is in_flight (the transit phase); once it settles (the working phase, or delegation, or its return) it goes solid. A return edge exists only while it is the lingering response leg, so it animates 'returning' (or 'error'/'terminated' for the matching outcome) only while in_flight (its transit phase) and goes solid once settled (its working phase). Any edge whose stack is not the active stack is frozen 'static', and observe and terminate never reach here (both render their own static dashed lines).
function edgeAnimationState(operation, model) {
	if (operation.kind === 'observe' || operation.kind === 'terminate') return 'static'
	if (operation.stack !== activeStack(model)) return 'static'
	if (operation.lifecycle === 'settled') return 'static'
	if (operation.kind === 'call') return 'flowing'
	if (operation.outcome === 'error') return 'error'
	if (operation.outcome === 'terminated') return 'terminated'
	return 'returning'
}

// Projects a single stack to a row descriptor: the root participant, the participants to render (each at its call-depth column, flagged when it is a lingering return source), and the call and lingering-return edges between them. The open call chain gives the live participants and columns; a return lingers only while it is in_flight (its transit phase) — once it settles (the working phase) the returner has departed and neither the node nor its response edge is drawn, so the lingering leg never renders for a settled return even when it is the stack's last call-or-return. A stack whose open chain is empty but whose latest non-observe operation is an in_flight return still renders a row holding that single lingering leg (the terminal return's transit frame), with the return's caller as the row root; this is what lets the terminal frame show the returner and its response line until the See Result click settles the return. observe is skipped when finding that last call-or-return because an observe never affects activity and never enters a call chain, so it cannot be the caller's action that ends a lingering leg. Each edge carries the operation it renders so the animation layer can read its lifecycle and outcome directly.
function projectRow(model, stackId) {
	const chain = callChainOf(model, stackId)
	const operationsOnStack = model.operations.filter((operation) => operation.stack === stackId)

	let lastCallOrReturn = undefined
	for (let index = operationsOnStack.length - 1; index >= 0; index -= 1) {
		const operation = operationsOnStack[index]
		if (operation.kind === 'observe' || operation.kind === 'terminate') continue
		lastCallOrReturn = operation
		break
	}
	const lingeringReturn = lastCallOrReturn !== undefined && lastCallOrReturn.kind === 'return' && lastCallOrReturn.lifecycle === 'in_flight'
		? lastCallOrReturn
		: undefined

	// No open calls and no in_flight return leg to linger: the stack has nothing to render.
	if (chain.length === 0 && lingeringReturn === undefined) return null

	// The row root is the open chain's first call source, or — when the chain is empty — the lingering return's caller (its destination), who is the stack's effective root while the last return leg is still in flight.
	const rootId = chain.length > 0 ? chain[0].source : lingeringReturn.destination

	const columnByParticipant = new Map()
	columnByParticipant.set(rootId, 0)
	const participants = [{ id: rootId, column: 0, lingering: false }]
	const callEdges = []
	for (let index = 0; index < chain.length; index += 1) {
		const call = chain[index]
		if (call === undefined) continue
		const sourceColumn = columnByParticipant.get(call.source) ?? index
		const destinationColumn = index + 1
		columnByParticipant.set(call.destination, destinationColumn)
		participants.push({ id: call.destination, column: destinationColumn, lingering: false })
		callEdges.push({ fromColumn: sourceColumn, toColumn: destinationColumn, operation: call })
	}

	const closedCallByReturn = new Map()
	const open = []
	for (const operation of operationsOnStack) {
		if (operation.kind === 'call') {
			open.push(operation)
		} else if (operation.kind === 'return') {
			const closed = open.pop()
			if (closed !== undefined) closedCallByReturn.set(operation.id, closed)
		}
	}

	const returnEdges = []
	if (lingeringReturn !== undefined) {
		const closedCall = closedCallByReturn.get(lingeringReturn.id)
		if (closedCall !== undefined) {
			// The lingering leg renders only while the return is in transit (in_flight); once the return settles (working phase) the returner has departed and neither the node nor its response edge is drawn. The lingering source sat one column past the open chain's innermost node: it was the innermost call before its return popped it, so its depth is the current open chain length plus one.
			const lingeringColumn = chain.length + 1
			const callerColumn = columnByParticipant.get(lingeringReturn.destination) ?? 0
			participants.push({ id: closedCall.destination, column: lingeringColumn, lingering: true })
			returnEdges.push({ fromColumn: lingeringColumn, toColumn: callerColumn, operation: lingeringReturn })
		}
	}

	return { stackId, rootId, participants, callEdges, returnEdges }
}

// Aggregates every role/tool type that has ever appeared in the model into one top-bar slot, with the total invocation count (every participant instance of that role, current and departed, so the count matches the "ever run" rule) and the cumulative metrics drawn from the returns whose source is a participant of that role. Departed participants are represented here regardless of whether they currently linger in a row; the depart animation reconciles a lingering node with its slot in the animation layer.
function projectTopBar(model) {
	const slotByRole = new Map()
	for (const participant of model.participants) {
		// The human is the eternal root of every run, never a role that "ran", so it never occupies a top-bar slot.
		if (participant.kind === 'human') continue
		let slot = slotByRole.get(participant.role)
		if (slot === undefined) {
			slot = { role: participant.role, kind: participant.kind, invocations: 0, totalTime: 0, totalTokens: 0, hasMetrics: false, errored: false }
			slotByRole.set(participant.role, slot)
		}
		slot.invocations += 1
	}
	const returnBySource = new Map()
	for (const operation of model.operations) {
		if (operation.kind !== 'return') continue
		returnBySource.set(operation.source, operation)
	}
	for (const participant of model.participants) {
		const slot = slotByRole.get(participant.role)
		if (slot === undefined) continue
		const completion = returnBySource.get(participant.id)
		if (completion === undefined || completion.metrics === null) continue
		const metrics = completion.metrics
		if (metrics.elapsedSeconds !== null) {
			slot.totalTime += metrics.elapsedSeconds
			slot.hasMetrics = true
		}
		if (metrics.tokens !== null) {
			slot.totalTokens += metrics.tokens
			slot.hasMetrics = true
		}
		if (completion.outcome === 'error') slot.errored = true
	}
	return Array.from(slotByRole.values())
}

// The completion return for a participant (the return whose source is the participant), used to read its cost metrics and outcome. A participant still in flight has no completing return, so it carries no cost.
function completionReturnFor(model, participantId) {
	for (const operation of model.operations) {
		if (operation.kind === 'return' && operation.source === participantId) return operation
	}
	return undefined
}

// Renders a single top-bar slot as a small square holding its invocation count, with a <title> carrying the label, count, and cumulative metrics for hover. A slot whose run ended in failure turns red so the failing role reads at a glance against an otherwise neutral strip.
function renderSmallNode(h, slot, label, index) {
	const pos = topBarPixel(index)
	const classes = ['flow-small-node']
	const runErrored = slot.errored
	if (runErrored) classes.push('flow-small-node--error')
	const titleParts = [label, `${slot.invocations} call${slot.invocations === 1 ? '' : 's'}`]
	if (slot.hasMetrics) {
		if (slot.totalTime > 0) titleParts.push(`${slot.totalTime}s`)
		if (slot.totalTokens > 0) titleParts.push(`${slot.totalTokens.toLocaleString()} tokens`)
	}
	if (runErrored) titleParts.push('errored')
	return h('g', { class: classes.join(' '), transform: translate(pos.x, pos.y), 'data-role': slot.role, 'data-kind': slot.kind }, [
		h('title', {}, [titleParts.join(' \u00b7 ')]),
		h('rect', { class: 'flow-small-node-box', x: 0, y: 0, width: SMALL_SIZE, height: SMALL_SIZE, rx: 5 }, []),
		h('text', { class: 'flow-small-node-count', x: SMALL_SIZE / 2, y: SMALL_SIZE / 2 + 1, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, [String(slot.invocations)]),
	])
}

// Renders one row: edges first (so node boxes paint over anchor overlap), then nodes translated to their call-depth columns. The row group carries the stack id so the structure is discoverable from the DOM and the animation layer can target it. Each call/return edge carries its motion state off the operation it renders and the single invariant; the active participant's node carries the active class so it pulses. A node flagged as a terminate target carries the terminate-target class so the CSS overlays the orange dashed border.
function renderRow(h, row, rowIndex, yOffset, model, labels, tier, participantById, enteringIds, activeParticipantId, terminateTargetIds) {
	const edgeVnodes = []
	for (const callEdge of row.callEdges) {
		const fromPos = rowPixel(callEdge.fromColumn, rowIndex, yOffset)
		const toPos = rowPixel(callEdge.toColumn, rowIndex, yOffset)
		const fromAnchor = nodeAnchor(fromPos.x, fromPos.y, 'right')
		const toAnchor = nodeAnchor(toPos.x, toPos.y, 'left')
		edgeVnodes.push(h('g', { class: 'flow-edge flow-edge--call', 'data-stack': row.stackId, 'data-kind': 'call', 'data-operation': callEdge.operation.id }, [
			GraphEdge(h, { fromAnchor, toAnchor, kind: 'call', state: edgeAnimationState(callEdge.operation, model) }),
		]))
	}
	for (const returnEdge of row.returnEdges) {
		const fromPos = rowPixel(returnEdge.fromColumn, rowIndex, yOffset)
		const toPos = rowPixel(returnEdge.toColumn, rowIndex, yOffset)
		const fromAnchor = nodeAnchor(fromPos.x, fromPos.y, 'bottom')
		const toAnchor = nodeAnchor(toPos.x, toPos.y, 'bottom')
		edgeVnodes.push(h('g', { class: 'flow-edge flow-edge--return', 'data-stack': row.stackId, 'data-kind': 'return', 'data-operation': returnEdge.operation.id }, [
			GraphEdge(h, { fromAnchor, toAnchor, kind: 'return', state: edgeAnimationState(returnEdge.operation, model) }),
		]))
	}

	const nodeVnodes = row.participants.map((entry) => {
		const participant = participantById.get(entry.id)
		const resolvedLabel = participant !== undefined ? labels.resolveParticipantLabel(participant, tier) : entry.id
		const sublabel = participant !== undefined && participant.kind !== 'human' && participant.kind !== 'interrupt' ? participant.role : undefined
		const completion = completionReturnFor(model, entry.id)
		const metrics = completion !== undefined && completion.metrics !== null ? completion.metrics : null
		const status = completion !== undefined ? completion.outcome : undefined
		const pos = rowPixel(entry.column, rowIndex, yOffset)
		const isTerminateTarget = terminateTargetIds.has(entry.id)
		const inner = GraphNode(h, {
			label: resolvedLabel,
			sublabel,
			status: status === 'success' ? 'success' : status === 'error' ? 'error' : undefined,
			active: entry.id === activeParticipantId,
			costTime: metrics !== null ? metrics.elapsedSeconds : undefined,
			costTokens: metrics !== null ? metrics.tokens : undefined,
		})
		if (enteringIds.has(entry.id)) {
			return h('g', { class: ['flow-node', 'flow-node--entering-host', isTerminateTarget ? 'flow-node--terminate-target' : null].filter((token) => token !== null).join(' '), transform: translate(pos.x, pos.y), 'data-participant': entry.id, 'data-role': participant !== undefined ? participant.role : '', 'data-kind': participant !== undefined ? participant.kind : '', 'data-lingering': entry.lingering ? 'true' : 'false' }, [
				h('g', { class: 'flow-node--entering' }, [inner]),
			])
		}
		return h('g', { class: ['flow-node', isTerminateTarget ? 'flow-node--terminate-target' : null].filter((token) => token !== null).join(' '), transform: translate(pos.x, pos.y), 'data-participant': entry.id, 'data-role': participant !== undefined ? participant.role : '', 'data-kind': participant !== undefined ? participant.kind : '', 'data-lingering': entry.lingering ? 'true' : 'false' }, [inner])
	})

	return h('g', { class: 'flow-row', 'data-stack': row.stackId, 'data-row-index': String(rowIndex) }, [...edgeVnodes, ...nodeVnodes])
}

// Renders every observe operation as a static dashed line between its source (in the active stack's row) and its destination (in a paused row), so a cross-stack observation reads as a reference rather than an in-flight call. The line never animates and never enters any call chain.
function renderObserves(h, model, rowLayout) {
	if (rowLayout.size === 0) return []
	const vnodes = []
	for (const observe of observesOf(model)) {
		const sourceLayout = rowLayout.get(observe.source)
		const destinationLayout = rowLayout.get(observe.destination)
		if (sourceLayout === undefined || destinationLayout === undefined) continue
		const fromAnchor = nodeAnchor(sourceLayout.x, sourceLayout.y, 'top')
		const toAnchor = nodeAnchor(destinationLayout.x, destinationLayout.y, 'bottom')
		vnodes.push(h('g', { class: 'flow-edge flow-edge--observe', 'data-kind': 'observe', 'data-source': observe.source, 'data-destination': observe.destination }, [
			GraphEdge(h, { fromAnchor, toAnchor, kind: 'observe' }),
		]))
	}
	return vnodes
}

// Renders every terminate operation as a static red dashed line from the rewind tool (in the active stack's row) to its target (in a paused row), so a cross-stack revert reads as a destructive reference rather than an in-flight call. The line never animates and never enters any call chain; the target's orange dashed border is applied separately by the row renderer via the terminate-target id set. A terminate whose source or destination has departed the rows is skipped, so the line disappears once the tool returns or the reverted target's call closes.
function renderTerminates(h, model, rowLayout) {
	if (rowLayout.size === 0) return []
	const vnodes = []
	for (const terminate of terminatesOf(model)) {
		const sourceLayout = rowLayout.get(terminate.source)
		const destinationLayout = rowLayout.get(terminate.destination)
		if (sourceLayout === undefined || destinationLayout === undefined) continue
		const fromAnchor = nodeAnchor(sourceLayout.x, sourceLayout.y, 'top')
		const toAnchor = nodeAnchor(destinationLayout.x, destinationLayout.y, 'bottom')
		vnodes.push(h('g', { class: 'flow-edge flow-edge--terminate', 'data-kind': 'terminate', 'data-source': terminate.source, 'data-destination': terminate.destination }, [
			GraphEdge(h, { fromAnchor, toAnchor, kind: 'terminate' }),
		]))
	}
	return vnodes
}

// Collects the destination ids of every terminate whose source and destination both still render in the rows, so the row renderer can overlay the orange dashed border on exactly the targets whose red revert line is visible. Tying the border to the line's visibility keeps the two cues in sync: once the tool departs or the target's call closes, neither the line nor the border renders.
function terminateTargetIdsIn(model, rowLayout) {
	const ids = new Set()
	for (const terminate of terminatesOf(model)) {
		if (!rowLayout.has(terminate.source)) continue
		if (!rowLayout.has(terminate.destination)) continue
		ids.add(terminate.destination)
	}
	return ids
}

// Maps every participant that lands in a row to its rendered row index and call-depth column, by replaying the same stacksOf + projectRow projection the renderer uses. deriveLifecycle reads this for both frames so a departing participant's previous position is computed against the same layout the renderer will paint, and entering ids are exactly the participants present in the current rows but absent from the previous rows.
function rowParticipantPositions(model) {
	const positions = new Map()
	let rowIndex = 0
	for (const stackId of stacksOf(model)) {
		const row = projectRow(model, stackId)
		if (row === null) continue
		for (const entry of row.participants) {
			positions.set(entry.id, { rowIndex, column: entry.column })
		}
		rowIndex += 1
	}
	return positions
}

// Maps each role to its top-bar slot index in a model, by replaying projectTopBar. deriveLifecycle uses this to place a departing participant's destination on the current frame's top bar, so the travel lands on the slot the counter increment will read against.
function topBarSlotIndexByRole(model) {
	const indexByRole = new Map()
	projectTopBar(model).forEach((slot, index) => indexByRole.set(slot.role, index))
	return indexByRole
}

function topBarRoleSet(model) {
	return new Set(projectTopBar(model).map((slot) => slot.role))
}

// Looks up a participant by id in a model. Participants never leave the model's participant list (they only leave the rows), so a participant departing the rows of the current frame is still present here and the renderer can read its role/kind/label off the current model.
function participantByIdIn(model, participantId) {
	for (const participant of model.participants) {
		if (participant.id === participantId) return participant
	}
	return undefined
}

/**
 * Diffs two consecutive InteractionModel frames into a node-lifecycle descriptor the renderer animates. `enteringIds` is the set of participant ids present in the current rows but absent from the previous rows; each renders a scale/fade-in. `departing` lists participants present in the previous rows but absent from the current rows, each carrying its previous row/column (so the renderer can place the travel origin) and its top-bar slot destination in the current frame (so the travel lands on the slot), plus `merged` when the role's slot already existed in the previous top bar (the counter increments) versus a fresh slot. Both positions live in the shared SVG coordinate space the renderer paints, so a departing node visibly travels to its slot. A null previousModel (the first frame of a scenario) animates nothing — the graph renders settled rather than every node fading in on each scenario select.
 *
 * @param {InteractionModel | null | undefined} previousModel
 * @param {InteractionModel} currentModel
 * @returns {{ enteringIds: Set<string>, departing: Array<{ participantId: string, previousRowIndex: number, previousColumn: number, slotIndex: number, merged: boolean }> }}
 */
export function deriveLifecycle(previousModel, currentModel) {
	const enteringIds = new Set()
	const departing = []
	if (previousModel === undefined || previousModel === null) {
		return { enteringIds, departing }
	}
	const previousPositions = rowParticipantPositions(previousModel)
	const currentPositions = rowParticipantPositions(currentModel)
	for (const [participantId, currentPos] of currentPositions) {
		if (!previousPositions.has(participantId)) enteringIds.add(participantId)
	}
	const currentSlotIndexByRole = topBarSlotIndexByRole(currentModel)
	const previousTopBarRoles = topBarRoleSet(previousModel)
	for (const [participantId, previousPos] of previousPositions) {
		if (currentPositions.has(participantId)) continue
		const participant = participantByIdIn(currentModel, participantId) ?? participantByIdIn(previousModel, participantId)
		if (participant === undefined) continue
		// The human is the eternal root and never departs to the top bar, so it is skipped even when it leaves the rows on a settling transition; it stays the run's anchor rather than traveling to a slot.
		if (participant.kind === 'human') continue
		const slotIndex = currentSlotIndexByRole.get(participant.role)
		// A participant with no current top-bar slot did not transition to the strip and is not animated; a slot exists for every role that has ever run, so this guards only against a malformed frame.
		if (slotIndex === undefined) continue
		departing.push({
			participantId,
			previousRowIndex: previousPos.rowIndex,
			previousColumn: previousPos.column,
			slotIndex,
			merged: previousTopBarRoles.has(participant.role),
		})
	}
	return { enteringIds, departing }
}

// The terminal-result call-to-action node renders on a terminal frame so the run offers a result affordance. The CTA is a view concern layered on model.status (never model state): the tone follows the status, and the active/modal state plus onclick are harness-managed. A layered "bezel + bevel + face" 3D button reads as pressable at a glance; the active state adds a glowing inner ring and a flowing You→CTA edge so the open-modal connection reads. The gradients are declared inline (stable ids) so the button is self-contained.
function CtaNode(h, props) {
	const label = props.label
	const active = props.active === true
	const tone = props.tone === 'error' ? 'error' : 'accent'
	const x = props.x
	const y = props.y
	const onclick = props.onclick
	const classes = active ? 'flow-node flow-cta flow-cta--active' : 'flow-node flow-cta'
	return h('g', { class: classes, transform: translate(x, y), onclick }, [
		CtaButton(h, { label, active, tone }),
	])
}

function CtaButton(h, props) {
	const label = props.label
	const active = props.active === true
	const tone = props.tone === 'error' ? 'error' : 'accent'
	const bezelId = 'flow-cta-bezel'
	const bevelId = 'flow-cta-bevel'
	const faceId = tone === 'error' ? 'flow-cta-face-error' : 'flow-cta-face-grad'
	const insetBevel = 2
	const insetFace = 5
	const children = [
		h('defs', {}, [
			h('linearGradient', { id: bezelId, x1: '0', y1: '0', x2: '0', y2: '1' }, [
				h('stop', { offset: '0%', 'stop-color': '#e2e2e7' }, []),
				h('stop', { offset: '50%', 'stop-color': '#52606d' }, []),
				h('stop', { offset: '90%', 'stop-color': '#7b8794' }, []),
				h('stop', { offset: '100%', 'stop-color': '#cbd2d9' }, []),
			]),
			h('radialGradient', { id: bevelId, cx: '0.5', cy: '0.38', r: '0.75' }, [
				h('stop', { offset: '0%', 'stop-color': '#f0f0f3' }, []),
				h('stop', { offset: '70%', 'stop-color': '#cbd2d9' }, []),
				h('stop', { offset: '100%', 'stop-color': '#7b8794' }, []),
			]),
			tone === 'error'
				? h('linearGradient', { id: faceId, x1: '0', y1: '0', x2: '0', y2: '1' }, [
					h('stop', { offset: '0%', 'stop-color': '#ff8a8a' }, []),
					h('stop', { offset: '48%', 'stop-color': '#f05050' }, []),
					h('stop', { offset: '52%', 'stop-color': '#cf222e' }, []),
					h('stop', { offset: '100%', 'stop-color': '#a31515' }, []),
				])
				: h('linearGradient', { id: faceId, x1: '0', y1: '0', x2: '0', y2: '1' }, [
					h('stop', { offset: '0%', 'stop-color': '#5aa9ff' }, []),
					h('stop', { offset: '48%', 'stop-color': '#2b7de9' }, []),
					h('stop', { offset: '52%', 'stop-color': '#1f6feb' }, []),
					h('stop', { offset: '100%', 'stop-color': '#155abf' }, []),
				]),
		]),
		h('rect', { class: 'flow-cta-bezel', x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT, rx: 9, fill: `url(#${bezelId})` }, []),
		h('rect', { class: 'flow-cta-bevel', x: insetBevel, y: insetBevel, width: NODE_WIDTH - 2 * insetBevel, height: NODE_HEIGHT - 2 * insetBevel, rx: 7, fill: `url(#${bevelId})` }, []),
		h('rect', { class: 'flow-cta-face', x: insetFace, y: insetFace, width: NODE_WIDTH - 2 * insetFace, height: NODE_HEIGHT - 2 * insetFace, rx: 5, fill: `url(#${faceId})` }, []),
		h('text', { class: 'flow-cta-label', x: NODE_WIDTH / 2, y: NODE_HEIGHT / 2 + 6, 'text-anchor': 'middle' }, [label]),
	]
	if (active) children.push(h('rect', { class: 'flow-cta-active-ring', 'data-tone': tone, x: insetFace, y: insetFace, width: NODE_WIDTH - 2 * insetFace, height: NODE_HEIGHT - 2 * insetFace, rx: 5 }, []))
	return h('g', { class: 'flow-cta-button' }, children)
}

// Maps a terminal run status to the CTA's label and tone. A needs_clarification run is waiting on the human, so it reads as an accent (not an error); a failed run is error-toned; success is accent.
function ctaDescriptorForStatus(status) {
	if (status === 'error') return { label: 'See error', tone: 'error' }
	if (status === 'needs_clarification') return { label: 'Respond', tone: 'accent' }
	return { label: 'See result', tone: 'accent' }
}

function isTerminalStatus(status) {
	return status === 'success' || status === 'error' || status === 'needs_clarification'
}

// The ask_human call, when its question is pending: the active operation is an in_flight call whose destination is a human participant (the answerer). A human never emits an operation that would advance the call to its working phase, so the call stays in transit until the user answers — the same single-transit-frame rule the terminal op follows, but the run is not terminal here. The Question affordance overlays the answerer node for the duration of this frame.
export function activeAskHumanCall(model) {
	const operation = activeOperation(model)
	if (operation === null) return undefined
	if (operation.kind !== 'call' || operation.lifecycle !== 'in_flight') return undefined
	const destination = model.participants.find((participant) => participant.id === operation.destination)
	if (destination === undefined || destination.kind !== 'human') return undefined
	return operation
}

// The "Question for Human" overlay button, rendered on the answerer node while the ask_human call is pending. Mirrors the terminal CTA — a standalone overlay button with no connecting edge, so it reads as an affordance rather than a graph node — but sits on the answerer (downstream of the asker) instead of the root. The label splits across three lines ("Question" / "for" / "Human") via stacked <tspan> elements so the three-word affordance reads at a glance within the node box.
function QuestionButton(h, props) {
	const x = props.x
	const y = props.y
	const onclick = props.onclick
	const centerX = NODE_WIDTH / 2
	return h('g', { class: 'flow-node flow-question-button', transform: translate(x, y), onclick }, [
		h('defs', {}, [
			h('linearGradient', { id: 'flow-question-face', x1: '0', y1: '0', x2: '0', y2: '1' }, [
				h('stop', { offset: '0%', 'stop-color': '#f0a93c' }, []),
				h('stop', { offset: '50%', 'stop-color': '#e0821a' }, []),
				h('stop', { offset: '100%', 'stop-color': '#b35e0a' }, []),
			]),
		]),
		h('rect', { class: 'flow-question-button-bezel', x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT, rx: 9 }, []),
		h('rect', { class: 'flow-question-button-face', x: 4, y: 4, width: NODE_WIDTH - 8, height: NODE_HEIGHT - 8, rx: 6, fill: 'url(#flow-question-face)' }, []),
		h('text', { class: 'flow-question-button-label', 'text-anchor': 'middle' }, [
			h('tspan', { x: centerX, y: 24 }, ['Question']),
			h('tspan', { x: centerX, dy: 16 }, ['for']),
			h('tspan', { x: centerX, dy: 16 }, ['Human']),
		]),
	])
}

// Renders the flow view as a single SVG containing the history top bar, the observe cross-stack lines, the terminate cross-stack lines, the row stack, the departing overlay, the (on a terminal frame) result CTA, and (while an ask_human call is pending) the Question button overlay on the answerer node. Edges paint before nodes within each row so node boxes cover anchor overlap; observes and terminates sit behind the rows so node boxes cover their endpoints; the departing overlay paints last so the travel reads on top of the settled graph; the CTA and Question button paint after the rows so they sit above the graph. `lifecycle` (optional) carries the frame-diff entering/departing descriptor from deriveLifecycle; `cta` (optional) carries `{ active, onclick }` harness state for the terminal CTA — the view itself decides whether to render a CTA by reading model.status; `question` (optional) carries `{ onclick }` harness state for the Question button — the view itself decides whether to render the button by reading the active ask_human call.
export function renderFlowView(h, model, labels, tier, lifecycle, cta, question) {
	const stackIds = stacksOf(model)
	const rows = []
	for (const stackId of stackIds) {
		const row = projectRow(model, stackId)
		if (row !== null) rows.push(row)
	}

	const slots = projectTopBar(model)

	const topBarHeightValue = topBarHeight(slots.length)
	const mainYOffset = topBarHeightValue + (slots.length === 0 ? 0 : TOPBAR_GAP)

	const participantById = new Map()
	for (const participant of model.participants) participantById.set(participant.id, participant)

	// Position every participant that lands in a row so the observe layer can route between rows by participant id.
	const rowLayout = new Map()
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
		const row = rows[rowIndex]
		if (row === undefined) continue
		for (const entry of row.participants) {
			const pos = rowPixel(entry.column, rowIndex, mainYOffset)
			rowLayout.set(entry.id, pos)
		}
	}

	const activeParticipantId = activeParticipant(model)
	const enteringIds = lifecycle !== undefined ? lifecycle.enteringIds : EMPTY_SET
	const terminateTargetIds = terminateTargetIdsIn(model, rowLayout)

	const topBarVnodes = slots.map((slot, index) => {
		const participant = model.participants.find((entry) => entry.role === slot.role)
		const label = participant !== undefined ? labels.resolveParticipantLabel(participant, tier) : slot.role
		return renderSmallNode(h, slot, label, index)
	})

	const rowVnodes = rows.map((row, rowIndex) => renderRow(h, row, rowIndex, mainYOffset, model, labels, tier, participantById, enteringIds, activeParticipantId, terminateTargetIds))

	const observeVnodes = renderObserves(h, model, rowLayout)
	const terminateVnodes = renderTerminates(h, model, rowLayout)

	// The departing overlay paints a node mid-travel from its previous row position to its top-bar slot, both in the current frame's shared SVG coordinate space (the same mainYOffset the rows use) so the travel lands on the slot the counter increment reads against.
	const departingVnodes = lifecycle !== undefined ? lifecycle.departing.map((entry) => {
		const fromPos = rowPixel(entry.previousColumn, entry.previousRowIndex, mainYOffset)
		const toPos = topBarPixel(entry.slotIndex)
		const participant = participantById.get(entry.participantId)
		const resolvedLabel = participant !== undefined ? labels.resolveParticipantLabel(participant, tier) : entry.participantId
		const sublabel = participant !== undefined && participant.kind !== 'human' && participant.kind !== 'interrupt' ? participant.role : undefined
		const completion = completionReturnFor(model, entry.participantId)
		const metrics = completion !== undefined && completion.metrics !== null ? completion.metrics : null
		const status = completion !== undefined ? completion.outcome : undefined
		const style = { '--from-x': `${fromPos.x}px`, '--from-y': `${fromPos.y}px`, '--to-x': `${toPos.x}px`, '--to-y': `${toPos.y}px` }
		const classes = entry.merged ? 'flow-node flow-node--departing flow-node--merging' : 'flow-node flow-node--departing'
		return h('g', { class: classes, style, 'data-participant': entry.participantId }, [
			h('g', { class: 'flow-node--departing-scale' }, [
				GraphNode(h, {
					label: resolvedLabel,
					sublabel,
					status: status === 'success' ? 'success' : status === 'error' ? 'error' : undefined,
					costTime: metrics !== null ? metrics.elapsedSeconds : undefined,
					costTokens: metrics !== null ? metrics.tokens : undefined,
				}),
			]),
		])
	}) : []

	const showCta = isTerminalStatus(model.status)
	let ctaLayout = null
	let ctaDescriptor = null
	if (showCta) {
		ctaLayout = { x: 0, y: mainYOffset }
		ctaDescriptor = ctaDescriptorForStatus(model.status)
	}

	const currentColumnCount = rows.reduce((max, row) => {
		const rowMax = row.participants.reduce((innerMax, entry) => Math.max(innerMax, entry.column), 0)
		return Math.max(max, rowMax + 1)
	}, 0)
	// The high-water mark grows to fit the deepest frame seen this session and never shrinks back, so the centerpiece's horizontal scale stays stable as the call chain deepens and unwinds.
	columnHighWaterMark = Math.max(columnHighWaterMark, currentColumnCount)
	const mainWidth = columnHighWaterMark * NODE_WIDTH + (columnHighWaterMark - 1) * COL_GAP
	const mainHeight = rows.length > 0 ? rows.length * NODE_HEIGHT + (rows.length - 1) * ROW_GAP : 0
	const ctaHeight = showCta ? NODE_HEIGHT : 0
	const width = Math.max(topBarWidth(slots.length), mainWidth, showCta ? NODE_WIDTH : 0)
	const height = topBarHeightValue + (slots.length === 0 ? 0 : TOPBAR_GAP) + Math.max(mainHeight, ctaHeight)

	const svgChildren = [
		h('g', { class: 'flow-topbar' }, topBarVnodes),
		h('g', { class: 'flow-observes' }, observeVnodes),
		h('g', { class: 'flow-terminates' }, terminateVnodes),
		h('g', { class: 'flow-rows' }, rowVnodes),
		...departingVnodes,
	]
	if (ctaLayout !== null && ctaDescriptor !== null) {
		const isActive = cta !== undefined && cta !== null && cta.active === true
		const onclick = cta !== undefined && cta !== null ? cta.onclick : undefined
		// The CTA is a terminal action button, not a graph node with a relationship to another participant, so it carries no connecting edge. A line from the human's top-bar slot to the button read as a graph edge with no meaning; the button stands alone.
		svgChildren.push(CtaNode(h, { label: ctaDescriptor.label, active: isActive, tone: ctaDescriptor.tone, x: ctaLayout.x, y: ctaLayout.y, onclick }))
	}

	// The Question button overlays the answerer node while the ask_human call is pending. It carries no connecting edge (the removed-CTA-edge rule applies to these overlay affordances alike); the onclick is harness-supplied so the view stays free of modal coupling.
	const askHumanCall = activeAskHumanCall(model)
	if (askHumanCall !== undefined && question !== undefined && question !== null && typeof question.onclick === 'function') {
		const answererPosition = rowLayout.get(askHumanCall.destination)
		if (answererPosition !== undefined) {
			svgChildren.push(QuestionButton(h, { x: answererPosition.x, y: answererPosition.y, onclick: question.onclick }))
		}
	}

	return h('svg', { class: 'flow-view-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet', xmlns: 'http://www.w3.org/2000/svg' }, svgChildren)
}

// A reusable empty set so the no-lifecycle path avoids allocating a Set per render.
const EMPTY_SET = new Set()

// --- Product surfaces: "now" caption + cost strip ----------------------------
// The two ambient surfaces that wrap the flow view so the page conveys meaning the graph's structure alone cannot. Both are pure derivations off the InteractionModel (the same frame the flow view renders), so they never drift from the graph and never reach for a separate run-view shape. The caption localizes through the label resolver so the tier toggle swaps its voice; the cost strip reads only OperationMetrics, so it carries no prose.

/**
 * A one-line plain-language caption describing what the run is doing right now, derived from the active operation's resolved label at the chosen tier. The active operation (the latest non-observe operation on the active stack, via activeOperation) names both the active participant (its destination) and the in-flight operation; resolving its label through the tier resolver localizes the line and lets the tier toggle swap its voice without touching the model. A terminal run status short-circuits to a fixed completion line so a finished run reads as finished regardless of a lingering return leg.
 *
 * A call has two phases the caption distinguishes: the transit phase (lifecycle in_flight, the line animates) reads "A is calling B…" via the operation label; the working phase (lifecycle settled, the line goes solid because B has started producing) reads "B is planning…" via the working label of the destination — the relationship is no longer the story, B's own work is. When no working label is configured for the destination, the working phase falls back to the operation label so a minimal guild never crashes. An in-flight call appends an ellipsis to convey an action in progress; a settled return (the lingering response leg) carries no ellipsis because the leg is the current state, not a pending action.
 *
 * @param {InteractionModel} model
 * @param {InteractionModel} model
 * @param {{ resolveOperationLabel: (operation: Operation, participants: Participant[], tier: 'whimsical' | 'friendly' | 'detailed', seed: number) => string, resolveWorkingLabel?: (participant: Participant, tier: 'whimsical' | 'friendly' | 'detailed', seed: number) => string | null, hashString: (value: string) => number }} labels
 * @param {'whimsical' | 'friendly' | 'detailed'} tier
 * @returns {string}
 */
export function deriveNowCaption(model, labels, tier) {
	const status = model.status
	if (status === 'success') return 'Done.'
	if (status === 'error') return 'The run stopped with an error.'
	if (status === 'needs_clarification') return 'Waiting for your input…'
	const operation = activeOperation(model)
	if (operation === null) return 'Working…'
	// A settled call is the working phase: the destination has started its own work, so the caption names what the destination is doing (e.g. "Planning the approach…") rather than the call relationship ("Orchestrator is calling Planner"). The working label is optional per participant; when absent the caption falls back to the operation label so a guild without working labels keeps the prior behavior. The seed is the operation id's hash so the whimsical tier rotates between operations while staying fixed within one, and the working phase reuses the call's seed so transit and working of the same call land on the same whimsical phrase.
	const seed = labels.hashString(operation.id)
	if (operation.kind === 'call' && operation.lifecycle === 'settled' && typeof labels.resolveWorkingLabel === 'function') {
		const destination = model.participants.find((participant) => participant.id === operation.destination)
		if (destination !== undefined) {
			const working = labels.resolveWorkingLabel(destination, tier, seed)
			if (working !== null) return `${working}…`
		}
	}
	const label = labels.resolveOperationLabel(operation, model.participants, tier, seed)
	if (operation.lifecycle === 'in_flight') return `${label}…`
	return label
}

/**
 * Aggregates per-operation metrics into the ambient cost strip's values. Tokens are summed across every operation that carries them (cumulative spend across the whole run); elapsed is the latest non-null elapsedSeconds — the most recent operation's reported elapsed, so an in-flight operation with no elapsed yet falls back to the last operation that reported one rather than reading as zero. Returns plain numbers so the harness formats them as textContent; no prose lives here. Operations without metrics or with null fields contribute nothing.
 *
 * @param {InteractionModel} model
 * @returns {{ elapsedSeconds: number, tokens: number }}
 */
export function deriveCostStrip(model) {
	let tokens = 0
	let elapsedSeconds = 0
	let foundElapsed = false
	for (let index = model.operations.length - 1; index >= 0; index -= 1) {
		const operation = model.operations[index]
		if (operation.metrics === null) continue
		if (operation.metrics.tokens !== null) tokens += operation.metrics.tokens
		if (!foundElapsed && operation.metrics.elapsedSeconds !== null) {
			elapsedSeconds = operation.metrics.elapsedSeconds
			foundElapsed = true
		}
	}
	return { elapsedSeconds, tokens }
}
