// SVG primitives for the flow and sequence views, browser-pure.
//
// Each primitive is a self-contained vnode laid out against its own local origin (0,0); the caller applies the translate and the primitive never hardcodes an absolute position, so moving a composed node is a one-number change to its translate.
//
// Colors reuse the project's --svg-* tokens via the existing graph-node and graph-edge CSS classes declared in styles.css, so the views follow the light/dark theme without adding CSS in this layer. Machine fields (labels, counters, costs) are SVG <text> textContent, never markup, so the textContent security invariant holds. No motion classes are emitted here: call and return edges render as settled strokes and the observe line is a distinct dashed static style; the flowing/returning motion classes are layered on top of these primitives by the animation layer, never by the primitives themselves.
//
// `h` is passed in rather than imported so the module stays free of hyperapp coupling and the vnode shape is exercisable in tests with a fake `h`. The module is plain browser JS, imports nothing, and touches no external system.

export const NODE_WIDTH = 160
export const NODE_HEIGHT = 64

// Returns the anchor point of a node positioned at (x, y) on the requested side. Edges are a separate layer that reads these anchors, so a node and its connecting edge stay aligned through one source of truth.
export function nodeAnchor(x, y, side) {
	switch (side) {
		case 'top':
			return { x: x + NODE_WIDTH / 2, y }
		case 'bottom':
			return { x: x + NODE_WIDTH / 2, y: y + NODE_HEIGHT }
		case 'left':
			return { x, y: y + NODE_HEIGHT / 2 }
		case 'right':
			return { x: x + NODE_WIDTH, y: y + NODE_HEIGHT / 2 }
		default:
			return { x: x + NODE_WIDTH / 2, y: y + NODE_HEIGHT / 2 }
	}
}

// A graph node: a <g> with its box, a centered label, an optional sublabel, an optional invocation counter badge, and an optional cost line. status ('success' | 'error') applies the existing static stroke classes so a settled node's outcome reads at a glance; active (the destination of the latest operation in the active stack) applies the pulsing stroke class so the eye lands on the current-flow recipient. A 'terminated' return outcome does NOT color the node — the node was killed externally (it did not succeed or fail), so the warn-toned rendering lives on the return line only, and the orange border comes exclusively from a terminate op targeting the node (flow-node--terminate-target). Internal layout only; the caller applies the translate.
export function GraphNode(h, props) {
	const label = props.label
	const sublabel = props.sublabel
	const counter = props.counter
	const costTime = props.costTime
	const costTokens = props.costTokens
	const status = props.status
	const active = props.active === true

	const classes = ['graph-node']
	if (active) classes.push('graph-node--active')
	if (status === 'success') classes.push('graph-node--success')
	if (status === 'error') classes.push('graph-node--error')

	const children = [
		h('rect', { class: 'graph-node-box', x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT, rx: 8 }, []),
		h('text', { class: 'graph-node-label', x: NODE_WIDTH / 2, y: 26, 'text-anchor': 'middle' }, [label]),
	]

	if (sublabel !== undefined && sublabel !== null && sublabel !== '') {
		children.push(h('text', { class: 'graph-node-sublabel', x: NODE_WIDTH / 2, y: 44, 'text-anchor': 'middle' }, [sublabel]))
	}

	if (counter !== undefined && counter !== null) {
		children.push(h('rect', { class: 'graph-node-counter-rect', x: NODE_WIDTH - 30, y: 6, width: 22, height: 16, rx: 8 }, []))
		children.push(h('text', { class: 'graph-node-counter-text', x: NODE_WIDTH - 19, y: 17, 'text-anchor': 'middle' }, [String(counter)]))
	}

	const costText = formatCost(costTime, costTokens)
	if (costText !== null) {
		children.push(h('text', { class: 'graph-node-cost', x: NODE_WIDTH / 2, y: NODE_HEIGHT - 6, 'text-anchor': 'middle' }, [costText]))
	}

	return h('g', { class: classes.join(' ') }, children)
}

function formatCost(costTime, costTokens) {
	const parts = []
	if (costTime !== undefined && costTime !== null) parts.push(`${costTime}s`)
	if (costTokens !== undefined && costTokens !== null) parts.push(`${formatTokens(costTokens)} tok`)
	if (parts.length === 0) return null
	return parts.join(' \u00b7 ')
}

function formatTokens(value) {
	if (value >= 1000) return `${Math.round(value / 100) / 10}k`
	return String(value)
}

// A graph edge: a <path> between two face anchors, shaped by kind. A call bows horizontally between the side faces (caller right → callee left); a return bows downward between the bottom faces so the response leg sits below the forward call line and never overlaps it; an observe is a vertical line drawn dashed so a cross-stack observation reads as a static reference rather than an in-flight call. A terminate shares the observe's sideways-bowed cross-stack geometry; its red dashed stroke is applied by the flow view's CSS (the wrapper carries flow-edge--terminate), so the primitive carries no terminate-specific styling of its own. The state prop ('flowing' | 'returning' | 'error' | 'static') layers the matching motion class onto the path so the CSS drives the marching-ants animation; the primitive carries no animation logic of its own.
export function GraphEdge(h, props) {
	const fromAnchor = props.fromAnchor
	const toAnchor = props.toAnchor
	const kind = props.kind
	const state = props.state

	const classes = ['graph-edge']
	if (state === 'flowing') classes.push('graph-edge--flowing')
	else if (state === 'returning') classes.push('graph-edge--returning')
	else if (state === 'error') classes.push('graph-edge--error')
	else if (state === 'terminated') classes.push('graph-edge--terminated')

	const pathProps = { class: classes.join(' '), d: edgePath(fromAnchor, toAnchor, kind) }
	if (kind === 'observe' || kind === 'inquiry') pathProps['stroke-dasharray'] = '3 3'
	return h('path', pathProps, [])
}

// A gentle cubic curve between the anchors so sibling edges separate rather than overlap. Calls bow horizontally to keep the left-to-right chain readable; returns bow downward so the response leg curves below the nodes and never paints over the forward call line; observes, terminates, and inquiries bow slightly sideways so two stacked cross-stack lines don't sit on top of each other.
function edgePath(from, to, kind) {
	if (kind === 'return') {
		const bow = 40
		return `M ${from.x} ${from.y} C ${from.x} ${from.y + bow}, ${to.x} ${to.y + bow}, ${to.x} ${to.y}`
	}
	if (kind === 'observe' || kind === 'terminate' || kind === 'inquiry') {
		const bow = 16
		return `M ${from.x} ${from.y} C ${from.x + bow} ${from.y}, ${to.x + bow} ${to.y}, ${to.x} ${to.y}`
	}
	const dx = to.x - from.x
	const bow = dx * 0.2
	return `M ${from.x} ${from.y} C ${from.x + bow} ${from.y}, ${to.x - bow} ${to.y}, ${to.x} ${to.y}`
}

// A loopback edge for a same-column cross-instance call: two participants at the same call depth (a role re-invoked at its own column, or a self-delegation) connect via a U-turn on the right side rather than a straight line that would overlap the column's other edges. Shared with the sequence view, which lays same-column messages the same way.
//
// `markerEnd` and `extraClass` let the sequence view attach an arrowhead and its own message classes (seq-message, seq-message--return, …) onto the same shared path so the U-turn geometry stays defined in one place. Both are optional; the flow view omits them and the path renders as a plain graph-edge stroke.
export function LoopbackEdge(h, props) {
	const fromAnchor = props.fromAnchor
	const toAnchor = props.toAnchor
	const markerEnd = props.markerEnd
	const extraClass = props.extraClass
	const bow = 60
	const x = Math.max(fromAnchor.x, toAnchor.x) + bow
	const d = `M ${fromAnchor.x} ${fromAnchor.y} C ${x} ${fromAnchor.y}, ${x} ${toAnchor.y}, ${toAnchor.x} ${toAnchor.y}`
	const classValue = extraClass !== undefined && extraClass !== '' ? `graph-edge ${extraClass}` : 'graph-edge'
	const pathProps = { class: classValue, d }
	if (markerEnd !== undefined && markerEnd !== null) pathProps['marker-end'] = markerEnd
	return h('path', pathProps, [])
}
