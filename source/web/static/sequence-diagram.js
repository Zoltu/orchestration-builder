// Sequence view renderer over an InteractionModel.
//
// The view is a temporal layout: one column per role (grouped from the model's participants — human always first, then interrupt on first use, then roles in first-appearance order, then a single shared "tools" column that every tool routes to), with each operation drawn as a horizontal message on a vertical time axis whose row index is the operation's position in the timeline. A call/return between two distinct columns is a straight arrow landing on a terminal node on the destination's lifeline; a same-role cross-instance call (source and destination resolve to the same column) is the LoopbackEdge U-turn from svg-primitives.js so the out/turn/back legs read on a new line rather than as a zero-length arrow. observe renders as a static dashed cross-column line with no arrowhead and no terminal node — it is a reference, never an in-flight call, so it never activates a lifeline. terminate renders the same way as a static red dashed line, plus a single orange dashed marker on the target's lifeline, so a destructive revert likewise never activates the target.
//
// Each operation is exactly one row, in chronological order, across every scenario — nothing is dropped or phantom. The model already encodes each operation's lifecycle and outcome, so the static layout reads them directly: a return carries a source node on the callee's lifeline with its outcome color (success/error/terminated) — mirroring the flow view, which colors the returning (callee) node — and a terminated return's source node and incoming arrow carry the distinct warn-toned treatment so a leg abandoned mid-rewind reads as neither success nor failure. The active participant and the in-flight line are read off the model by the animation layer; this module renders the settled structure and carries `data-operation` on every message group so the inspector can resolve an operation's details markdown from the model without the view re-deriving it.
//
// The module is an independent leaf over the model: it imports only its siblings (./primitives.js for LoopbackEdge, ./labels.js for the resolver) and touches no external system. It does not import the flow view — the two views are independent leaves over the same model and share no rendering code.
//
// `h` is passed in rather than imported so the module stays free of hyperapp coupling and the vnode shape is exercisable in tests with a fake `h`, mirroring the sibling flow-view.js convention. The label resolver is passed in alongside the selected tier so a caller can swap the resolver or tier without the view reaching for globals; node prose is localization, a view concern, and the model carries no prose.

import { activeOperation, activeStack } from './interaction-model.js'
import { LoopbackEdge } from './svg-primitives.js'

// Layout constants. Columns are evenly spaced on COLUMN_WIDTH centers; messages stack on ROW_HEIGHT centers below the header. The viewBox is sized to the laid-out content so the host container can scale it to fit its width and scroll vertically for long timelines.
export const COLUMN_WIDTH = 150
export const ROW_HEIGHT = 30
export const HEADER_HEIGHT = 44
export const LEFT_MARGIN = 24
export const RIGHT_MARGIN = 24
export const BOTTOM_MARGIN = 24

// Terminal-node geometry. Each call/return arrow lands on a small node on the destination column's lifeline — an activation marker big enough to host the hover inspector. It is centered on the column at the message's row.
export const TERMINAL_NODE_WIDTH = 18
export const TERMINAL_NODE_HEIGHT = 12

// The vertical span of a same-column loopback. A flat U-turn at a single y would read as a zero-length arrow, so the out leg leaves from above the row center and the return leg lands at the row center on a separate line.
const LOOPBACK_HEIGHT = 14

function columnXForIndex(index) {
	return LEFT_MARGIN + index * COLUMN_WIDTH
}

// Looks up a participant by id in the model. A missing id is a model contract violation (every operation endpoint must reference a known participant); failing fast surfaces it rather than rendering a message against undefined.
function requireParticipant(participantsById, participantId) {
	const found = participantsById.get(participantId)
	if (found === undefined) throw new Error(`operation references unknown participant id "${participantId}"`)
	return found
}

// Derives the column set: human always first, then interrupt (only once an Interrupt participant has appeared in the current frame — the first-use rule), then every role the guild defines in definition order, then a single shared "tools" column. A role invoked multiple times (instance-per-invocation retries) collapses to a single column keyed by role, which is what makes a same-role cross-instance call resolve to one column and render as a loopback. Every tool routes to the one "tools" column so the role chain stays focal and the tool inventory does not fan out across the diagram. `guildParticipants` (optional) supplies the full participant set the guild defines so every role column and the tools column appear from frame 0 rather than growing as participants first appear; when absent the column set falls back to the roles and tools present in the current frame.
function buildColumns(model, guildParticipants) {
	const source = guildParticipants ?? model.participants
	const roleColumns = []
	const seenRoles = new Set()
	let guildHasTool = false
	for (const participant of source) {
		if (participant.kind === 'role' && !seenRoles.has(participant.role)) {
			seenRoles.add(participant.role)
			roleColumns.push(participant.role)
		} else if (participant.kind === 'tool') {
			guildHasTool = true
		}
	}
	let hasInterrupt = false
	for (const participant of model.participants) {
		if (participant.kind === 'interrupt') {
			hasInterrupt = true
			break
		}
	}
	const columns = [{ role: 'human', kind: 'human' }]
	if (hasInterrupt) columns.push({ role: 'interrupt', kind: 'interrupt' })
	for (const role of roleColumns) columns.push({ role, kind: 'role' })
	if (guildHasTool) columns.push({ role: 'tools', kind: 'tool' })
	return columns
}

// Finds a representative participant of a column's role so the column header can resolve its localized label. Every role column is derived from the model's participants, so a representative always exists for a column the renderer built.
function representativeParticipant(model, role, kind) {
	for (const participant of model.participants) {
		if (participant.role === role && participant.kind === kind) return participant
	}
	return undefined
}

// Resolves a column's localized header label. Every role column is derived from the model's participants, so a representative participant exists to resolve against; the shared "tools" column has no single participant, so it resolves against a synthetic tools participant whose label entry gives the localized header.
function resolveColumnLabel(model, column, labels, tier) {
	if (column.role === 'tools') {
		return labels.resolveParticipantLabel({ id: 'tools', role: 'tools', kind: 'tool' }, tier)
	}
	const representative = representativeParticipant(model, column.role, column.kind)
	return representative !== undefined ? labels.resolveParticipantLabel(representative, tier) : column.role
}

// Resolves a participant to its column index. Tool-kind participants all route to the single shared "tools" column so the per-tool lifelines collapse to one; every other kind maps by its role.
function columnIndexForParticipant(participant, columnIndexByRole) {
	if (participant.kind === 'tool') return columnIndexByRole.get('tools') ?? 0
	return columnIndexByRole.get(participant.role) ?? 0
}

// The terminal-node state an operation's destination carries. A return carries its outcome (success/error/terminated); a call carries no outcome state in the settled layout (the active highlight is layered on by the animation layer).
function terminalState(operation) {
	if (operation.kind !== 'return') return null
	if (operation.outcome === 'success') return 'success'
	if (operation.outcome === 'error') return 'error'
	if (operation.outcome === 'terminated') return 'terminated'
	return null
}

// The motion state a message line carries under the single invariant. This mirrors the sibling flow-view.js `edgeAnimationState`: a line animates iff it is in_flight and its stack is the active stack — a call animates 'flowing' while in_flight (the transit phase) and goes solid once settled (the working phase); a return animates 'returning' (or 'error'/'terminated' for the matching outcome) only while in_flight (its transit phase) and goes solid once settled (its working phase, a leg abandoned mid-rewind still reading distinctly from both success and failure via its settled terminated class). The flow view encodes the same rule per-edge; the sequence view renders every operation as a row, so the guard here additionally requires the operation to be the active operation (the latest non-observe operation in the active stack) — earlier messages in the active stack are settled and stay solid. observe never reaches here (it renders its own static line). The two views therefore agree on "what is in flight right now" because both read it off the same activeOperation helper.
function messageAnimationState(operation, model, activeOperationId) {
	if (operation.kind === 'observe' || operation.kind === 'terminate') return 'static'
	if (operation.id !== activeOperationId) return 'static'
	if (operation.stack !== activeStack(model)) return 'static'
	if (operation.lifecycle === 'settled') return 'static'
	if (operation.kind === 'call') return 'flowing'
	if (operation.outcome === 'error') return 'error'
	if (operation.outcome === 'terminated') return 'terminated'
	return 'returning'
}

// The line class list for a message. Past (settled) calls are solid neutral; past returns are dashed neutral; a terminated return carries the warn-toned variant so an abandoned leg reads distinctly; observe carries its own static dashed variant and terminate carries a static red dashed variant. When the message is the active operation, the animation class (flowing/returning/error/terminated) replaces the settled modifier so the marching-ants stroke and color read on the in-flight line and do not clash with the settled dash variant. A terminated return that is the active operation carries the warn-toned marching variant, distinct from a green success march and a red error march.
function messageLineClass(operation, animationState) {
	const classes = ['seq-message']
	if (operation.kind === 'observe') {
		classes.push('seq-message--observe')
	} else if (operation.kind === 'terminate') {
		classes.push('seq-message--terminate')
	} else if (animationState === 'flowing') {
		classes.push('seq-message--flowing')
	} else if (animationState === 'returning') {
		classes.push('seq-message--returning')
	} else if (animationState === 'error') {
		classes.push('seq-message--error')
	} else if (animationState === 'terminated') {
		classes.push('seq-message--terminated-flowing')
	} else if (operation.kind === 'return') {
		if (operation.outcome === 'terminated') classes.push('seq-message--terminated')
		else classes.push('seq-message--return')
	}
	return classes.join(' ')
}

// The arrowhead marker id for a message. The active operation's arrowhead matches its line color so the head and the marching line read as one colored unit; a terminated return that is the active operation points to the warn-toned marching marker; a settled terminated return points to the static warn marker; every other settled call/return points to the neutral marker. observe carries no arrowhead — it is a reference, not a directed call.
function arrowheadId(operation, animationState) {
	if (animationState === 'flowing') return 'seq-arrow-flowing'
	if (animationState === 'returning') return 'seq-arrow-returning'
	if (animationState === 'error') return 'seq-arrow-error'
	if (animationState === 'terminated') return 'seq-arrow-terminated-flowing'
	if (operation.kind === 'return' && operation.outcome === 'terminated') return 'seq-arrow-terminated'
	return 'seq-arrow-neutral'
}

function arrowMarker(h, id, className) {
	return h('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto' }, [
		h('path', { class: `seq-arrowhead ${className}`, d: 'M 0 0 L 10 5 L 0 10 z' }, []),
	])
}

// A terminal node on a column's lifeline at a message row: a small rounded rect carrying a state class so a settled leg's outcome reads at a glance and the active operation's destination pulses. `end` distinguishes the destination node (where the arrow lands, which pulses when the operation is the active operation) from a return's source node (the callee, which carries the return's outcome color, mirroring the flow view where the returning node is the callee). `data-operation`, `data-node-end`, and `data-column-role` let the inspector locate a node by operation and assert which end and column it landed on.
function renderTerminalNode(h, x, y, state, operation, columnRole, end) {
	const rectX = x - TERMINAL_NODE_WIDTH / 2
	const classes = ['seq-node']
	if (state !== null) classes.push(`seq-node--${state}`)
	return h('g', { class: classes.join(' '), 'data-operation': operation.id, 'data-node-end': end, 'data-column-role': columnRole, 'data-state': state === null ? 'neutral' : state }, [
		h('rect', { class: 'seq-node-box', x: rectX, y: y - TERMINAL_NODE_HEIGHT / 2, width: TERMINAL_NODE_WIDTH, height: TERMINAL_NODE_HEIGHT, rx: 3 }, []),
	])
}

// The terminal-node state for the destination end of a message. A call's destination node is neutral in the settled layout and pulses only when it is the active operation (the active layer adds 'active'); a return's destination node likewise pulses when it is the active operation and is neutral otherwise, because the return's outcome color lives on the source (callee) node — the same split the flow view makes between a returning source node and its caller.
function destinationNodeState(operation, isActiveOperation) {
	if (isActiveOperation) return 'active'
	return null
}

// The terminal-node state for the source end of a message. Only a return carries a source node — its outcome (success/error/terminated) is a settled fact about the callee that just returned, so it reads on the callee's lifeline the way the flow view colors the returning node. A call has no source node (no outcome to carry), so this returns 'none' to signal the caller to skip the source node entirely.
function sourceNodeState(operation) {
	if (operation.kind !== 'return') return 'none'
	if (operation.outcome === 'success') return 'success'
	if (operation.outcome === 'error') return 'error'
	if (operation.outcome === 'terminated') return 'terminated'
	return null
}

// Renders the sequence view as a single SVG sized to its laid-out content. Columns render as headers plus dashed vertical lifelines spanning the message area; operations render top-to-bottom by index, each as a horizontal arrow (or a loopback U-turn for a same-role cross-instance call, or a static dashed line for observe) landing on a terminal node on the destination's lifeline. The active operation's line carries the flowing/returning/error animation class and its destination node pulses; a return additionally carries a source node on the callee's lifeline with its outcome color. Every message group carries `data-operation` so the inspector resolves the operation's details markdown and label from the model without the view re-deriving or embedding them. `guildParticipants` (optional) supplies the full participant set the guild defines so every role column and the tools column appear from frame 0 rather than growing as participants first appear; when absent the column set falls back to the participants present in the current frame.
export function renderSequenceView(h, model, labels, tier, guildParticipants) {
	const columns = buildColumns(model, guildParticipants)
	const columnIndexByRole = new Map()
	columns.forEach((column, index) => columnIndexByRole.set(column.role, index))

	const participantsById = new Map()
	for (const participant of model.participants) participantsById.set(participant.id, participant)

	const activeOperationId = activeOperation(model)?.id ?? null

	const operations = model.operations
	const messageAreaHeight = operations.length * ROW_HEIGHT
	const lifelineBottom = HEADER_HEIGHT + messageAreaHeight
	const lastColumnX = columns.length > 0 ? columnXForIndex(columns.length - 1) : LEFT_MARGIN
	const width = lastColumnX + RIGHT_MARGIN
	const height = HEADER_HEIGHT + messageAreaHeight + BOTTOM_MARGIN

	const defs = h('defs', {}, [
		arrowMarker(h, 'seq-arrow-neutral', 'seq-arrowhead--neutral'),
		arrowMarker(h, 'seq-arrow-flowing', 'seq-arrowhead--flowing'),
		arrowMarker(h, 'seq-arrow-returning', 'seq-arrowhead--returning'),
		arrowMarker(h, 'seq-arrow-error', 'seq-arrowhead--error'),
		arrowMarker(h, 'seq-arrow-terminated', 'seq-arrowhead--terminated'),
		arrowMarker(h, 'seq-arrow-terminated-flowing', 'seq-arrowhead--terminated-flowing'),
	])

	const columnGroups = columns.map((column, index) => {
		const x = columnXForIndex(index)
		const label = resolveColumnLabel(model, column, labels, tier)
		return h('g', { class: `seq-column seq-column--${column.kind}`, 'data-role': column.role, 'data-kind': column.kind }, [
			h('text', { class: 'seq-column-label', x, y: HEADER_HEIGHT - 14, 'text-anchor': 'middle' }, [label]),
			h('line', { class: 'seq-lifeline', x1: x, y1: HEADER_HEIGHT, x2: x, y2: lifelineBottom }, []),
		])
	})

	const messageGroups = operations.map((operation, index) => {
		const rowY = HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2
		const sourceParticipant = requireParticipant(participantsById, operation.source)
		const destinationParticipant = requireParticipant(participantsById, operation.destination)
		const sourceColumnIndex = columnIndexForParticipant(sourceParticipant, columnIndexByRole)
		const destinationColumnIndex = columnIndexForParticipant(destinationParticipant, columnIndexByRole)
		const sourceX = columnXForIndex(sourceColumnIndex)
		const destinationX = columnXForIndex(destinationColumnIndex)
		const sameColumn = sourceColumnIndex === destinationColumnIndex
		const label = labels.resolveOperationLabel(operation, model.participants, tier)
		const animationState = messageAnimationState(operation, model, activeOperationId)

		// observe renders as a static cross-column line — no arrowhead, no terminal node — so it reads as a reference rather than an in-flight call and never activates a lifeline.
		if (operation.kind === 'observe') {
			const d = `M ${sourceX} ${rowY} L ${destinationX} ${rowY}`
			const path = h('path', { class: messageLineClass(operation, animationState), d, 'data-source-role': sourceParticipant.role, 'data-destination-role': destinationParticipant.role }, [])
			return h('g', { class: 'seq-message-group', 'data-operation': operation.id, 'data-kind': 'observe', 'data-routing': 'observe', 'data-source-role': sourceParticipant.role, 'data-destination-role': destinationParticipant.role, 'data-animation': animationState }, [
				h('title', {}, [label]),
				path,
			])
		}

		// terminate renders as a static red dashed cross-column line — no arrowhead — with a single orange dashed marker on the target's lifeline rather than an activated terminal node, so a destructive revert reads as a reference rather than an in-flight call and never activates the target's lifeline.
		if (operation.kind === 'terminate') {
			const d = `M ${sourceX} ${rowY} L ${destinationX} ${rowY}`
			const path = h('path', { class: messageLineClass(operation, animationState), d, 'data-source-role': sourceParticipant.role, 'data-destination-role': destinationParticipant.role }, [])
			const targetNode = renderTerminalNode(h, destinationX, rowY, 'terminate-target', operation, destinationParticipant.role, 'destination')
			return h('g', { class: 'seq-message-group', 'data-operation': operation.id, 'data-kind': 'terminate', 'data-routing': 'terminate', 'data-source-role': sourceParticipant.role, 'data-destination-role': destinationParticipant.role, 'data-animation': animationState }, [
				h('title', {}, [label]),
				path,
				targetNode,
			])
		}

		const markerEnd = `url(#${arrowheadId(operation, animationState)})`
		let path
		if (sameColumn) {
			// A same-role cross-instance call connects two distinct participant instances that collapse to one column, so a straight arrow would be zero-length; the LoopbackEdge U-turn (out, turn, back on a new line) gives the interaction a visible leg. The out leg leaves from above the row center and the return leg lands at the row center on a separate line, with the arrowhead tucked into the terminal node.
			const fromAnchor = { x: sourceX, y: rowY - LOOPBACK_HEIGHT }
			const toAnchor = { x: destinationX, y: rowY }
			path = LoopbackEdge(h, { fromAnchor, toAnchor, markerEnd, extraClass: messageLineClass(operation, animationState) })
		} else {
			const nodeHalf = TERMINAL_NODE_WIDTH / 2
			const endX = sourceX < destinationX ? destinationX - nodeHalf : destinationX + nodeHalf
			const d = `M ${sourceX} ${rowY} L ${endX} ${rowY}`
			path = h('path', { class: messageLineClass(operation, animationState), d, 'marker-end': markerEnd }, [])
		}

		const isActiveOperation = operation.id === activeOperationId
		const destinationNode = renderTerminalNode(h, destinationX, rowY, destinationNodeState(operation, isActiveOperation), operation, destinationParticipant.role, 'destination')
		// A return carries a source node on the callee's lifeline with its outcome color; a call has no source node (no outcome to carry), so the destination node alone marks the landing.
		const sourceState = sourceNodeState(operation)
		const sourceNode = sourceState === 'none' ? null : renderTerminalNode(h, sourceX, rowY, sourceState === null ? null : sourceState, operation, sourceParticipant.role, 'source')
		const nodes = sourceNode === null ? [destinationNode] : [sourceNode, destinationNode]

		return h('g', {
			class: 'seq-message-group',
			'data-operation': operation.id,
			'data-kind': operation.kind,
			'data-routing': sameColumn ? 'loopback' : 'cross-column',
			'data-source-role': sourceParticipant.role,
			'data-destination-role': destinationParticipant.role,
			'data-animation': animationState,
		}, [
			h('title', {}, [label]),
			path,
			...nodes,
		])
	})

	return h('svg', { class: 'sequence-view-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet', xmlns: 'http://www.w3.org/2000/svg' }, [
		defs,
		h('g', { class: 'seq-columns' }, columnGroups),
		h('g', { class: 'seq-messages' }, messageGroups),
	])
}
