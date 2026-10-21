// Flow-graph view renderer over an InteractionModel.
//
// The view projects the model to a stack-of-rows layout: one row per non-terminated call stack (stacksOf) in push order, the main run at the top and each preempting interrupt below it — rows never reorder as activity moves; the active stack is conveyed by the pulsing node and marching lines, not by row position.
// Each row lays its open invocations left-to-right by parent depth, with the stack's root participant (the You root or an Interrupt instance) at the leftmost column.
// An id-keyed row derives every participant's column from its parent's depth plus one (never from its index in a reconstructed chain), so siblings share a column and are separated by a small deterministic vertical lane; a legacy row keeps the index-based chain projection unchanged.
// A return whose source has departed the open chain lingers as a node plus a return edge back to its caller until the caller's next action — read straight off the operation list, never from a stored lingering flag.
// observe operations cross from the active stack up into a paused row as static dashed lines; terminate operations cross the same way as static red dashed lines, with an orange dashed border on the target.
// A top-bar strip aggregates every role/tool type that has ever run, with invocation counts and cumulative metrics drawn from each instance's incoming call operations (the only operations that carry metrics).
//
// Animation is layered on top of the settled structure via class hooks the existing CSS keyframes drive; the model carries no animation state.
// The single invariant governs every motion class: a call/return edge animates iff it is in_flight and its stack is not paused — paused stacks' lines are frozen solid, and observe and terminate never animate.
// A call edge carries 'flowing' only while its lifecycle is in_flight (settling to a solid static stroke once the callee delegates or returns); a lingering return edge carries 'returning' (or 'error' on a failed outcome) while in_flight, because a return edge exists only while it is the current response leg in flight — and a resolved stack is not paused (its chain is empty), so its final return leg keeps marching in its outcome color until the next operation settles it.
// The active participant (the destination of the active stack's current focus, via activeParticipant) pulses; participants in paused stacks do not.
//
// Frame-to-frame node lifecycle (entering/departing) is computed by deriveLifecycle from two consecutive InteractionModel frames: entering participants scale/fade in; a departing participant travels from its previous row position to its role's top-bar slot, both in the shared SVG coordinate space so the travel lands on the slot and reads as the counter incrementing.
// The travel/shrink/fade keyframes are the existing flow-node-* rules; only the from/to coordinates are passed in.
//
// The terminal-result CTA is a view concern layered on model.status, not model state: when the run reaches a terminal status the view renders a CTA node whose tone follows the status, and onclick is harness-managed.
//
// `h` is passed in rather than imported so the module stays free of hyperapp coupling and the vnode shape is exercisable in tests with a fake `h`, mirroring the existing SVG primitive convention.
// The label resolver is passed in (rather than imported) alongside the selected tier so a caller can swap the resolver or tier without the view reaching for globals; node prose is localization, a view concern, and the model carries no prose.
// The module is browser-pure TypeScript: it imports the shared interaction model, labels, and inspector attribute contract, its browser-safe siblings, and the vendored `h` type, and touches no external system.

import { activeOperation, activeParticipant, callChainOf, callMetricsByDestination, isPaused, isTerminalStatus, observesOf, openInvocationsOf, stacksOf, terminatesOf } from '../interaction-model.js'
import type { InteractionModel, Operation, Participant, ParticipantKind, RunStatus } from '../interaction-model.js'
import type { LabelResolver, LabelTier } from '../labels.js'
import type { RoleAccentResolver } from './role-accents.js'
import { createParticipantComparator } from './participant-order.js'
import { ATTR_OPERATION, ATTR_PARTICIPANT, ATTR_ROLE } from '../inspector.js'
import { GraphEdge, GraphNode, NODE_HEIGHT, NODE_WIDTH, nodeAnchor } from './svg-primitives.js'
import type { Anchor } from './svg-primitives.js'
import type { H, Vnode } from '../../vendor/hyperapp.js'

// Horizontal gap between call-depth columns and vertical gap between rows. Generous horizontal spacing keeps the left-to-right call chain legible; the vertical gap separates the main run from each preempting interrupt stack.
const COL_GAP = 96
const ROW_GAP = 104

// Top-bar small-node dimensions and wrapping. Each history slot is a small square holding just its invocation count; the role/tool name and cumulative token/time details surface via the native SVG <title> hover so a long run's history stays a compact strip. They wrap into rows so a large guild's many role/tool types never overflow horizontally.
const SMALL_SIZE = 28
const SMALL_GAP = 8
const TOP_BAR_PER_ROW = 14

// The minimum column count the flow view reserves horizontally. A run with a single active role still consumes this many columns of width so the centerpiece does not snap narrow on a one-column frame and then snap wide as delegation deepens; the tracker's high-water mark only grows past it.
const DEFAULT_MIN_COLUMNS = 5

// A caller-held high-water mark of the column count the flow view has rendered. A frame whose call chain is shallower than a previous frame still sizes to this width so nodes do not slide leftward when a deep delegation unwinds — a stable stage reads better than one that resizes per frame. The mark lives in an explicit tracker the caller creates and hands in (rather than module scope) so the view stays a pure function of its inputs: each client holds one tracker for the page-load lifetime, and each test constructs a fresh one, keeping renders order-independent.
interface ColumnTracker {
	minColumns: number
}

export function createColumnTracker(): ColumnTracker {
	return { minColumns: DEFAULT_MIN_COLUMNS }
}

// Vertical gap between the history top bar and the row stack. The two live in one shared SVG coordinate space so a node leaving a row for its top-bar slot travels in the same space (the counter increment is the point of the depart animation).
const TOPBAR_GAP = 24

function translate(x: number, y: number): string {
	return `translate(${x},${y})`
}

function rowPixel(column: number, y: number): Anchor {
	return { x: column * (NODE_WIDTH + COL_GAP), y }
}

function topBarPixel(index: number): Anchor {
	const row = Math.floor(index / TOP_BAR_PER_ROW)
	const col = index % TOP_BAR_PER_ROW
	return { x: col * (SMALL_SIZE + SMALL_GAP), y: row * (SMALL_SIZE + SMALL_GAP) }
}

function topBarWidth(count: number): number {
	if (count === 0) return 0
	const cols = Math.min(count, TOP_BAR_PER_ROW)
	return cols * SMALL_SIZE + (cols - 1) * SMALL_GAP
}

function topBarHeight(count: number): number {
	if (count === 0) return 0
	const rows = Math.ceil(count / TOP_BAR_PER_ROW)
	return rows * SMALL_SIZE + (rows - 1) * SMALL_GAP
}

// The motion state a call/return edge carries under the single invariant: a line animates iff it is in_flight and its stack is not paused — the active stack is never paused, and a resolved stack (its chain is empty) is not paused either, so a resolved stack's final return leg keeps marching in its outcome color while it travels, exactly like the active stack's own in-flight lines. A call animates 'flowing' only while its lifecycle is in_flight (the transit phase); once it settles (the working phase, or delegation, or its return) it goes solid. A return edge exists only while it is the lingering response leg, so it animates 'returning' (or 'error'/'terminated' for the matching outcome) only while in_flight (its transit phase) and goes solid once settled (its working phase). Any edge on a paused stack is frozen 'static', and observe and terminate never reach here (both render their own static dashed lines).
type EdgeAnimationState = 'static' | 'flowing' | 'returning' | 'error' | 'terminated'

function edgeAnimationState(operation: Operation, model: InteractionModel): EdgeAnimationState {
	if (operation.kind === 'observe' || operation.kind === 'terminate') return 'static'
	if (isPaused(model, operation.stack)) return 'static'
	if (operation.lifecycle === 'settled') return 'static'
	if (operation.kind === 'call') return 'flowing'
	if (operation.outcome === 'error') return 'error'
	if (operation.outcome === 'terminated') return 'terminated'
	return 'returning'
}

// Per-model memo for the renderer's whole-model derivations: the model object is never mutated in place and is replaced only when its data changes, so an unchanged poll keeps the same object by reference; each structure is computed once on first request and read by identity afterwards, and the WeakMap drops the entry with its model on run switch. The undefined slots mean "not derived yet"; a cached value is never mutated afterwards.
interface FlowLookups {
	lastCallOrReturnByStack: Map<string, Operation>
	closedCallByReturnByStack: Map<string, Map<string, Operation>>
	completionReturnBySource: Map<string, Operation>
	stacksWithOperations: Set<string>
	callByCallId: Map<string, Operation>
	indexByCallKey: Map<string, number>
	depthByCallKey: Map<string, number>
	laneOffsetsByStack: Map<string, Map<string, number>>
}

interface TopBarSlot {
	role: string
	kind: ParticipantKind
	invocations: number
	totalTime: number
	totalTokens: number
	totalCachedTokens: number
	hasMetrics: boolean
}

export interface CostStrip {
	elapsedSeconds: number
	tokens: number
}

interface DerivedFlow {
	rows: FlowLookups | undefined
	topBar: TopBarSlot[] | undefined
	costStrip: CostStrip | undefined
}

const derivedByModel = new WeakMap<object, DerivedFlow>()

function derivedOf(model: InteractionModel): DerivedFlow {
	let derived = derivedByModel.get(model)
	if (derived !== undefined) return derived
	derived = { rows: undefined, topBar: undefined, costStrip: undefined }
	derivedByModel.set(model, derived)
	return derived
}

// The per-stack and per-participant lookups the row projection and the cost reads need: the latest call-or-return per stack, the return id → closed call mapping per stack, the first completing return per participant source, and the set of stacks that carry any operation. One chronological pass computes all per-stack and per-participant lookups; the terminate handling mirrors openCallsByStack — a terminate pops the open call whose destination it targets wherever that call's stack lives, so every stack's open list is scanned, which lands the same pops per stack a per-stack replay would.
function rowLookupsOf(model: InteractionModel): FlowLookups {
	const derived = derivedOf(model)
	if (derived.rows !== undefined) return derived.rows
	const lastCallOrReturnByStack = new Map<string, Operation>()
	const closedCallByReturnByStack = new Map<string, Map<string, Operation>>()
	const completionReturnBySource = new Map<string, Operation>()
	const stacksWithOperations = new Set<string>()
	const callByCallId = new Map<string, Operation>()
	const indexByCallKey = new Map<string, number>()
	const openByStack = new Map<string, Operation[]>()
	const seenReturnCallIds = new Set<string>()
	const identity = hasCallIdentity(model)
	let operationIndex = -1
	for (const operation of model.operations) {
		operationIndex += 1
		stacksWithOperations.add(operation.stack)
		if (operation.kind === 'call') {
			if (operation.callId !== undefined && !callByCallId.has(operation.callId)) {
				callByCallId.set(operation.callId, operation)
				indexByCallKey.set(operation.callId, operationIndex)
			}
			let open = openByStack.get(operation.stack)
			if (open === undefined) {
				open = []
				openByStack.set(operation.stack, open)
			}
			open.push(operation)
			lastCallOrReturnByStack.set(operation.stack, operation)
		} else if (operation.kind === 'return') {
			// An id-keyed model ignores an unkeyed return, and only the first return for a callId is authoritative.
			if (identity && operation.callId === undefined) continue
			if (operation.callId !== undefined) {
				if (seenReturnCallIds.has(operation.callId)) continue
				seenReturnCallIds.add(operation.callId)
			}
			lastCallOrReturnByStack.set(operation.stack, operation)
			let closed: Operation | undefined
			if (operation.callId !== undefined) {
				// An id-keyed return closes exactly the call it names, so the mapping survives siblings and is independent of stack order.
				closed = callByCallId.get(operation.callId)
			} else {
				const open = openByStack.get(operation.stack)
				closed = open === undefined ? undefined : open.pop()
			}
			if (closed !== undefined) {
				let closedByReturn = closedCallByReturnByStack.get(closed.stack)
				if (closedByReturn === undefined) {
					closedByReturn = new Map()
					closedCallByReturnByStack.set(closed.stack, closedByReturn)
				}
				closedByReturn.set(operation.id, closed)
			}
			// The completion return is the participant's first return (a retried role's later instances carry their own ids), so only the first return per source is recorded.
			if (!completionReturnBySource.has(operation.source)) completionReturnBySource.set(operation.source, operation)
		} else if (operation.kind === 'terminate') {
			for (const open of openByStack.values()) {
				for (let index = open.length - 1; index >= 0; index -= 1) {
					const candidate = open[index]
					if (candidate === undefined) continue
					if (candidate.destination === operation.destination) {
						open.splice(index, 1)
						break
					}
				}
			}
		}
	}
	const lookups: FlowLookups = { lastCallOrReturnByStack, closedCallByReturnByStack, completionReturnBySource, stacksWithOperations, callByCallId, indexByCallKey, depthByCallKey: new Map(), laneOffsetsByStack: new Map() }
	derived.rows = lookups
	return lookups
}

interface RowParticipant {
	id: string
	column: number
	// A deterministic vertical lane inside the row so open siblings sharing a column do not paint over each other. Zero on the legacy index-based projection.
	offset: number
	lingering: boolean
}

interface RowEdge {
	fromColumn: number
	toColumn: number
	fromOffset: number
	toOffset: number
	operation: Operation
}

interface RowProjection {
	stackId: string
	rootId: string
	// The row's top in the row-stack coordinate space; filled by assignRowTops from the cumulative heights.
	top: number
	participants: RowParticipant[]
	callEdges: RowEdge[]
	returnEdges: RowEdge[]
}

function rowHeight(row: RowProjection): number {
	const maxOffset = row.participants.reduce((max, entry) => Math.max(max, entry.offset), 0)
	return NODE_HEIGHT + maxOffset
}

// Stacks the rows from a zero origin: each row starts below the previous row's full height (node plus its tallest lane), so a tall sibling row pushes every later row down instead of overlapping it.
function assignRowTops(rows: RowProjection[]): RowProjection[] {
	let top = 0
	return rows.map((row, index) => {
		const placed: RowProjection = { ...row, top }
		top += rowHeight(row) + (index < rows.length - 1 ? ROW_GAP : 0)
		return placed
	})
}

function rowsHeight(rows: RowProjection[]): number {
	if (rows.length === 0) return 0
	return rows.reduce((total, row) => total + rowHeight(row), 0) + (rows.length - 1) * ROW_GAP
}

// The vertical step between sibling lanes: at least one node height plus a visible gap, so sibling nodes never paint over each other.
const SIBLING_LANE_STEP = NODE_HEIGHT + 12

function hasCallIdentity(model: InteractionModel): boolean {
	return model.operations.some((operation) => operation.callId !== undefined)
}

// The destination column of a call in an id-keyed row: its parent's destination column plus one, or column 1 when it has no keyed parent on the stack (a root call, or an interrupt handler whose parent is the stack's root pseudo-invocation). The recursion follows parentCallId, never the operation order, so a stale sibling cannot become an ancestor. Depths are memoized in the per-model lookups.
function identityDepthOfCall(call: Operation, stackId: string, lookups: FlowLookups, seen: Set<string>): number {
	const key = call.callId ?? call.id
	const cached = lookups.depthByCallKey.get(key)
	if (cached !== undefined) return cached
	if (seen.has(key)) return 1
	const parentKey = call.parentCallId
	let depth = 1
	if (parentKey !== undefined) {
		const parent = lookups.callByCallId.get(parentKey)
		if (parent !== undefined && parent.stack === stackId) {
			seen.add(key)
			depth = identityDepthOfCall(parent, stackId, lookups, seen) + 1
		}
	}
	lookups.depthByCallKey.set(key, depth)
	return depth
}

// The deterministic vertical lane of every visible call on a stack, keyed by callId. The visible set is the open invocations plus the invocation closed by the lingering return; completed history never pushes an open sibling down. Lanes are assigned in start order within each (stack, depth) group, so independent branches at the same depth share the lane space instead of overlapping.
function identityLaneOffsets(stackId: string, openCalls: Operation[], lingeringReturn: Operation | undefined, lookups: FlowLookups): Map<string, number> {
	const cached = lookups.laneOffsetsByStack.get(stackId)
	if (cached !== undefined) return cached
	const visible = openCalls.slice()
	if (lingeringReturn !== undefined && lingeringReturn.callId !== undefined) {
		const closedCall = lookups.callByCallId.get(lingeringReturn.callId)
		if (closedCall !== undefined && !visible.includes(closedCall)) visible.push(closedCall)
	}
	visible.sort((left, right) => {
		const leftIndex = lookups.indexByCallKey.get(left.callId ?? left.id) ?? 0
		const rightIndex = lookups.indexByCallKey.get(right.callId ?? right.id) ?? 0
		return leftIndex - rightIndex
	})
	const offsets = new Map<string, number>()
	const counts = new Map<string, number>()
	for (const call of visible) {
		const depth = identityDepthOfCall(call, stackId, lookups, new Set())
		const siblingGroup = `${stackId}:${depth}`
		const lane = counts.get(siblingGroup) ?? 0
		counts.set(siblingGroup, lane + 1)
		offsets.set(call.callId ?? call.id, lane * SIBLING_LANE_STEP)
	}
	lookups.laneOffsetsByStack.set(stackId, offsets)
	return offsets
}

// Projects a single stack to a row descriptor: the root participant, the participants to render, and the call and lingering-return edges between them. An id-keyed model uses the open invocation tree: every open call renders at its parent's depth plus one, sibling calls share a column and take deterministic vertical lanes, and each edge runs between the actual source and destination columns. A legacy model keeps the index-based chain projection unchanged. A return lingers only while it is in_flight (its transit phase); a stack whose open calls are empty but whose latest non-observe operation is an in_flight return renders that single lingering leg, with the return's caller as the row root.
function projectRow(model: InteractionModel, stackId: string): RowProjection | null {
	const lookups = rowLookupsOf(model)
	const lastCallOrReturn = lookups.lastCallOrReturnByStack.get(stackId)
	const lingeringReturn = lastCallOrReturn !== undefined && lastCallOrReturn.kind === 'return' && lastCallOrReturn.lifecycle === 'in_flight'
		? lastCallOrReturn
		: undefined
	if (hasCallIdentity(model)) return projectIdentityRow(model, stackId, lookups, lingeringReturn)
	return projectLegacyRow(model, stackId, lookups, lingeringReturn)
}

function emptyStackRow(model: InteractionModel, stackId: string, lookups: FlowLookups): RowProjection | null {
	// A freshly preempted stack has no operations yet: it renders a row holding just its root, the current worker while the preempting party readies its first act. Operations alone cannot name such a stack, so the row exists only when the model carries stack records (the adapter emits them; hand-authored models render nothing here). The first stack with no operations is an empty run and renders nothing instead.
	if (model.stacks === undefined) return null
	const firstStack = model.stacks[0]
	if (firstStack !== undefined && stackId === firstStack.id) return null
	const record = model.stacks.find((entry) => entry.id === stackId)
	if (record === undefined) return null
	if (lookups.stacksWithOperations.has(stackId)) return null
	return { stackId, rootId: record.root, top: 0, participants: [{ id: record.root, column: 0, offset: 0, lingering: false }], callEdges: [], returnEdges: [] }
}

function projectIdentityRow(model: InteractionModel, stackId: string, lookups: FlowLookups, lingeringReturn: Operation | undefined): RowProjection | null {
	const openCalls = openInvocationsOf(model, stackId)
	if (openCalls.length === 0 && lingeringReturn === undefined) return emptyStackRow(model, stackId, lookups)
	const record = model.stacks?.find((entry) => entry.id === stackId)
	const firstOpenCall = openCalls[0]
	const rootId = record?.root ?? firstOpenCall?.source ?? lingeringReturn?.destination
	if (rootId === undefined) return null

	const columnByParticipant = new Map<string, number>()
	const offsetByParticipant = new Map<string, number>()
	const participants: RowParticipant[] = [{ id: rootId, column: 0, offset: 0, lingering: false }]
	columnByParticipant.set(rootId, 0)
	offsetByParticipant.set(rootId, 0)
	const callEdges: RowEdge[] = []
	const laneOffsetByKey = identityLaneOffsets(stackId, openCalls, lingeringReturn, lookups)
	const openDestinationIds = new Set(openCalls.map((call) => call.destination))
	for (const call of openCalls) {
		const depth = identityDepthOfCall(call, stackId, lookups, new Set())
		const key = call.callId ?? call.id
		const destinationOffset = laneOffsetByKey.get(key) ?? 0
		const sourceColumn = columnByParticipant.get(call.source) ?? Math.max(0, depth - 1)
		const sourceCall = openCalls.find((candidate) => candidate.destination === call.source)
			?? (call.parentCallId === undefined ? undefined : lookups.callByCallId.get(call.parentCallId))
		const sourceOffset = offsetByParticipant.get(call.source) ?? (sourceCall === undefined ? 0 : laneOffsetByKey.get(sourceCall.callId ?? sourceCall.id) ?? 0)
		// A closed caller is not resurrected as a node: its child's edge anchors at the caller's column, while only the stack root and still-open destinations render.
		if (!columnByParticipant.has(call.source) && (call.source === rootId || openDestinationIds.has(call.source))) {
			columnByParticipant.set(call.source, sourceColumn)
			offsetByParticipant.set(call.source, sourceOffset)
			participants.push({ id: call.source, column: sourceColumn, offset: sourceOffset, lingering: false })
		}
		columnByParticipant.set(call.destination, depth)
		offsetByParticipant.set(call.destination, destinationOffset)
		participants.push({ id: call.destination, column: depth, offset: destinationOffset, lingering: false })
		callEdges.push({ fromColumn: sourceColumn, toColumn: depth, fromOffset: sourceOffset, toOffset: destinationOffset, operation: call })
	}
	const returnEdges: RowEdge[] = []
	if (lingeringReturn !== undefined) {
		const closedCall = lingeringReturn.callId === undefined ? undefined : lookups.callByCallId.get(lingeringReturn.callId)
		if (closedCall !== undefined) {
			const lingeringColumn = identityDepthOfCall(closedCall, stackId, lookups, new Set())
			const callerColumn = columnByParticipant.get(lingeringReturn.destination) ?? Math.max(0, lingeringColumn - 1)
			const callerCall = openCalls.find((candidate) => candidate.destination === lingeringReturn.destination)
				?? (closedCall.parentCallId === undefined ? undefined : lookups.callByCallId.get(closedCall.parentCallId))
			const callerOffset = offsetByParticipant.get(lingeringReturn.destination) ?? (callerCall === undefined ? 0 : laneOffsetByKey.get(callerCall.callId ?? callerCall.id) ?? 0)
			const lingeringOffset = laneOffsetByKey.get(closedCall.callId ?? closedCall.id) ?? 0
			columnByParticipant.set(closedCall.destination, lingeringColumn)
			participants.push({ id: closedCall.destination, column: lingeringColumn, offset: lingeringOffset, lingering: true })
			returnEdges.push({ fromColumn: lingeringColumn, toColumn: callerColumn, fromOffset: lingeringOffset, toOffset: callerOffset, operation: lingeringReturn })
		}
	}
	return { stackId, rootId, top: 0, participants, callEdges, returnEdges }
}

function projectLegacyRow(model: InteractionModel, stackId: string, lookups: FlowLookups, lingeringReturn: Operation | undefined): RowProjection | null {
	const chain = callChainOf(model, stackId)
	if (chain.length === 0 && lingeringReturn === undefined) return emptyStackRow(model, stackId, lookups)

	// The row root is the open chain's first call source, or — when the chain is empty — the lingering return's caller (its destination), who is the stack's effective root while the last return leg is still in flight. The throw is the guard above's invariant: an empty chain reaches here only with a lingering return, which the guard already returned on.
	let rootId: string
	const rootCall = chain[0]
	if (rootCall !== undefined) rootId = rootCall.source
	else if (lingeringReturn !== undefined) rootId = lingeringReturn.destination
	else throw new Error('projectRow invariant violated: a row was projected with neither an open call nor an in-flight return leg')

	const columnByParticipant = new Map<string, number>()
	columnByParticipant.set(rootId, 0)
	const participants: RowParticipant[] = [{ id: rootId, column: 0, offset: 0, lingering: false }]
	const callEdges: RowEdge[] = []
	for (let index = 0; index < chain.length; index += 1) {
		const call = chain[index]
		if (call === undefined) continue
		const sourceColumn = columnByParticipant.get(call.source) ?? index
		const destinationColumn = index + 1
		columnByParticipant.set(call.destination, destinationColumn)
		participants.push({ id: call.destination, column: destinationColumn, offset: 0, lingering: false })
		callEdges.push({ fromColumn: sourceColumn, toColumn: destinationColumn, fromOffset: 0, toOffset: 0, operation: call })
	}

	const closedByReturn = lookups.closedCallByReturnByStack.get(stackId)

	const returnEdges: RowEdge[] = []
	if (lingeringReturn !== undefined) {
		const closedCall = closedByReturn?.get(lingeringReturn.id)
		if (closedCall !== undefined) {
			// The lingering leg renders only while the return is in transit (in_flight); once the return settles (working phase) the returner has departed and neither the node nor its response edge is drawn. The lingering source sat one column past the open chain's innermost node: it was the innermost call before its return popped it, so its depth is the current open chain length plus one.
			const lingeringColumn = chain.length + 1
			const callerColumn = columnByParticipant.get(lingeringReturn.destination) ?? 0
			participants.push({ id: closedCall.destination, column: lingeringColumn, offset: 0, lingering: true })
			returnEdges.push({ fromColumn: lingeringColumn, toColumn: callerColumn, fromOffset: 0, toOffset: 0, operation: lingeringReturn })
		}
	}

	return { stackId, rootId, top: 0, participants, callEdges, returnEdges }
}

// Aggregates every role/tool type that has ever appeared in the model into one top-bar slot, with the total invocation count (every participant instance of that role, current and departed, so the count matches the "ever run" rule) and the cumulative metrics drawn from each instance's incoming call operations — the adapter accumulates a callee's LLM spend (final attempts plus discarded retry attempts) on its call, while returns carry no metrics. The strip carries no status state: a slot's color is identity only (the role's accent or the tool tint — renderSmallNode), and error outcomes surface in the role tooltip's error count (aggregateRole in tooltip.ts), never on the tile. Departed participants are represented here regardless of whether they currently linger in a row; the depart animation reconciles a lingering node with its slot in the animation layer. The render and the lifecycle diff each read the strip per poll, so the slots are memoized per model and shared read-only between those readers.
function projectTopBar(model: InteractionModel): TopBarSlot[] {
	const derived = derivedOf(model)
	if (derived.topBar !== undefined) return derived.topBar
	const slotByRole = new Map<string, TopBarSlot>()
	for (const participant of model.participants) {
		// The human is the eternal root of every run, never a role that "ran", so it never occupies a top-bar slot.
		if (participant.kind === 'human') continue
		let slot = slotByRole.get(participant.role)
		if (slot === undefined) {
			slot = { role: participant.role, kind: participant.kind, invocations: 0, totalTime: 0, totalTokens: 0, totalCachedTokens: 0, hasMetrics: false }
			slotByRole.set(participant.role, slot)
		}
		slot.invocations += 1
	}
	const metricsByDestination = callMetricsByDestination(model)
	for (const participant of model.participants) {
		const slot = slotByRole.get(participant.role)
		if (slot === undefined) continue
		const metrics = metricsByDestination.get(participant.id)
		if (metrics !== undefined) {
			if (metrics.elapsedSeconds !== null) {
				slot.totalTime += metrics.elapsedSeconds
				slot.hasMetrics = true
			}
			if (metrics.tokens !== null) {
				slot.totalTokens += metrics.tokens
				slot.hasMetrics = true
			}
			if (metrics.cachedPromptTokens !== null) slot.totalCachedTokens += metrics.cachedPromptTokens
		}
	}
	const slots = Array.from(slotByRole.values())
	derived.topBar = slots
	return slots
}

// The completion return for a participant (the first return whose source is the participant), read for its outcome — the status stroke. Cost metrics no longer come from here (the adapter attaches metrics to call operations only), so the cost reads the participant's incoming call via callMetricsByDestination. A participant still in flight has no completing return, so it carries no status. Read from the per-model pass (rowLookupsOf) instead of scanning the operation list per node per render.
function completionReturnFor(model: InteractionModel, participantId: string): Operation | undefined {
	return rowLookupsOf(model).completionReturnBySource.get(participantId)
}

// Renders a single top-bar slot as a small square holding its invocation count, with a <title> carrying the label, count, and cumulative metrics for hover. The tile carries no status state — its color is identity only (the tool modifier or the role's accent below), so success and failure never recolor the strip and a role's failures surface through the role tooltip's error count instead. An agent role's slot carries the role's accent (an inline --node-accent custom property plus the flow-small-node--accented modifier, resolved from the guild's full role list) so the strip's slots are identifiable at a glance; a null accent — the tools, the pseudo-roles, a role outside the guild's config — adds neither the class nor the style, so the slot renders exactly the neutral vnode.
function renderSmallNode(h: H, slot: TopBarSlot, label: string, index: number, roleAccents: RoleAccentResolver): Vnode {
	const pos = topBarPixel(index)
	const classes = ['flow-small-node']
	if (slot.kind === 'tool') classes.push('flow-small-node--tool')
	const accent = slot.kind === 'role' ? roleAccents(slot.role) : null
	if (accent !== null) classes.push('flow-small-node--accented')
	const props: Record<string, unknown> = { class: classes.join(' '), transform: translate(pos.x, pos.y), [ATTR_ROLE]: slot.role, 'data-kind': slot.kind }
	if (accent !== null) props['style'] = { '--node-accent': accent }
	const titleParts = [label, `${slot.invocations} call${slot.invocations === 1 ? '' : 's'}`]
	if (slot.hasMetrics) {
		if (slot.totalTime > 0) titleParts.push(`${slot.totalTime}s`)
		if (slot.totalTokens > 0) {
			titleParts.push(`${slot.totalTokens.toLocaleString()} tokens`)
			// The cached share is a subset of the prompt bill, so it rides the tokens figure as a note rather than standing as its own bucket.
			if (slot.totalCachedTokens > 0) titleParts.push(`cached ${slot.totalCachedTokens.toLocaleString()}`)
		}
	}
	return h('g', props, [
		h('title', {}, [titleParts.join(' \u00b7 ')]),
		h('rect', { class: 'flow-small-node-box', x: 0, y: 0, width: SMALL_SIZE, height: SMALL_SIZE, rx: 5 }, []),
		h('text', { class: 'flow-small-node-count', x: SMALL_SIZE / 2, y: SMALL_SIZE / 2 + 1, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, [String(slot.invocations)]),
	])
}

// Renders one row: edges first (so node boxes paint over anchor overlap), then nodes translated to their call-depth columns. The row group carries the stack id so the structure is discoverable from the DOM and the animation layer can target it. Each call/return edge carries its motion state off the operation it renders and the single invariant; the active participant's node carries the active class so it pulses. A node flagged as a terminate target carries the terminate-target class so the CSS overlays the orange dashed border. An agent role's node carries its guild-assigned accent (an inline --node-accent custom property plus the flow-node--accented modifier on the row host, which the inner box inherits); tools keep the violet kind tint and human/interrupt stay neutral — a null accent adds neither the class nor the style, so the node renders exactly the neutral vnode.
function renderRow(h: H, row: RowProjection, rowIndex: number, rowTop: number, model: InteractionModel, labels: LabelResolver, tier: LabelTier, roleAccents: RoleAccentResolver, participantById: Map<string, Participant>, enteringIds: ReadonlySet<string>, activeParticipantId: string | null, terminateTargetIds: ReadonlySet<string>): Vnode {
	const edgeVnodes: Vnode[] = []
	for (const callEdge of row.callEdges) {
		const fromPos = rowPixel(callEdge.fromColumn, rowTop + callEdge.fromOffset)
		const toPos = rowPixel(callEdge.toColumn, rowTop + callEdge.toOffset)
		const fromAnchor = nodeAnchor(fromPos.x, fromPos.y, 'right')
		const toAnchor = nodeAnchor(toPos.x, toPos.y, 'left')
		edgeVnodes.push(h('g', { class: 'flow-edge flow-edge--call', 'data-stack': row.stackId, 'data-kind': 'call', [ATTR_OPERATION]: callEdge.operation.id }, [
			GraphEdge(h, { fromAnchor, toAnchor, kind: 'call', state: edgeAnimationState(callEdge.operation, model) }),
		]))
	}
	for (const returnEdge of row.returnEdges) {
		const fromPos = rowPixel(returnEdge.fromColumn, rowTop + returnEdge.fromOffset)
		const toPos = rowPixel(returnEdge.toColumn, rowTop + returnEdge.toOffset)
		const fromAnchor = nodeAnchor(fromPos.x, fromPos.y, 'bottom')
		const toAnchor = nodeAnchor(toPos.x, toPos.y, 'bottom')
		edgeVnodes.push(h('g', { class: 'flow-edge flow-edge--return', 'data-stack': row.stackId, 'data-kind': 'return', [ATTR_OPERATION]: returnEdge.operation.id }, [
			GraphEdge(h, { fromAnchor, toAnchor, kind: 'return', state: edgeAnimationState(returnEdge.operation, model) }),
		]))
	}

	const nodeVnodes = row.participants.map((entry): Vnode => {
		const participant = participantById.get(entry.id)
		const resolvedLabel = participant !== undefined ? labels.resolveParticipantLabel(participant, tier) : entry.id
		const sublabel = participant !== undefined && participant.kind !== 'human' && participant.kind !== 'interrupt' ? participant.role : undefined
		// Cost comes from the participant's incoming call (the callee's own spend); the status stroke comes from the completing return — two different operations, so two different lookups. The cost line's token figure is the call's lastPromptTokens (the invocation's current context window size), not its cumulative bill.
		const incoming = callMetricsByDestination(model).get(entry.id)
		const completion = completionReturnFor(model, entry.id)
		const status = completion !== undefined ? completion.outcome : undefined
		const pos = rowPixel(entry.column, rowTop + entry.offset)
		const isTerminateTarget = terminateTargetIds.has(entry.id)
		const accent = participant !== undefined && participant.kind === 'role' ? roleAccents(participant.role) : null
		const inner = GraphNode(h, {
			label: resolvedLabel,
			sublabel,
			kind: participant !== undefined ? participant.kind : undefined,
			status: status === 'success' ? 'success' : status === 'error' ? 'error' : undefined,
			active: entry.id === activeParticipantId,
			costTime: incoming !== undefined ? incoming.elapsedSeconds : undefined,
			costContextTokens: incoming !== undefined ? incoming.lastPromptTokens : undefined,
		})
		if (enteringIds.has(entry.id)) {
			const enteringProps: Record<string, unknown> = { class: ['flow-node', 'flow-node--entering-host', accent !== null ? 'flow-node--accented' : null, isTerminateTarget ? 'flow-node--terminate-target' : null].filter((token) => token !== null).join(' '), transform: translate(pos.x, pos.y), [ATTR_PARTICIPANT]: entry.id, [ATTR_ROLE]: participant !== undefined ? participant.role : '', 'data-kind': participant !== undefined ? participant.kind : '', 'data-lingering': entry.lingering ? 'true' : 'false' }
			if (accent !== null) enteringProps['style'] = { '--node-accent': accent }
			return h('g', enteringProps, [
				h('g', { class: 'flow-node--entering' }, [inner]),
			])
		}
		const props: Record<string, unknown> = { class: ['flow-node', accent !== null ? 'flow-node--accented' : null, isTerminateTarget ? 'flow-node--terminate-target' : null].filter((token) => token !== null).join(' '), transform: translate(pos.x, pos.y), [ATTR_PARTICIPANT]: entry.id, [ATTR_ROLE]: participant !== undefined ? participant.role : '', 'data-kind': participant !== undefined ? participant.kind : '', 'data-lingering': entry.lingering ? 'true' : 'false' }
		if (accent !== null) props['style'] = { '--node-accent': accent }
		return h('g', props, [inner])
	})

	return h('g', { class: 'flow-row', 'data-stack': row.stackId, 'data-row-index': String(rowIndex) }, [...edgeVnodes, ...nodeVnodes])
}

// Renders every observe operation as a static dashed line between its source (in the active stack's row) and its destination (in a paused row), so a cross-stack observation reads as a reference rather than an in-flight call. The line never animates and never enters any call chain.
function renderObserves(h: H, model: InteractionModel, rowLayout: Map<string, Anchor>): Vnode[] {
	if (rowLayout.size === 0) return []
	const vnodes: Vnode[] = []
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
function renderTerminates(h: H, model: InteractionModel, rowLayout: Map<string, Anchor>): Vnode[] {
	if (rowLayout.size === 0) return []
	const vnodes: Vnode[] = []
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
function terminateTargetIdsIn(model: InteractionModel, rowLayout: Map<string, Anchor>): Set<string> {
	const ids = new Set<string>()
	for (const terminate of terminatesOf(model)) {
		if (!rowLayout.has(terminate.source)) continue
		if (!rowLayout.has(terminate.destination)) continue
		ids.add(terminate.destination)
	}
	return ids
}

// Maps every participant that lands in a row to its rendered row index and call-depth column, by replaying the same stacksOf + projectRow projection the renderer uses. deriveLifecycle reads this for both frames so a departing participant's previous position is computed against the same layout the renderer will paint, and entering ids are exactly the participants present in the current rows but absent from the previous rows.
function rowParticipantPositions(model: InteractionModel): Map<string, { top: number; column: number; offset: number }> {
	const positions = new Map<string, { top: number; column: number; offset: number }>()
	const projectedRows: RowProjection[] = []
	for (const stackId of stacksOf(model)) {
		const row = projectRow(model, stackId)
		if (row !== null) projectedRows.push(row)
	}
	for (const row of assignRowTops(projectedRows)) {
		for (const entry of row.participants) {
			positions.set(entry.id, { top: row.top, column: entry.column, offset: entry.offset })
		}
	}
	return positions
}

// The top-bar slots in display order: projectTopBar returns first-seen order (memoized per model), and the copy is sorted with the guild's comparator so the strip, its pixel positions, and the departure targets all share one order without mutating the memoized array.
function orderedTopBarSlots(model: InteractionModel, roleOrder: readonly string[]): TopBarSlot[] {
	return projectTopBar(model).slice().sort(createParticipantComparator(roleOrder))
}

// Maps each role to its top-bar slot index in a model, by replaying the sorted orderedTopBarSlots. deriveLifecycle uses this to place a departing participant's destination on the current frame's top bar, so the travel lands on the slot the counter increment will read against. The sort is the same one renderFlowView applies, so a departure lands on the slot the strip paints.
function topBarSlotIndexByRole(model: InteractionModel, roleOrder: readonly string[]): Map<string, number> {
	const indexByRole = new Map<string, number>()
	orderedTopBarSlots(model, roleOrder).forEach((slot, index) => indexByRole.set(slot.role, index))
	return indexByRole
}

function topBarRoleSet(model: InteractionModel): Set<string> {
	return new Set(projectTopBar(model).map((slot) => slot.role))
}

// Looks up a participant by id in a model. Participants never leave the model's participant list (they only leave the rows), so a participant departing the rows of the current frame is still present here and the renderer can read its role/kind/label off the current model.
function participantByIdIn(model: InteractionModel, participantId: string): Participant | undefined {
	for (const participant of model.participants) {
		if (participant.id === participantId) return participant
	}
	return undefined
}

interface DepartingNode {
	participantId: string
	previousTop: number
	previousColumn: number
	previousOffset: number
	slotIndex: number
	merged: boolean
}

// The frame-diff descriptor deriveLifecycle produces and renderFlowView consumes: the participants entering the rows (scale/fade in) and those departing them for a top-bar slot.
interface FrameLifecycle {
	enteringIds: Set<string>
	departing: DepartingNode[]
}

// Diffs two consecutive InteractionModel frames into a node-lifecycle descriptor the renderer animates. `enteringIds` is the set of participant ids present in the current rows but absent from the previous rows; each renders a scale/fade-in. `departing` lists participants present in the previous rows but absent from the current rows, each carrying its previous row/column (so the renderer can place the travel origin) and its top-bar slot destination in the current frame (so the travel lands on the slot), plus `merged` when the role's slot already existed in the previous top bar (the counter increments) versus a fresh slot. Both positions live in the shared SVG coordinate space the renderer paints, so a departing node visibly travels to its slot. A null previousModel (the first frame of a scenario) animates nothing — the graph renders settled rather than every node fading in on each scenario select.
export function deriveLifecycle(previousModel: InteractionModel | null | undefined, currentModel: InteractionModel, roleOrder: readonly string[]): FrameLifecycle {
	const enteringIds = new Set<string>()
	const departing: DepartingNode[] = []
	if (previousModel === undefined || previousModel === null) {
		return { enteringIds, departing }
	}
	const previousPositions = rowParticipantPositions(previousModel)
	const currentPositions = rowParticipantPositions(currentModel)
	for (const participantId of currentPositions.keys()) {
		if (!previousPositions.has(participantId)) enteringIds.add(participantId)
	}
	const currentSlotIndexByRole = topBarSlotIndexByRole(currentModel, roleOrder)
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
			previousTop: previousPos.top,
			previousColumn: previousPos.column,
			previousOffset: previousPos.offset,
			slotIndex,
			merged: previousTopBarRoles.has(participant.role),
		})
	}
	return { enteringIds, departing }
}

// A hyperapp event handler as the stage forwards it: the stage never invokes the callback, so it does not name the host's action-state type. The `never` parameters keep every host handler assignable while still requiring a function, and the contract in index.ts documents when each affordance fires.
export type ClickHandler = (state: never, event: Event) => unknown

// The terminal-result call-to-action node renders on a terminal frame so the run offers a result affordance. The CTA is a view concern layered on model.status (never model state): the tone follows the status, and onclick is harness-managed. A layered "bezel + bevel + face" 3D button reads as pressable at a glance. The gradients are declared inline (stable ids) so the button is self-contained.
function CtaNode(h: H, props: { label: string; tone: 'accent' | 'error'; x: number; y: number; onclick?: ClickHandler }): Vnode {
	const label = props.label
	const tone = props.tone === 'error' ? 'error' : 'accent'
	return h('g', { class: 'flow-node flow-cta', transform: translate(props.x, props.y), onclick: props.onclick }, [
		CtaButton(h, { label, tone }),
	])
}

function CtaButton(h: H, props: { label: string; tone: 'accent' | 'error' }): Vnode {
	const label = props.label
	const tone = props.tone === 'error' ? 'error' : 'accent'
	const bezelId = 'flow-cta-bezel'
	const bevelId = 'flow-cta-bevel'
	const faceId = tone === 'error' ? 'flow-cta-face-error' : 'flow-cta-face-grad'
	const insetBevel = 2
	const insetFace = 5
	const children: Vnode[] = [
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
	return h('g', { class: 'flow-cta-button' }, children)
}

// Maps a terminal run status to the CTA's label and tone. A needs_clarification run is waiting on the human, so it reads as an accent (not an error); a failed or interrupted run is error-toned; success is accent.
function ctaDescriptorForStatus(status: RunStatus): { label: string; tone: 'accent' | 'error' } {
	if (status === 'error' || status === 'interrupted') return { label: 'See error', tone: 'error' }
	if (status === 'needs_clarification') return { label: 'Respond', tone: 'accent' }
	return { label: 'See result', tone: 'accent' }
}

// The ask_human call, when its question is pending: the active operation is an in_flight call whose destination is a human participant (the answerer). A human never emits an operation that would advance the call to its working phase, so the call stays in transit until the user answers — the same single-transit-frame rule the terminal op follows, but the run is not terminal here. The Question affordance overlays the answerer node for the duration of this frame.
function activeAskHumanCall(model: InteractionModel): Operation | undefined {
	const operation = activeOperation(model)
	if (operation === null) return undefined
	if (operation.kind !== 'call' || operation.lifecycle !== 'in_flight') return undefined
	const destination = model.participants.find((participant) => participant.id === operation.destination)
	if (destination === undefined || destination.kind !== 'human') return undefined
	return operation
}

// The "Question for Human" overlay button, rendered on the answerer node while the ask_human call is pending. Mirrors the terminal CTA — a standalone overlay button with no connecting edge, so it reads as an affordance rather than a graph node — but sits on the answerer (downstream of the asker) instead of the root. The label splits across three lines ("Question" / "for" / "Human") via stacked <tspan> elements so the three-word affordance reads at a glance within the node box.
function QuestionButton(h: H, props: { x: number; y: number; onclick: ClickHandler }): Vnode {
	const centerX = NODE_WIDTH / 2
	return h('g', { class: 'flow-node flow-question-button', transform: translate(props.x, props.y), onclick: props.onclick }, [
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

// The harness-state bags renderFlowView's optional CTA and Question parameters carry: the click handler for the terminal CTA, and the click handler for the pending-question overlay. The view itself decides whether to render either affordance by reading the model, so a handler supplied for a frame that does not render its affordance is never called.
export interface CtaControls {
	onclick?: ClickHandler
}

export interface QuestionControls {
	onclick?: ClickHandler
}

// Renders the flow view as a single SVG containing the history top bar, the observe cross-stack lines, the terminate cross-stack lines, the row stack, the departing overlay, the (on a terminal frame) result CTA, and (while an ask_human call is pending) the Question button overlay on the answerer node. Edges paint before nodes within each row so node boxes cover anchor overlap; observes and terminates sit behind the rows so node boxes cover their endpoints; the departing overlay paints last so the travel reads on top of the settled graph; the CTA and Question button paint after the rows so they sit above the graph. `lifecycle` (optional) carries the frame-diff entering/departing descriptor from deriveLifecycle; `cta` and `question` carry the harness state for the two overlay affordances — the view itself decides whether to render them by reading model.status and the active ask_human call. `columns` is the caller-held high-water-mark tracker from createColumnTracker. `roleAccents` is the per-role accent resolver the hosts build from the guild's full role list (createRoleAccentResolver) — agent nodes take their role's accent wherever they render (row nodes, the departing overlay, the top-bar slots), and a resolver that returns null for everything renders exactly the neutral look. `roleOrder` is the guild-declared agent-role display order (guild.json visualization.roleOrder); the top-bar slots are sorted into it (participant-order.ts), so the strip's slot order, its pixel positions, and the departure targets all agree, and the sequence view's role columns sort the same way.
// `lifecycle`, `cta`, and `question` are nullable-but-required parameters (not optional ones) so the positional call shape the hosts use — passing undefined for the affordances they omit — stays exactly the shape the types describe.
export function renderFlowView(h: H, model: InteractionModel, labels: LabelResolver, tier: LabelTier, roleAccents: RoleAccentResolver, roleOrder: readonly string[], lifecycle: FrameLifecycle | undefined, cta: CtaControls | undefined, question: QuestionControls | undefined, columns: ColumnTracker): Vnode {
	const stackIds = stacksOf(model)
	const projectedRows: RowProjection[] = []
	for (const stackId of stackIds) {
		const row = projectRow(model, stackId)
		if (row !== null) projectedRows.push(row)
	}
	const rows = assignRowTops(projectedRows)

	const slots = orderedTopBarSlots(model, roleOrder)

	const topBarHeightValue = topBarHeight(slots.length)
	const mainYOffset = topBarHeightValue + (slots.length === 0 ? 0 : TOPBAR_GAP)

	const participantById = new Map<string, Participant>()
	for (const participant of model.participants) participantById.set(participant.id, participant)

	// Position every participant that lands in a row so the observe layer can route between rows by participant id.
	const rowLayout = new Map<string, Anchor>()
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
		const row = rows[rowIndex]
		if (row === undefined) continue
		for (const entry of row.participants) {
			const pos = rowPixel(entry.column, mainYOffset + row.top + entry.offset)
			rowLayout.set(entry.id, pos)
		}
	}

	const activeParticipantId = activeParticipant(model)
	const enteringIds = lifecycle !== undefined ? lifecycle.enteringIds : EMPTY_SET
	const terminateTargetIds = terminateTargetIdsIn(model, rowLayout)

	const topBarVnodes = slots.map((slot, index) => {
		const participant = model.participants.find((entry) => entry.role === slot.role)
		const label = participant !== undefined ? labels.resolveParticipantLabel(participant, tier) : slot.role
		return renderSmallNode(h, slot, label, index, roleAccents)
	})

	const rowVnodes = rows.map((row, rowIndex) => renderRow(h, row, rowIndex, mainYOffset + row.top, model, labels, tier, roleAccents, participantById, enteringIds, activeParticipantId, terminateTargetIds))

	const observeVnodes = renderObserves(h, model, rowLayout)
	const terminateVnodes = renderTerminates(h, model, rowLayout)

	// The departing overlay paints a node mid-travel from its previous row position to its top-bar slot, both in the current frame's shared SVG coordinate space (the same mainYOffset the rows use) so the travel lands on the slot the counter increment reads against. The traveling node keeps its role's accent so the departure reads as the same colored node arriving at its slot.
	const departingVnodes: Vnode[] = lifecycle !== undefined ? lifecycle.departing.map((entry) => {
		const fromPos = rowPixel(entry.previousColumn, mainYOffset + entry.previousTop + entry.previousOffset)
		const toPos = topBarPixel(entry.slotIndex)
		const participant = participantById.get(entry.participantId)
		const resolvedLabel = participant !== undefined ? labels.resolveParticipantLabel(participant, tier) : entry.participantId
		const sublabel = participant !== undefined && participant.kind !== 'human' && participant.kind !== 'interrupt' ? participant.role : undefined
		// Same split as the row nodes: the cost line reads the incoming call (its lastPromptTokens context figure), the status stroke the completing return.
		const incoming = callMetricsByDestination(model).get(entry.participantId)
		const completion = completionReturnFor(model, entry.participantId)
		const status = completion !== undefined ? completion.outcome : undefined
		const accent = participant !== undefined && participant.kind === 'role' ? roleAccents(participant.role) : null
		const style: Record<string, string> = { '--from-x': `${fromPos.x}px`, '--from-y': `${fromPos.y}px`, '--to-x': `${toPos.x}px`, '--to-y': `${toPos.y}px` }
		if (accent !== null) style['--node-accent'] = accent
		const classes = ['flow-node', 'flow-node--departing', entry.merged ? 'flow-node--merging' : null, accent !== null ? 'flow-node--accented' : null].filter((token) => token !== null).join(' ')
		return h('g', { class: classes, style, [ATTR_PARTICIPANT]: entry.participantId }, [
			h('g', { class: 'flow-node--departing-scale' }, [
				GraphNode(h, {
					label: resolvedLabel,
					sublabel,
					kind: participant !== undefined ? participant.kind : undefined,
					status: status === 'success' ? 'success' : status === 'error' ? 'error' : undefined,
					costTime: incoming !== undefined ? incoming.elapsedSeconds : undefined,
					costContextTokens: incoming !== undefined ? incoming.lastPromptTokens : undefined,
				}),
			]),
		])
	}) : []

	const showCta = isTerminalStatus(model.status)
	let ctaLayout: Anchor | null = null
	let ctaDescriptor: { label: string; tone: 'accent' | 'error' } | null = null
	if (showCta) {
		ctaLayout = { x: 0, y: mainYOffset }
		ctaDescriptor = ctaDescriptorForStatus(model.status)
	}

	const currentColumnCount = rows.reduce((max, row) => {
		const rowMax = row.participants.reduce((innerMax, entry) => Math.max(innerMax, entry.column), 0)
		return Math.max(max, rowMax + 1)
	}, 0)
	// The high-water mark grows to fit the deepest frame the caller has rendered and never shrinks back, so the centerpiece's horizontal scale stays stable as the call chain deepens and unwinds.
	columns.minColumns = Math.max(columns.minColumns, currentColumnCount)
	const mainWidth = columns.minColumns * NODE_WIDTH + (columns.minColumns - 1) * COL_GAP
	const mainHeight = rowsHeight(rows)
	const ctaHeight = showCta ? NODE_HEIGHT : 0
	const width = Math.max(topBarWidth(slots.length), mainWidth, showCta ? NODE_WIDTH : 0)
	const height = topBarHeightValue + (slots.length === 0 ? 0 : TOPBAR_GAP) + Math.max(mainHeight, ctaHeight)

	const svgChildren: Vnode[] = [
		h('g', { class: 'flow-topbar' }, topBarVnodes),
		h('g', { class: 'flow-observes' }, observeVnodes),
		h('g', { class: 'flow-terminates' }, terminateVnodes),
		h('g', { class: 'flow-rows' }, rowVnodes),
		...departingVnodes,
	]
	if (ctaLayout !== null && ctaDescriptor !== null) {
		const onclick = cta !== undefined && cta !== null ? cta.onclick : undefined
		// The CTA is a terminal action button, not a graph node with a relationship to another participant, so it carries no connecting edge. A line from the human's top-bar slot to the button read as a graph edge with no meaning; the button stands alone.
		svgChildren.push(CtaNode(h, { label: ctaDescriptor.label, tone: ctaDescriptor.tone, x: ctaLayout.x, y: ctaLayout.y, onclick }))
	}

	// The Question button overlays the answerer node while the ask_human call is pending. It carries no connecting edge (the CTA's no-connecting-edge rule applies to these overlay affordances alike); the onclick is harness-supplied so the view stays free of modal coupling.
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
const EMPTY_SET: ReadonlySet<string> = new Set()

// --- Product surfaces: "now" caption + cost strip ----------------------------
// The two ambient surfaces that wrap the flow view so the page conveys meaning the graph's structure alone cannot. Both are pure derivations off the InteractionModel (the same frame the flow view renders), so they never drift from the graph and never reach for a separate run-view shape. The caption localizes through the label resolver so the tier toggle swaps its voice; the cost strip reads only OperationMetrics, so it carries no prose.

// A one-line plain-language caption describing what the run is doing right now, derived from the active operation's resolved label at the chosen tier. The active operation (the latest non-observe operation on the active stack, via activeOperation) names both the active participant (its destination) and the in-flight operation; resolving its label through the tier resolver localizes the line and lets the tier toggle swap its voice without touching the model. A terminal run status short-circuits to a fixed completion line so a finished run reads as finished regardless of a lingering return leg.
//
// A call has two phases the caption distinguishes: the transit phase (lifecycle in_flight, the line animates) reads "A is calling B…" via the operation label; the working phase (lifecycle settled, the line goes solid because B has started producing) reads "B is planning…" via the working label of the destination — the relationship is no longer the story, B's own work is. When no working label is configured for the destination, the working phase falls back to the operation label so a minimal guild never crashes. An in-flight call appends an ellipsis to convey an action in progress; a settled return (the lingering response leg) carries no ellipsis because the leg is the current state, not a pending action.
export function deriveNowCaption(model: InteractionModel, labels: LabelResolver, tier: LabelTier): string {
	const status = model.status
	if (status === 'success') return 'Done.'
	if (status === 'error') return 'The run stopped with an error.'
	if (status === 'interrupted') return 'The run was interrupted.'
	if (status === 'needs_clarification') return 'Waiting for your input…'
	const operation = activeOperation(model)
	if (operation === null) return 'Working…'
	const participantsById = new Map<string, Participant>()
	for (const participant of model.participants) participantsById.set(participant.id, participant)
	// A settled call is the working phase: the destination has started its own work, so the caption names what the destination is doing (e.g. "Planning the approach…") rather than the call relationship ("Orchestrator is calling Planner"). The working label is optional per participant; when absent the caption falls back to the operation label so a guild without working labels still renders a caption. The seed is the operation id's hash so the whimsical tier rotates between operations while staying fixed within one, and the working phase reuses the call's seed so transit and working of the same call land on the same whimsical phrase.
	const seed = labels.hashString(operation.id)
	if (operation.kind === 'call' && operation.lifecycle === 'settled' && typeof labels.resolveWorkingLabel === 'function') {
		const destination = participantsById.get(operation.destination)
		if (destination !== undefined) {
			const working = labels.resolveWorkingLabel(destination, tier, seed)
			if (working !== null) return `${working}…`
		}
	}
	const label = labels.resolveOperationLabel(operation, participantsById, tier, seed)
	if (operation.lifecycle === 'in_flight') return `${label}…`
	return label
}

// Aggregates per-operation metrics into the ambient cost strip's values. Tokens are summed across every call that carries them (cumulative spend across the whole run); elapsed is the latest non-null elapsedSeconds — the most recent call's reported elapsed, so a call whose elapsed has not been filled (an open call on a model the caller has not run through withLiveElapsed) falls back to the last call that reported one rather than reading as zero. Returns plain numbers so the harness formats them as textContent; no prose lives here. Operations without metrics or with null fields contribute nothing, and the call-kind guard below keeps the calls-only contract structural: returns carry no metrics (see callMetricsByDestination), so a producer that ever attached some would double count a call against its return.
export function deriveCostStrip(model: InteractionModel): CostStrip {
	const derived = derivedOf(model)
	if (derived.costStrip !== undefined) return derived.costStrip
	let tokens = 0
	let elapsedSeconds = 0
	let foundElapsed = false
	for (let index = model.operations.length - 1; index >= 0; index -= 1) {
		const operation = model.operations[index]
		if (operation === undefined) continue
		if (operation.kind !== 'call') continue
		if (operation.metrics === null) continue
		if (operation.metrics.tokens !== null) tokens += operation.metrics.tokens
		if (!foundElapsed && operation.metrics.elapsedSeconds !== null) {
			elapsedSeconds = operation.metrics.elapsedSeconds
			foundElapsed = true
		}
	}
	const strip: CostStrip = { elapsedSeconds, tokens }
	derived.costStrip = strip
	return strip
}
