import { describe, expect, test } from 'bun:test'
import { GraphEdge, GraphNode, LoopbackEdge, NODE_HEIGHT, NODE_WIDTH, nodeAnchor } from './static/svg-primitives.js'
import { defined } from './test-fixtures.js'

// A fake `h` capturing the tag, props, and children of every vnode so the assertions walk a plain object tree rather than real DOM, mirroring the flow-view.test.ts convention.
interface Vnode {
	tag: string
	props: Record<string, unknown>
	children: VnodeChild[]
}
type VnodeChild = Vnode | string

function fakeH(tag: string, props: Record<string, unknown>, children: VnodeChild[]): Vnode {
	return { tag, props, children }
}

function isVnode(value: VnodeChild): value is Vnode {
	return typeof value !== 'string'
}

function propString(props: Record<string, unknown>, key: string): string | undefined {
	const value = props[key]
	return typeof value === 'string' ? value : undefined
}

function childrenByTag(vnode: Vnode, tag: string): Vnode[] {
	const found: Vnode[] = []
	for (const child of vnode.children) {
		if (!isVnode(child)) continue
		if (child.tag === tag) found.push(child)
	}
	return found
}

function childByClass(vnode: Vnode, tag: string, classToken: string): Vnode | undefined {
	return childrenByTag(vnode, tag).find((child) => (propString(child.props, 'class') ?? '').split(' ').includes(classToken))
}

function classTokens(vnode: Vnode): string[] {
	return (propString(vnode.props, 'class') ?? '').split(' ')
}

function graphNode(props: Record<string, unknown>): Vnode {
	return GraphNode(fakeH, props)
}

function graphEdge(props: Record<string, unknown>): Vnode {
	return GraphEdge(fakeH, props)
}

function loopbackEdge(props: Record<string, unknown>): Vnode {
	return LoopbackEdge(fakeH, props)
}

// The cost formatters are module-private, so their contract is asserted through the cost <text> line GraphNode emits (or omits).
function costTextOf(node: Vnode): string | undefined {
	const cost = childByClass(node, 'text', 'graph-node-cost')
	if (cost === undefined) return undefined
	return cost.children.join('')
}

describe('node dimensions', () => {
	test('the box is 160 wide and 64 tall, the numbers every anchor and layout constant derives from', () => {
		expect(NODE_WIDTH).toBe(160)
		expect(NODE_HEIGHT).toBe(64)
	})
})

describe('nodeAnchor', () => {
	const x = 100
	const y = 50

	test('the top and bottom anchors sit on the horizontal center at the node edge', () => {
		expect(nodeAnchor(x, y, 'top')).toEqual({ x: x + NODE_WIDTH / 2, y })
		expect(nodeAnchor(x, y, 'bottom')).toEqual({ x: x + NODE_WIDTH / 2, y: y + NODE_HEIGHT })
	})

	test('the left and right anchors sit on the vertical center at the node edge', () => {
		expect(nodeAnchor(x, y, 'left')).toEqual({ x, y: y + NODE_HEIGHT / 2 })
		expect(nodeAnchor(x, y, 'right')).toEqual({ x: x + NODE_WIDTH, y: y + NODE_HEIGHT / 2 })
	})

	test('an unrecognized side falls back to the box center', () => {
		expect(nodeAnchor(x, y, 'diagonal')).toEqual({ x: x + NODE_WIDTH / 2, y: y + NODE_HEIGHT / 2 })
	})
})

describe('GraphNode', () => {
	test('renders a group whose box rect spans the local origin and whose label is centered', () => {
		const node = graphNode({ label: 'coder' })
		expect(node.tag).toBe('g')
		expect(classTokens(node)).toEqual(['graph-node'])
		const box = defined(childByClass(node, 'rect', 'graph-node-box'), 'box')
		expect(box.props).toEqual({ class: 'graph-node-box', x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT, rx: 8 })
		const label = defined(childByClass(node, 'text', 'graph-node-label'), 'label')
		expect(label.props).toEqual({ class: 'graph-node-label', x: NODE_WIDTH / 2, y: 26, 'text-anchor': 'middle' })
		expect(label.children).toEqual(['coder'])
	})

	test('status applies its outcome class, and any other value stays a plain node', () => {
		expect(classTokens(graphNode({ label: 'n', status: 'success' }))).toEqual(['graph-node', 'graph-node--success'])
		expect(classTokens(graphNode({ label: 'n', status: 'error' }))).toEqual(['graph-node', 'graph-node--error'])
		// A 'terminated' return outcome deliberately colors no node: the warn tone lives on the return line only.
		expect(classTokens(graphNode({ label: 'n', status: 'terminated' }))).toEqual(['graph-node'])
	})

	test('the active class is applied only to a strictly-boolean true', () => {
		expect(classTokens(graphNode({ label: 'n', active: true }))).toEqual(['graph-node', 'graph-node--active'])
		expect(classTokens(graphNode({ label: 'n' }))).toEqual(['graph-node'])
		expect(classTokens(graphNode({ label: 'n', active: 'yes' }))).toEqual(['graph-node'])
	})

	test('a sublabel renders centered below the label, and absent, null, or empty sublabels render none', () => {
		const labeled = graphNode({ label: 'n', sublabel: 'role coder' })
		const sublabel = defined(childByClass(labeled, 'text', 'graph-node-sublabel'), 'sublabel')
		expect(sublabel.props).toEqual({ class: 'graph-node-sublabel', x: NODE_WIDTH / 2, y: 44, 'text-anchor': 'middle' })
		expect(sublabel.children).toEqual(['role coder'])
		for (const sublabel of [undefined, null, '']) {
			const bare = graphNode({ label: 'n', sublabel })
			expect(childByClass(bare, 'text', 'graph-node-sublabel')).toBeUndefined()
		}
	})

	test('a counter renders the badge rect and the stringified count, including a zero count', () => {
		const counted = graphNode({ label: 'n', counter: 3 })
		const rect = defined(childByClass(counted, 'rect', 'graph-node-counter-rect'), 'counter rect')
		expect(rect.props).toEqual({ class: 'graph-node-counter-rect', x: NODE_WIDTH - 30, y: 6, width: 22, height: 16, rx: 8 })
		const text = defined(childByClass(counted, 'text', 'graph-node-counter-text'), 'counter text')
		expect(text.props).toEqual({ class: 'graph-node-counter-text', x: NODE_WIDTH - 19, y: 17, 'text-anchor': 'middle' })
		expect(text.children).toEqual(['3'])
		expect(childByClass(graphNode({ label: 'n', counter: 0 }), 'text', 'graph-node-counter-text')?.children).toEqual(['0'])
	})

	test('an absent or null counter renders no badge', () => {
		for (const counter of [undefined, null]) {
			const bare = graphNode({ label: 'n', counter })
			expect(childByClass(bare, 'rect', 'graph-node-counter-rect')).toBeUndefined()
			expect(childByClass(bare, 'text', 'graph-node-counter-text')).toBeUndefined()
		}
	})
})

describe('GraphEdge', () => {
	const from = { x: 0, y: 0 }
	const to = { x: 200, y: 0 }

	test('a call edge bows horizontally between the side anchors', () => {
		const edge = graphEdge({ fromAnchor: from, toAnchor: to, kind: 'call' })
		expect(edge.tag).toBe('path')
		expect(classTokens(edge)).toEqual(['graph-edge'])
		expect(edge.props['d']).toBe(`M 0 0 C ${200 * 0.2} 0, ${200 - 200 * 0.2} 0, 200 0`)
		expect(edge.props['stroke-dasharray']).toBeUndefined()
		expect(edge.children).toEqual([])
	})

	test('a return edge bows downward so the response leg curves below the nodes', () => {
		const edge = graphEdge({ fromAnchor: from, toAnchor: to, kind: 'return' })
		expect(edge.props['d']).toBe('M 0 0 C 0 40, 200 40, 200 0')
	})

	test('an observe edge is a sideways-bowed dashed line', () => {
		const edge = graphEdge({ fromAnchor: from, toAnchor: to, kind: 'observe' })
		expect(edge.props['d']).toBe('M 0 0 C 16 0, 216 0, 200 0')
		expect(edge.props['stroke-dasharray']).toBe('3 3')
	})

	test('a terminate edge shares the observe geometry but carries no dash attribute of its own', () => {
		const edge = graphEdge({ fromAnchor: from, toAnchor: to, kind: 'terminate' })
		expect(edge.props['d']).toBe('M 0 0 C 16 0, 216 0, 200 0')
		expect(edge.props['stroke-dasharray']).toBeUndefined()
	})

	test('the state layers its motion class onto the base edge class, and an unknown state stays static', () => {
		expect(classTokens(graphEdge({ fromAnchor: from, toAnchor: to, kind: 'call', state: 'flowing' }))).toEqual(['graph-edge', 'graph-edge--flowing'])
		expect(classTokens(graphEdge({ fromAnchor: from, toAnchor: to, kind: 'call', state: 'returning' }))).toEqual(['graph-edge', 'graph-edge--returning'])
		expect(classTokens(graphEdge({ fromAnchor: from, toAnchor: to, kind: 'call', state: 'error' }))).toEqual(['graph-edge', 'graph-edge--error'])
		expect(classTokens(graphEdge({ fromAnchor: from, toAnchor: to, kind: 'call', state: 'terminated' }))).toEqual(['graph-edge', 'graph-edge--terminated'])
		expect(classTokens(graphEdge({ fromAnchor: from, toAnchor: to, kind: 'call', state: 'static' }))).toEqual(['graph-edge'])
	})
})

describe('LoopbackEdge', () => {
	const from = { x: 100, y: 50 }
	const to = { x: 100, y: 150 }

	test('the U-turn bows 60 to the right of both anchors, out and back', () => {
		const edge = loopbackEdge({ fromAnchor: from, toAnchor: to })
		expect(edge.tag).toBe('path')
		expect(edge.props['d']).toBe('M 100 50 C 160 50, 160 150, 100 150')
		expect(edge.props['marker-end']).toBeUndefined()
	})

	test('the class is the bare graph-edge stroke unless an extra class is attached, and marker-end only when provided', () => {
		expect(propString(loopbackEdge({ fromAnchor: from, toAnchor: to }).props, 'class')).toBe('graph-edge')
		expect(propString(loopbackEdge({ fromAnchor: from, toAnchor: to, extraClass: '' }).props, 'class')).toBe('graph-edge')
		const message = loopbackEdge({ fromAnchor: from, toAnchor: to, extraClass: 'seq-message', markerEnd: 'url(#seq-arrow)' })
		expect(propString(message.props, 'class')).toBe('graph-edge seq-message')
		expect(message.props['marker-end']).toBe('url(#seq-arrow)')
		expect(loopbackEdge({ fromAnchor: from, toAnchor: to, extraClass: 'seq-message', markerEnd: null }).props['marker-end']).toBeUndefined()
	})
})

describe('the cost formatters (through the GraphNode cost line)', () => {
	test('a node with no time and no tokens renders no cost line', () => {
		for (const props of [{}, { costTime: undefined, costTokens: null }, { costTime: null, costTokens: undefined }]) {
			expect(costTextOf(graphNode({ label: 'n', ...props }))).toBeUndefined()
		}
	})

	test('a zero on either part still renders — zero is a measurement, not an absence', () => {
		expect(costTextOf(graphNode({ label: 'n', costTime: 0 }))).toBe('0s')
		expect(costTextOf(graphNode({ label: 'n', costTokens: 0 }))).toBe('0 tok')
	})

	test('token counts below 1000 render as the raw number', () => {
		expect(costTextOf(graphNode({ label: 'n', costTokens: 999 }))).toBe('999 tok')
	})

	test('token counts from 1000 up render in k with one decimal, and no larger unit exists', () => {
		expect(costTextOf(graphNode({ label: 'n', costTokens: 1000 }))).toBe('1k tok')
		expect(costTextOf(graphNode({ label: 'n', costTokens: 1234 }))).toBe('1.2k tok')
		expect(costTextOf(graphNode({ label: 'n', costTokens: 262144 }))).toBe('262.1k tok')
		expect(costTextOf(graphNode({ label: 'n', costTokens: 1000000 }))).toBe('1000k tok')
	})

	test('both parts join on one line with a middle dot, time first', () => {
		expect(costTextOf(graphNode({ label: 'n', costTime: 1.5, costTokens: 1234 }))).toBe('1.5s · 1.2k tok')
		expect(costTextOf(graphNode({ label: 'n', costTime: 12, costTokens: 999 }))).toBe('12s · 999 tok')
	})

	test('the cost line is centered at the bottom of the box', () => {
		const node = graphNode({ label: 'n', costTime: 1 })
		const cost = defined(childByClass(node, 'text', 'graph-node-cost'), 'cost')
		expect(cost.props).toEqual({ class: 'graph-node-cost', x: NODE_WIDTH / 2, y: NODE_HEIGHT - 6, 'text-anchor': 'middle' })
	})
})
