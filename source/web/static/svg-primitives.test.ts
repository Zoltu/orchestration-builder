import { describe, expect, test } from 'bun:test'
import { GraphEdge, GraphNode, NODE_HEIGHT, NODE_WIDTH, TooltipShell, nodeAnchor } from './svg-primitives.js'

// A fake hyperscript that records the call as a serializable object so the vnode shape is assertable without hyperapp or a DOM. It mirrors how the primitives call `h`: `h(tag, props, children)` with children as a single array.
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

function byTag(vnode: Vnode, tag: string): Vnode[] {
	return vnode.children.filter((child): child is Vnode => isVnode(child) && child.tag === tag)
}

function firstByTag(vnode: Vnode, tag: string): Vnode {
	const match = byTag(vnode, tag)[0]
	if (match === undefined) throw new Error(`expected a <${tag}> child, found: ${vnode.children.map((c) => (isVnode(c) ? c.tag : 'text')).join(', ')}`)
	return match
}

function textOf(vnode: Vnode): string {
	const match = vnode.children.find((child): child is string => typeof child === 'string')
	if (match === undefined) throw new Error('expected a text child')
	return match
}

describe('nodeAnchor', () => {
	test('returns the center by default and for each named side', () => {
		expect(nodeAnchor(100, 50, 'center')).toEqual({ x: 100 + NODE_WIDTH / 2, y: 50 + NODE_HEIGHT / 2 })
		expect(nodeAnchor(100, 50, 'top')).toEqual({ x: 100 + NODE_WIDTH / 2, y: 50 })
		expect(nodeAnchor(100, 50, 'bottom')).toEqual({ x: 100 + NODE_WIDTH / 2, y: 50 + NODE_HEIGHT })
		expect(nodeAnchor(100, 50, 'left')).toEqual({ x: 100, y: 50 + NODE_HEIGHT / 2 })
		expect(nodeAnchor(100, 50, 'right')).toEqual({ x: 100 + NODE_WIDTH, y: 50 + NODE_HEIGHT / 2 })
	})

	test('an unknown side falls back to the center', () => {
		expect(nodeAnchor(0, 0, 'diagonal')).toEqual({ x: NODE_WIDTH / 2, y: NODE_HEIGHT / 2 })
	})
})

describe('GraphNode', () => {
	test('returns a <g> with base class, a box rect, and the label text', () => {
		const node: Vnode = GraphNode(fakeH, { label: 'Planner' })
		expect(node.tag).toBe('g')
		expect(node.props.class).toBe('graph-node')
		const box = firstByTag(node, 'rect')
		expect(box.props.x).toBe(0)
		expect(box.props.y).toBe(0)
		expect(box.props.width).toBe(NODE_WIDTH)
		expect(box.props.height).toBe(NODE_HEIGHT)
		expect(box.props.class).toBe('graph-node-box')
		const label = firstByTag(node, 'text')
		expect(label.props.class).toBe('graph-node-label')
		expect(textOf(label)).toBe('Planner')
	})

	test('adds a sublabel text when provided and omits it otherwise', () => {
		const withSub: Vnode = GraphNode(fakeH, { label: 'Planner', sublabel: 'planner' })
		const sublabel = byTag(withSub, 'text').find((child) => child.props.class === 'graph-node-sublabel')
		expect(sublabel).toBeDefined()
		if (sublabel === undefined) return
		expect(textOf(sublabel)).toBe('planner')

		const withoutSub: Vnode = GraphNode(fakeH, { label: 'Planner' })
		expect(byTag(withoutSub, 'text').some((child) => child.props.class === 'graph-node-sublabel')).toBe(false)
	})

	test('adds a counter badge with the counter rendered as a string', () => {
		const node: Vnode = GraphNode(fakeH, { label: 'Coder', counter: 3 })
		const counterRect = byTag(node, 'rect').find((child) => child.props.class === 'graph-node-counter-rect')
		expect(counterRect).toBeDefined()
		const counterText = byTag(node, 'text').find((child) => child.props.class === 'graph-node-counter-text')
		expect(counterText).toBeDefined()
		if (counterText === undefined) return
		expect(textOf(counterText)).toBe('3')
	})

	test('omits the counter badge when none is provided', () => {
		const node: Vnode = GraphNode(fakeH, { label: 'Coder' })
		expect(byTag(node, 'rect').some((child) => child.props.class === 'graph-node-counter-rect')).toBe(false)
		expect(byTag(node, 'text').some((child) => child.props.class === 'graph-node-counter-text')).toBe(false)
	})

	test('formats a cost line from time and tokens and omits it when neither is present', () => {
		const withCost: Vnode = GraphNode(fakeH, { label: 'Coder', costTime: 12, costTokens: 5400 })
		const costText = byTag(withCost, 'text').find((child) => child.props.class === 'graph-node-cost')
		expect(costText).toBeDefined()
		if (costText === undefined) return
		expect(textOf(costText)).toBe('12s \u00b7 5.4k tok')

		const timeOnly: Vnode = GraphNode(fakeH, { label: 'Coder', costTime: 8 })
		const timeCost = byTag(timeOnly, 'text').find((child) => child.props.class === 'graph-node-cost')
		expect(timeCost).toBeDefined()
		if (timeCost === undefined) return
		expect(textOf(timeCost)).toBe('8s')

		const withoutCost: Vnode = GraphNode(fakeH, { label: 'Coder' })
		expect(byTag(withoutCost, 'text').some((child) => child.props.class === 'graph-node-cost')).toBe(false)
	})

	test('renders sub-1000 token counts without the k suffix', () => {
		const node: Vnode = GraphNode(fakeH, { label: 'Coder', costTokens: 640 })
		const costText = byTag(node, 'text').find((child) => child.props.class === 'graph-node-cost')
		if (costText === undefined) throw new Error('expected a cost text')
		expect(textOf(costText)).toBe('640 tok')
	})

	test('the active flag adds the active class', () => {
		const node: Vnode = GraphNode(fakeH, { label: 'Planner', active: true })
		expect(node.props.class).toBe('graph-node graph-node--active')
	})

	test('success and error statuses add their respective classes', () => {
		const success: Vnode = GraphNode(fakeH, { label: 'Planner', status: 'success' })
		expect(success.props.class).toBe('graph-node graph-node--success')
		const error: Vnode = GraphNode(fakeH, { label: 'Coder', status: 'error' })
		expect(error.props.class).toBe('graph-node graph-node--error')
	})

	test('active and a status compose on the same node', () => {
		const node: Vnode = GraphNode(fakeH, { label: 'Coder', status: 'error', active: true })
		expect(node.props.class).toBe('graph-node graph-node--active graph-node--error')
	})

	test('a null status adds no state class', () => {
		const node: Vnode = GraphNode(fakeH, { label: 'Planner', status: null })
		expect(node.props.class).toBe('graph-node')
	})
})

describe('GraphEdge', () => {
	const from = { x: 0, y: 32 }
	const to = { x: 200, y: 32 }

	test('returns a <path> with the base class and a d attribute spanning the anchors', () => {
		const edge: Vnode = GraphEdge(fakeH, { fromAnchor: from, toAnchor: to, state: 'static' })
		expect(edge.tag).toBe('path')
		expect(edge.props.class).toBe('graph-edge')
		const d = edge.props.d
		expect(typeof d).toBe('string')
		expect(d).toContain(`M ${from.x} ${from.y}`)
		expect(d).toContain(`${to.x} ${to.y}`)
	})

	test('flowing, returning, and error states add their respective classes', () => {
		const flowing: Vnode = GraphEdge(fakeH, { fromAnchor: from, toAnchor: to, state: 'flowing' })
		expect(flowing.props.class).toBe('graph-edge graph-edge--flowing')
		const returning: Vnode = GraphEdge(fakeH, { fromAnchor: from, toAnchor: to, state: 'returning' })
		expect(returning.props.class).toBe('graph-edge graph-edge--returning')
		const error: Vnode = GraphEdge(fakeH, { fromAnchor: from, toAnchor: to, state: 'error' })
		expect(error.props.class).toBe('graph-edge graph-edge--error')
	})

	test('an unknown state falls back to the bare static class', () => {
		const edge: Vnode = GraphEdge(fakeH, { fromAnchor: from, toAnchor: to, state: 'unknown' })
		expect(edge.props.class).toBe('graph-edge')
	})
})

describe('TooltipShell', () => {
	test('returns a <g> with a background rect, a title, and a body slot carrying the caller children', () => {
		const body = fakeH('text', { class: 'graph-tooltip-text', x: 0, y: 0 }, ['body prose'])
		const shell: Vnode = TooltipShell(fakeH, { title: 'The planner', children: [body] })
		expect(shell.tag).toBe('g')
		expect(shell.props.class).toBe('graph-tooltip')
		const rect = firstByTag(shell, 'rect')
		expect(rect.props.class).toBe('graph-tooltip-rect')
		const title = byTag(shell, 'text').find((child) => child.props.class === 'graph-tooltip-title')
		expect(title).toBeDefined()
		if (title === undefined) return
		expect(textOf(title)).toBe('The planner')
		const bodyGroup = firstByTag(shell, 'g')
		expect(bodyGroup.props.class).toBe('graph-tooltip-body')
		expect(bodyGroup.props.transform).toContain('translate')
	})

	test('omits the copy button when copyAvailable is false', () => {
		const shell: Vnode = TooltipShell(fakeH, { title: 'T', copyAvailable: false, onCopyRaw: () => {} })
		expect(byTag(shell, 'g').some((child) => child.props.class === 'graph-tooltip-copy')).toBe(false)
	})

	test('omits the copy button when onCopyRaw is absent even if copyAvailable is true', () => {
		const shell: Vnode = TooltipShell(fakeH, { title: 'T', copyAvailable: true })
		expect(byTag(shell, 'g').some((child) => child.props.class === 'graph-tooltip-copy')).toBe(false)
	})

	test('adds a copy button wired to onCopyRaw when available', () => {
		const onCopyRaw = () => {}
		const shell: Vnode = TooltipShell(fakeH, { title: 'T', copyAvailable: true, onCopyRaw })
		const copyGroup = byTag(shell, 'g').find((child) => child.props.class === 'graph-tooltip-copy')
		expect(copyGroup).toBeDefined()
		if (copyGroup === undefined) return
		expect(copyGroup.props.onclick).toBe(onCopyRaw)
		const copyText = byTag(copyGroup, 'text').find((child) => child.props.class === 'graph-tooltip-button-text')
		expect(copyText).toBeDefined()
		if (copyText === undefined) return
		expect(textOf(copyText)).toBe('Copy raw')
	})
})
