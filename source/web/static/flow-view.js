// Flow-graph run view renderer.
//
// This module is a pure renderer: it consumes a FlowModel (the shape the future /api/runs/:id/flow endpoint will return) and turns it into a two-component hyperapp vnode tree — a history top bar (small nodes, cumulative stats, one per role-type/tool-type/"You" that has ever run) and a main area (active + lingering nodes laid out left-to-right by call depth, with call/return/question edges between them). It performs no derivation: the model is built elsewhere (hand-authored fixtures today, server-side from the full log in a later step), so the view stays a thin, testable rendering layer.
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

// The anchor pair for an edge given the source and target pixel positions and the edge kind. Call and question edges flow left→right (out the source's right face, in the target's left face); return edges flow right→left (out the source's left face, in the target's right face). Face selection alone conveys direction; the edge state is static this step.
function edgeAnchors(kind, fromPos, toPos) {
	if (kind === 'return') {
		return { fromAnchor: nodeAnchor(fromPos.x, fromPos.y, 'left'), toAnchor: nodeAnchor(toPos.x, toPos.y, 'right') }
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

// A compact top-bar node: a small square holding just its invocation count, centered. Status (success/error/interrupted) re-strokes the box via class hooks so a failed role's history slot reads at a glance. The role/tool name and cumulative token/time details are carried by a <title> child so they surface on hover without claiming layout space. The group carries both the class and the translate so there is a single wrapping <g> per node.
function SmallNode(h, props) {
	const label = props.label
	const invocations = props.invocations
	const status = props.status
	const totalTime = props.totalTime
	const totalTokens = props.totalTokens
	const x = props.x
	const y = props.y

	const classes = ['flow-small-node']
	if (status === 'success') classes.push('flow-small-node--success')
	if (status === 'error') classes.push('flow-small-node--error')
	if (status === 'interrupted') classes.push('flow-small-node--interrupted')

	return h('g', { class: classes.join(' '), transform: translate(x, y) }, [
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

function renderMainArea(h, mainArea, minColumns) {
	const nodes = mainArea.nodes
	const edges = mainArea.edges

	const positions = new Map()
	let maxColumn = 0
	let maxRow = 0
	for (const node of nodes) {
		const pos = mainAreaPixel(node.column, node.row)
		positions.set(node.id, pos)
		if (node.column > maxColumn) maxColumn = node.column
		if (node.row > maxRow) maxRow = node.row
	}

	// The canvas width follows the largest of the hard 5-column floor, the caller's high-water mark, and the laid-out content. The high-water (minColumns) carries the most columns the run has needed up to this point in its timeline, so a layer that appeared and then finished does not shrink the canvas back — expansion is one-way, preventing thrash on the last layer. The floor is clamped here rather than trusted from the caller so the "at least 5 columns" invariant holds regardless of what is passed. Nodes position at their actual columns, so a short chain sits left-aligned in the pre-sized canvas and existing nodes keep their pixel positions as the chain grows.
	const columnCount = Math.max(DEFAULT_MIN_COLUMNS, minColumns, maxColumn + 1)
	const width = columnCount * NODE_WIDTH + (columnCount - 1) * COL_GAP
	const height = (maxRow + 1) * NODE_HEIGHT + maxRow * ROW_GAP

	const edgeVnodes = edges.map((edge) => {
		const fromPos = positions.get(edge.from)
		const toPos = positions.get(edge.to)
		if (fromPos === undefined || toPos === undefined) return null
		const { fromAnchor, toAnchor } = edgeAnchors(edge.kind, fromPos, toPos)
		return GraphEdge(h, { fromAnchor, toAnchor, state: 'static' })
	}).filter((vnode) => vnode !== null)

	const nodeVnodes = nodes.map((node) => {
		const pos = mainAreaPixel(node.column, node.row)
		return h('g', { transform: translate(pos.x, pos.y) }, [
			GraphNode(h, {
				label: node.label,
				sublabel: node.sublabel,
				status: node.status,
				active: node.active,
				counter: node.counter,
				costTime: node.costTime,
				costTokens: node.costTokens,
			}),
		])
	})

	return h('svg', { class: 'flow-main-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet', xmlns: 'http://www.w3.org/2000/svg' }, [
		...edgeVnodes,
		...nodeVnodes,
	])
}

// Renders the top bar as an SVG of small nodes wrapped into rows. The viewBox is sized to the wrapped grid so the strip stays a compact header above the main area.
function renderTopBar(h, topBar) {
	const nodes = topBar.nodes
	const count = nodes.length
	if (count === 0) {
		return h('svg', { class: 'flow-topbar-svg', viewBox: '0 0 0 0', preserveAspectRatio: 'xMidYMid meet', xmlns: 'http://www.w3.org/2000/svg' }, [])
	}
	const rows = Math.ceil(count / TOP_BAR_PER_ROW)
	const width = (TOP_BAR_PER_ROW * SMALL_SIZE) + (TOP_BAR_PER_ROW - 1) * SMALL_GAP
	const height = (rows * SMALL_SIZE) + (rows - 1) * SMALL_GAP

	const nodeVnodes = nodes.map((node, index) => {
		const pos = topBarPixel(index)
		return SmallNode(h, { label: node.label, invocations: node.invocations, status: node.status, totalTime: node.totalTime, totalTokens: node.totalTokens, x: pos.x, y: pos.y })
	})

	// The viewBox width follows the full row capacity so wrapped rows align in a stable grid rather than shrinking to a short final row; this keeps the strip's right edge steady as history grows.
	return h('svg', { class: 'flow-topbar-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMin meet', xmlns: 'http://www.w3.org/2000/svg' }, nodeVnodes)
}

// Renders the full two-component flow view: the history top bar above, the active-flow main area below. `minColumns` floors the main-area canvas width (default 5) and is intended to carry the caller's high-water mark so the canvas expands for a deep chain but does not contract when that chain's last layer finishes — see DEFAULT_MIN_COLUMNS. The caller places the returned <div>; the two SVGs size themselves to their content and fit within the container via preserveAspectRatio.
export function renderFlowView(h, model, minColumns = DEFAULT_MIN_COLUMNS) {
	return h('div', { class: 'flow-view' }, [
		renderTopBar(h, model.topBar),
		renderMainArea(h, model.mainArea, minColumns),
	])
}

// Exported for tests so the layout constants and wrapping rule are pinned alongside the renderer.
export const FLOW_VIEW_CONSTANTS = { NODE_WIDTH, NODE_HEIGHT, COL_GAP, ROW_GAP, SMALL_SIZE, SMALL_GAP, TOP_BAR_PER_ROW, DEFAULT_MIN_COLUMNS }
