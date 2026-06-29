// Reusable SVG primitives for the flow-graph run view.
//
// Each primitive is a self-contained vnode tree laid out against its own local origin (0,0): the graph layout assigns each node a translate, and the primitives never hardcode an absolute position or internal padding. Borders and padding live on the container (.graph in styles.css), not inside the SVG. Moving a composed node is therefore a one-number change to its translate and never touches the primitive's internals.
//
// `h` is passed in rather than imported so the module stays free of hyperapp coupling and the vnode shape is exercisable in tests with a fake `h` (mirroring markdown.js's htmlNodesToVnodes). The primitives take already-safe strings as props — machine fields (labels, counters, costs) become SVG <text> textContent, never markup — so the textContent security invariant holds. Agent-authored prose is not rendered by the primitives themselves; the tooltip body slot receives already-shaped children from the caller, and the friendly formatting of that body is a separate concern.
//
// The module is plain browser JS (a sibling of app.js, served statically and imported by the playback harness) and is exercised in-memory by svg-primitives.test.ts. It imports nothing and touches no external system.

export const NODE_WIDTH = 160
export const NODE_HEIGHT = 64

export const TOOLTIP_PADDING = 12
export const TOOLTIP_DEFAULT_WIDTH = 240
export const TOOLTIP_DEFAULT_HEIGHT = 120

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

// A graph node: a <g> containing its box, a centered label, an optional sublabel, an optional invocation counter badge, an optional cost line, and active/success/error visual states expressed as class hooks the CSS animates. Internal layout only; the caller applies the translate.
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

// A graph edge: a <path> between two anchors with a class hook per state. `static` is the calm resting edge; `flowing` and `returning` carry a marching-ants dash animation; `error` is a solid red stroke. The CSS reads the class to apply the animation, so the primitive carries no animation logic. `kind` ('call'|'return'|'question'|'inspect') selects the curve shape: calls and questions bow horizontally between the side faces; returns bow downward so the response leg sits below the request line rather than overlapping it; inspect edges (an observer tool reading another role's history) bow sideways so a vertical inspection line curves clear of the two nodes.
export function GraphEdge(h, props) {
	const fromAnchor = props.fromAnchor
	const toAnchor = props.toAnchor
	const state = props.state
	const kind = props.kind

	const classes = ['graph-edge']
	if (state === 'flowing') classes.push('graph-edge--flowing')
	else if (state === 'returning') classes.push('graph-edge--returning')
	else if (state === 'error') classes.push('graph-edge--error')

	return h('path', { class: classes.join(' '), d: edgePath(fromAnchor, toAnchor, kind) }, [])
}

// A gentle cubic curve between the anchors so sibling edges separate rather than overlapping. Calls and questions bow horizontally (keeps horizontal edges readable, leaves vertical edges straight). Returns bow downward so the response leg curves below the nodes and never paints over the forward call line. Inspect edges bow sideways so a vertical inspection line curves clear of the two nodes.
function edgePath(from, to, kind) {
	if (kind === 'return') {
		const bow = 40
		return `M ${from.x} ${from.y} C ${from.x} ${from.y + bow}, ${to.x} ${to.y + bow}, ${to.x} ${to.y}`
	}
	if (kind === 'inspect') {
		const bow = 24
		return `M ${from.x} ${from.y} C ${from.x - bow} ${from.y}, ${to.x - bow} ${to.y}, ${to.x} ${to.y}`
	}
	const dx = to.x - from.x
	const bow = dx * 0.2
	return `M ${from.x} ${from.y} C ${from.x + bow} ${from.y}, ${to.x - bow} ${to.y}, ${to.x} ${to.y}`
}

// A tooltip shell: a <g> with a background rect, a title, a body slot (the caller's already-shaped children), and an optional "copy raw" button. Positioning is decided by the caller via a translate; the shell itself lays out against local 0,0. Friendly formatting of the body is a separate concern; this delivers only the shell and the copy-button wiring.
export function TooltipShell(h, props) {
	const title = props.title
	const bodyChildren = Array.isArray(props.children) ? props.children : []
	const onCopyRaw = props.onCopyRaw
	const copyAvailable = props.copyAvailable === true
	const width = props.width ?? TOOLTIP_DEFAULT_WIDTH
	const height = props.height ?? TOOLTIP_DEFAULT_HEIGHT

	const elements = [
		h('rect', { class: 'graph-tooltip-rect', x: 0, y: 0, width, height, rx: 8 }, []),
		h('text', { class: 'graph-tooltip-title', x: TOOLTIP_PADDING, y: 22 }, [title]),
		h('g', { class: 'graph-tooltip-body', transform: `translate(${TOOLTIP_PADDING}, 36)` }, bodyChildren),
	]

	if (copyAvailable && onCopyRaw !== undefined) {
		elements.push(
			h('g', { class: 'graph-tooltip-copy', transform: `translate(${width - 88}, ${height - 28})`, onclick: onCopyRaw }, [
				h('rect', { class: 'graph-tooltip-button-rect', x: 0, y: 0, width: 76, height: 20, rx: 4 }, []),
				h('text', { class: 'graph-tooltip-button-text', x: 38, y: 14, 'text-anchor': 'middle' }, ['Copy raw']),
			]),
		)
	}

	return h('g', { class: 'graph-tooltip' }, elements)
}
