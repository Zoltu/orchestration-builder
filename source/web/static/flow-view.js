// Flow-graph run view renderer.
//
// This module is a pure renderer: it consumes a FlowModel (the shape the future /api/runs/:id/flow endpoint will return) and turns it into a two-component hyperapp vnode tree — a history top bar (small nodes, cumulative stats, one per role-type/tool-type/"You" that has ever run) and a main area (active + lingering nodes laid out left-to-right by call depth, with call/return/question edges between them). The model's structure (which nodes/edges exist, which node is active) is built elsewhere (hand-authored fixtures today, server-side from the full log in a later step); this module derives only the per-edge animation state and the frame-diff node lifecycle from that model, so the view stays a thin, testable rendering layer.
//
// The model is current-state, not history: the main area holds only the active call-stack chain plus lingering response legs (a finished child or in-flight tool whose caller has not yet acted), so it stays calm regardless of run length. "Backwards always means return": a repeated role is a new node at the next column (a forward call edge), and the only right-to-left movement is a return edge from a finished child back to its caller.
//
// `h` is passed in rather than imported so the module stays free of hyperapp coupling and the vnode shape is exercisable in tests with a fake `h` (mirroring markdown.js / svg-primitives.js). The primitives take already-safe strings as props — machine fields and trusted guild labels become SVG <text> textContent, never markup — so the textContent security invariant holds. No agent-authored prose is rendered by the view.
//
// The module is plain browser JS (a sibling of app.js, served statically and imported by the playback harness) and is exercised in-memory by flow-view.test.ts. It imports only its sibling svg-primitives.js (also browser-pure), reusing GraphNode/GraphEdge/nodeAnchor so the node and edge visuals stay single-source.

import { GraphEdge, GraphNode, NODE_HEIGHT, NODE_WIDTH, nodeAnchor } from './svg-primitives.js'

// Horizontal gap between call-depth columns and vertical gap between rows in the main area. Generous horizontal spacing keeps the left-to-right call chain legible; the vertical gap separates interrupt-started rows.
export const COL_GAP = 96
export const ROW_GAP = 104

// Top-bar small-node dimensions and wrapping. Each history slot is a small square holding just its invocation count — the role/tool name and cumulative token/time details are reached via the native SVG <title> hover, so a long run's history stays a compact strip. They wrap into rows so a large guild's many role/tool types never overflow horizontally.
const SMALL_SIZE = 28
const SMALL_GAP = 8
const TOP_BAR_PER_ROW = 14

// Vertical gap between the history top bar and the main area inside the shared flow SVG. The two live in one SVG (so a departing node can travel from its main-area position to its top-bar slot in a shared coordinate space — the counter increment is the whole point of the depart animation), and this gap keeps the strip visually separate from the active chain.
const TOPBAR_GAP = 24

// Maps a main-area (column, row) to a pixel translate. Nodes root at the viewBox edges (0-based); the container's padding + overflow:visible keeps them off the screen and paints edge-centered strokes that would otherwise clip, so no margin is baked into the coordinate space.
function mainAreaPixel(column, row) {
	return { x: column * (NODE_WIDTH + COL_GAP), y: row * (NODE_HEIGHT + ROW_GAP) }
}

// Maps a top-bar slot index to a pixel translate, wrapping into rows of TOP_BAR_PER_ROW.
function topBarPixel(index) {
	const row = Math.floor(index / TOP_BAR_PER_ROW)
	const col = index % TOP_BAR_PER_ROW
	return { x: col * (SMALL_SIZE + SMALL_GAP), y: row * (SMALL_SIZE + SMALL_GAP) }
}

// A stable key for matching a main-area node to its cumulative top-bar slot across frames: kind + label. Main-area invocation ids distinguish repeated calls of one role (`coder-1`, `coder-2`) while the top bar carries one slot per role/tool type (`coder`), so the id is not a reliable match; the friendly label plus kind is unique per type within a guild.
function slotKey(node) {
	return `${node.kind}|${node.label}`
}

// Computes the per-edge animation state and the active (pulsing) node set from a FlowModel. The state is derived from the model rather than the log because the model already encodes turn progress in fields the backend derivation will populate: a role node's `costTokens` is set only after its first `llm_call`, and a finished node carries a `return` edge back to its caller. Reading these from the model keeps the renderer self-contained and avoids reconstructing turn state from a truncated `recentLog` window (the client never sees the full log) — the server-side FlowModel derivation is the authoritative place that maps log events to these fields.
//
// The active (pulsing) node is the **recipient of the current flow** — the target of whatever edge is currently moving. This makes "who is active" read directly off the lines: a call edge flowing agent→tool makes the tool pulse (the tool is the operation in flight); a return edge flowing tool→agent makes the agent pulse (the agent is now processing the result); an error return makes its caller pulse (the caller is receiving the failure); a question edge makes the You respondent pulse. A role that is mid-thought (has started but has no in-flight outgoing edge and no incoming return yet) has no moving edge, so it carries an explicit `active` flag in the model; those flagged nodes are unioned in so a thinking role still pulses.
//
// Edge state semantics:
// - `'call'` to a role/`you` target: `flowing` while the child has not produced its first turn (no `costTokens` yet), then `static` once the first `llm_call` has landed and the flow has moved to the child's outgoing edge. `static` also when the target has already finished and lingers via its own `return` edge (the call is settled; the return leg carries the motion).
// - `'call'` to a tool target: `flowing` while the tool call is in flight. A `tool_result` would produce a `return` edge from the tool, so the absence of such a return edge means the call is still in flight.
// - `'call'` to an ask_human tool that has already emitted its question (it carries an outgoing `question` edge): `static` — the tool has transitioned from "in flight" to "waiting for the user's answer", so the active flow is the question edge itself, toward the You respondent.
// - `'return'`: `returning` (the lingering response leg flows right→left), or `error` when the returning node errored so the failure reads in red.
// - `'question'`: `flowing` toward the "You" node. A question edge only exists while the question is pending; once the user answers, the leg becomes a `return` edge back to the asking agent, so any present `question` edge is in flight.
// - `'inspect'`: `static` (an observation reference, not an in-flight call or return).
export function deriveFlowAnimation(model) {
	const edgeStates = deriveEdgeStates(model.mainArea)
	const activeIds = new Set()
	// A node explicitly marked active (mid-thought: a role that has started but has no in-flight outgoing edge and no incoming return yet) pulses. The flagged-thinking states are unioned with the edge-derived recipients below.
	for (const node of model.mainArea.nodes) {
		if (node.active === true) activeIds.add(node.id)
	}
	// The target of any non-static edge is the current-flow recipient and pulses: a call's target while the call is in flight, a return's target (the caller receiving the result), a question's respondent, an error return's caller receiving the failure.
	model.mainArea.edges.forEach((edge, index) => {
		const state = edgeStates[index]
		if (state === 'flowing' || state === 'returning' || state === 'error') {
			activeIds.add(edge.to)
		}
	})
	return { edgeStates, activeIds }
}

// The edge-state derivation needs only the main area; isolating it lets the renderer derive edge states from the slice it has without fabricating a top bar.
function deriveEdgeStates(mainArea) {
	const nodes = mainArea.nodes
	const edges = mainArea.edges
	const nodeById = new Map()
	for (const node of nodes) nodeById.set(node.id, node)
	const returnSources = new Set()
	const questionSources = new Set()
	for (const edge of edges) {
		if (edge.kind === 'return') returnSources.add(edge.from)
		else if (edge.kind === 'question') questionSources.add(edge.from)
	}
	return edges.map((edge) => edgeAnimationState(edge, nodeById, returnSources, questionSources))
}

function edgeAnimationState(edge, nodeById, returnSources, questionSources) {
	if (edge.kind === 'return') {
		const source = nodeById.get(edge.from)
		if (source !== undefined && source.status === 'error') return 'error'
		return 'returning'
	}
	if (edge.kind === 'question') {
		return 'flowing'
	}
	// An inspect edge is an observation reference (one role reading another's history), not an in-flight call or return; it renders as a static line so it never competes with the active flow.
	if (edge.kind === 'inspect') {
		return 'static'
	}
	// edge.kind === 'call'
	const target = nodeById.get(edge.to)
	if (target === undefined) return 'static'
	if (returnSources.has(target.id)) return 'static'
	// A call to an ask_human tool that has already emitted its question (it carries an outgoing question edge) is settled: the tool has transitioned from "in flight" to "waiting for the user's answer", so the call edge no longer flows. The active flow is the question edge itself, toward the You respondent.
	if (questionSources.has(target.id)) return 'static'
	if (target.kind === 'tool') return 'flowing'
	// A role/'you' target: costTokens is populated only after the first llm_call, so its absence means the call is still in flight.
	if (target.costTokens === undefined) return 'flowing'
	return 'static'
}

// Diffs two consecutive frames' FlowModels into a node-lifecycle descriptor: which main-area nodes are newly arrived (`entering`) and which left the main area for the top bar (`departing`). Entering nodes get a scale/fade-in; a departing node travels from its previous main-area position to its type's top-bar slot (both in the shared flow-SVG coordinate space, so the travel lands on the slot and reads as the counter incrementing), merging into the slot if the slot already existed last frame (the counter increments) or settling a new slot otherwise. The first frame of a scenario has no previous frame, so nothing enters or departs — the graph renders settled rather than every node fading in on each scenario select.
export function deriveLifecycle(previousModel, currentModel) {
	const enteringIds = new Set()
	const departing = []
	if (previousModel === undefined || previousModel === null) {
		return { enteringIds, departing }
	}
	const previousMainIds = new Set(previousModel.mainArea.nodes.map((node) => node.id))
	const currentMainIds = new Set(currentModel.mainArea.nodes.map((node) => node.id))
	for (const node of currentModel.mainArea.nodes) {
		if (!previousMainIds.has(node.id)) enteringIds.add(node.id)
	}
	const currentSlotIndex = new Map()
	currentModel.topBar.nodes.forEach((slot, index) => currentSlotIndex.set(slotKey(slot), index))
	const previousSlotKeys = new Set(previousModel.topBar.nodes.map(slotKey))
	for (const node of previousModel.mainArea.nodes) {
		if (currentMainIds.has(node.id)) continue
		const slotIndex = currentSlotIndex.get(slotKey(node))
		// Only nodes that actually reached the top bar depart; a node with no current slot did not transition and is not animated.
		if (slotIndex === undefined) continue
		const merged = previousSlotKeys.has(slotKey(node))
		// The previous-frame node carries the column/row the renderer needs to place the depart origin; slotIndex places the destination on the top bar.
		departing.push({ node, slotIndex, merged })
	}
	return { enteringIds, departing }
}

// The anchor pair for an edge given the source and target pixel positions and the edge kind. Call and question edges flow left→right (out the source's right face, in the target's left face); return edges route along the bottom faces so the response leg sits below the forward call line rather than overlapping it (the downward bow in svg-primitives' edgePath carries it under the nodes); inspect edges route source-top → target-bottom so a vertical inspection line reads as one node looking at another below/above it. Face selection conveys direction; the marching-ants animation direction is set by the edge state class applied by the caller.
function edgeAnchors(kind, fromPos, toPos) {
	if (kind === 'return') {
		return { fromAnchor: nodeAnchor(fromPos.x, fromPos.y, 'bottom'), toAnchor: nodeAnchor(toPos.x, toPos.y, 'bottom') }
	}
	if (kind === 'inspect') {
		return { fromAnchor: nodeAnchor(fromPos.x, fromPos.y, 'top'), toAnchor: nodeAnchor(toPos.x, toPos.y, 'bottom') }
	}
	return { fromAnchor: nodeAnchor(fromPos.x, fromPos.y, 'right'), toAnchor: nodeAnchor(toPos.x, toPos.y, 'left') }
}

// Builds the hover text for a top-bar node from its label and optional cumulative stats. The native SVG <title> element renders this as the browser's tooltip on hover, so the name and token/time detail are reachable without taking layout space in the strip. Each sentence stands on one line; the browser wraps the tooltip naturally.
function smallNodeTitle(label, invocations, totalTime, totalTokens) {
	const parts = [label, `${invocations} call${invocations === 1 ? '' : 's'}`]
	if (totalTime !== undefined) parts.push(`${totalTime}s`)
	if (totalTokens !== undefined) parts.push(`${totalTokens.toLocaleString()} tokens`)
	return parts.join(' \u00b7 ')
}

// A compact top-bar node: a small square holding just its invocation count, centered. The strip is cumulative/aggregate history (one slot per role/tool type, total invocations), so it carries no per-invocation status — a slot never turns red or green. The role/tool name and cumulative token/time details are carried by a <title> child so they surface on hover without claiming layout space. The group carries both the class and the translate so there is a single wrapping <g> per node.
function SmallNode(h, props) {
	const label = props.label
	const invocations = props.invocations
	const totalTime = props.totalTime
	const totalTokens = props.totalTokens
	const x = props.x
	const y = props.y

	return h('g', { class: 'flow-small-node', transform: translate(x, y) }, [
		h('title', {}, [smallNodeTitle(label, invocations, totalTime, totalTokens)]),
		h('rect', { class: 'flow-small-node-box', x: 0, y: 0, width: SMALL_SIZE, height: SMALL_SIZE, rx: 5 }, []),
		h('text', { class: 'flow-small-node-count', x: SMALL_SIZE / 2, y: SMALL_SIZE / 2 + 1, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, [String(invocations)]),
	])
}

function translate(x, y) {
	return `translate(${x},${y})`
}

// Renders the main area as an SVG: edges first (so node boxes paint over any anchor overlap), then nodes translated to their call-depth positions. The viewBox is sized to the laid-out content so preserveAspectRatio can fit it to the page.
// The default column floor for the main area. A typical run's active path is `You → Orchestrator → Planner → Agent → Tool` (5 columns), so the canvas is pre-sized to fit that width and a shorter chain sits left-aligned within it rather than the canvas snapping to a tight 2- or 3-column fit. This keeps the scale factor stable as the chain grows rightward, so existing nodes don't visibly rescale when a new layer appears.
export const DEFAULT_MIN_COLUMNS = 5

// The width the top bar occupies when it wraps: the full row capacity, so wrapped rows align in a stable grid rather than shrinking to a short final row (keeps the strip's right edge steady as history grows). With no slots the bar is zero-width.
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

// Renders the whole flow view as a single shared SVG containing the history top bar (small nodes at the top) and the active-flow main area (nodes/edges below, offset by the bar height plus a gap). Sharing one SVG is what makes the depart animation work: a node leaving the main area travels from its main-area position to its top-bar slot in the same coordinate space, so the travel lands on the slot and the counter increment reads as the node arriving. `minColumns` floors the main-area canvas width; `lifecycle` carries the frame-diff entering/departing descriptor (computed by `deriveLifecycle` from the previous and current frames' models); when omitted, no node enters or departs and every edge settles to the animation state derived from the model.
export function renderFlowView(h, model, minColumns = DEFAULT_MIN_COLUMNS, lifecycle) {
	const mainArea = model.mainArea
	const topBar = model.topBar
	const nodes = mainArea.nodes
	const edges = mainArea.edges
	const { edgeStates, activeIds } = deriveFlowAnimation(model)

	const tbCount = topBar.nodes.length
	const tbHeight = topBarHeight(tbCount)
	const mainYOffset = tbHeight + (tbCount === 0 ? 0 : TOPBAR_GAP)

	const positions = new Map()
	let maxColumn = 0
	let maxRow = 0
	for (const node of nodes) {
		const base = mainAreaPixel(node.column, node.row)
		positions.set(node.id, { x: base.x, y: base.y + mainYOffset })
		if (node.column > maxColumn) maxColumn = node.column
		if (node.row > maxRow) maxRow = node.row
	}

	// The canvas width follows the largest of the hard 5-column floor, the caller's high-water mark, the laid-out content, and the top-bar width (so the bar never clips). The high-water (minColumns) carries the most columns the run has needed up to this point in its timeline, so a layer that appeared and then finished does not shrink the canvas back — expansion is one-way, preventing thrash on the last layer. Nodes position at their actual columns, so a short chain sits left-aligned in the pre-sized canvas and existing nodes keep their pixel positions as the chain grows.
	const columnCount = Math.max(DEFAULT_MIN_COLUMNS, minColumns, maxColumn + 1)
	const mainWidth = columnCount * NODE_WIDTH + (columnCount - 1) * COL_GAP
	const mainHeight = (maxRow + 1) * NODE_HEIGHT + maxRow * ROW_GAP
	const width = Math.max(topBarWidth(tbCount), mainWidth)
	const height = tbHeight + (tbCount === 0 ? 0 : TOPBAR_GAP) + mainHeight

	const topBarVnodes = topBar.nodes.map((node, index) => {
		const pos = topBarPixel(index)
		return SmallNode(h, { label: node.label, invocations: node.invocations, totalTime: node.totalTime, totalTokens: node.totalTokens, x: pos.x, y: pos.y })
	})

	const edgeVnodes = edges.map((edge, index) => {
		const fromPos = positions.get(edge.from)
		const toPos = positions.get(edge.to)
		if (fromPos === undefined || toPos === undefined) return null
		const { fromAnchor, toAnchor } = edgeAnchors(edge.kind, fromPos, toPos)
		return GraphEdge(h, { fromAnchor, toAnchor, state: edgeStates[index] ?? 'static', kind: edge.kind })
	}).filter((vnode) => vnode !== null)

	const enteringIds = lifecycle !== undefined ? lifecycle.enteringIds : EMPTY_SET
	const nodeVnodes = nodes.map((node) => {
		const pos = positions.get(node.id)
		const inner = GraphNode(h, {
			label: node.label,
			sublabel: node.sublabel,
			status: node.status,
			active: activeIds.has(node.id),
			counter: node.counter,
			costTime: node.costTime,
			costTokens: node.costTokens,
		})
		if (enteringIds.has(node.id)) {
			return h('g', { class: 'flow-node flow-node--entering-host', transform: translate(pos.x, pos.y) }, [
				h('g', { class: 'flow-node--entering' }, [inner]),
			])
		}
		return h('g', { class: 'flow-node', transform: translate(pos.x, pos.y) }, [inner])
	})

	// Departing overlay nodes render last so the travel paints on top of the settled graph. The outer <g> CSS-animates a translate from the node's previous main-area position to its top-bar slot plus a fade (the from/to coordinates are passed as a style object — hyperapp routes `-`-prefixed keys through `setProperty`); the inner <g> scales the body down toward the small-node size. Because both positions live in the same SVG coordinate space, the node visibly travels to its slot and the counter increment reads as the node arriving.
	const departingVnodes = lifecycle !== undefined ? lifecycle.departing.map((entry) => {
		const fromBase = mainAreaPixel(entry.node.column, entry.node.row)
		const fromPos = { x: fromBase.x, y: fromBase.y + mainYOffset }
		const toPos = topBarPixel(entry.slotIndex)
		const style = { '--from-x': `${fromPos.x}px`, '--from-y': `${fromPos.y}px`, '--to-x': `${toPos.x}px`, '--to-y': `${toPos.y}px` }
		const classes = entry.merged ? 'flow-node flow-node--departing flow-node--merging' : 'flow-node flow-node--departing'
		return h('g', { class: classes, style }, [
			h('g', { class: 'flow-node--departing-scale' }, [
				GraphNode(h, {
					label: entry.node.label,
					sublabel: entry.node.sublabel,
					status: entry.node.status,
					counter: entry.node.counter,
					costTime: entry.node.costTime,
					costTokens: entry.node.costTokens,
				}),
			]),
		])
	}) : []

	return h('svg', { class: 'flow-view-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet', xmlns: 'http://www.w3.org/2000/svg' }, [
		...topBarVnodes,
		...edgeVnodes,
		...nodeVnodes,
		...departingVnodes,
	])
}

// A reusable empty set so the no-lifecycle path avoids allocating a Set per render.
const EMPTY_SET = new Set()

// Exported for tests so the layout constants and wrapping rule are pinned alongside the renderer.
export const FLOW_VIEW_CONSTANTS = { NODE_WIDTH, NODE_HEIGHT, COL_GAP, ROW_GAP, SMALL_SIZE, SMALL_GAP, TOP_BAR_PER_ROW, TOPBAR_GAP, DEFAULT_MIN_COLUMNS }
