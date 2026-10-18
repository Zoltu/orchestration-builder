import { describe, expect, test } from 'bun:test'
import { createRunStage } from './index.js'
import type { InteractionModel, Operation, Participant } from '../interaction-model.js'
import { createLabelResolver } from '../labels.js'
import { GraphEdge, GraphNode, LoopbackEdge, NODE_HEIGHT, NODE_WIDTH, nodeAnchor } from './svg-primitives.js'

interface FakeVnode {
	tag: string
	props: Record<string, unknown>
	children: FakeVnodeChild[]
}
type FakeVnodeChild = FakeVnode | string

function fakeH(tag: string, props: Record<string, unknown>, children: FakeVnodeChild[]): FakeVnode {
	return { tag, props, children }
}

function labels() {
	return createLabelResolver({})
}

function renderFlow(model: InteractionModel): FakeVnode {
	const stage = createRunStage({ roleNames: [], roleOrder: [] })
	return stage.render(fakeH, { model, previousModel: null, labels: labels(), tier: 'detailed', viewMode: 'flow', rolesOnly: false, guildParticipants: [] })
}

function allByTag(vnode: FakeVnode, tag: string): FakeVnode[] {
	const found: FakeVnode[] = []
	for (const child of vnode.children) {
		if (typeof child === 'string') continue
		if (child.tag === tag) found.push(child)
		for (const grand of allByTag(child, tag)) found.push(grand)
	}
	return found
}

function groupsWithClass(vnode: FakeVnode, token: string): FakeVnode[] {
	return allByTag(vnode, 'g').filter((group) => {
		const classValue = typeof group.props['class'] === 'string' ? group.props['class'] : ''
		return classValue.split(' ').includes(token)
	})
}

function participant(id: string, role: string, kind: Participant['kind']): Participant {
	return { id, role, kind }
}

function callOperation(id: string, source: string, destination: string, metrics: Operation['metrics'] = null): Operation {
	return { id, kind: 'call', stack: 'root', source, destination, startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics }
}

function returnOperation(id: string, source: string, destination: string, outcome: 'success' | 'error'): Operation {
	return { id, kind: 'return', stack: 'root', source, destination, startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome, metrics: null }
}

function coderModel(metrics: Operation['metrics'] = null): InteractionModel {
	return {
		participants: [participant('you', 'human', 'human'), participant('coder', 'coder', 'role')],
		operations: [callOperation('op1', 'you', 'coder', metrics)],
		status: 'running',
	}
}

function flowNode(view: FakeVnode, participantId: string): FakeVnode {
	const node = groupsWithClass(view, 'flow-node').find((group) => group.props['data-participant'] === participantId)
	if (node === undefined) throw new Error(`missing flow node for participant "${participantId}"`)
	return node
}

function innerNode(view: FakeVnode, participantId: string): FakeVnode {
	const node = allByTag(flowNode(view, participantId), 'g').find((group) => typeof group.props['class'] === 'string' && group.props['class'].split(' ').includes('graph-node'))
	if (node === undefined) throw new Error(`missing graph node for participant "${participantId}"`)
	return node
}

function classTokens(vnode: FakeVnode): string[] {
	return typeof vnode.props['class'] === 'string' ? vnode.props['class'].split(' ') : []
}

function childByClass(vnode: FakeVnode, tag: string, classToken: string): FakeVnode | undefined {
	return allByTag(vnode, tag).find((child) => classTokens(child).includes(classToken))
}

function costTextOf(node: FakeVnode): string | undefined {
	const cost = childByClass(node, 'text', 'graph-node-cost')
	if (cost === undefined) return undefined
	return cost.children.join('')
}

describe('graph node primitives through the flow stage', () => {
	test('the box is 160 wide and 64 tall with the label centered', () => {
		const view = renderFlow(coderModel())
		const node = innerNode(view, 'coder')
		const box = childByClass(node, 'rect', 'graph-node-box')
		expect(box?.props).toEqual({ class: 'graph-node-box', x: 0, y: 0, width: 160, height: 64, rx: 8 })
		const label = childByClass(node, 'text', 'graph-node-label')
		expect(label?.props).toEqual({ class: 'graph-node-label', x: 80, y: 26, 'text-anchor': 'middle' })
	})

	test('status applies its outcome class and terminated stays neutral', () => {
		const success: InteractionModel = {
			participants: [participant('you', 'human', 'human'), participant('coder', 'coder', 'role')],
			operations: [
				{ ...callOperation('op1', 'you', 'coder'), settledAt: 't1', lifecycle: 'settled' },
				returnOperation('op2', 'coder', 'you', 'success'),
			],
			status: 'running',
		}
		expect(classTokens(innerNode(renderFlow(success), 'coder'))).toEqual(['graph-node', 'graph-node--success'])
	})

	test('the tool kind applies the tool modifier while agent and human nodes stay neutral', () => {
		const model: InteractionModel = {
			participants: [participant('you', 'human', 'human'), participant('readFile', 'read_file', 'tool')],
			operations: [callOperation('op1', 'you', 'readFile')],
			status: 'running',
		}
		const view = renderFlow(model)
		expect(classTokens(innerNode(view, 'readFile'))).toEqual(['graph-node', 'graph-node--active', 'graph-node--tool'])
		expect(classTokens(innerNode(view, 'you'))).toEqual(['graph-node'])
	})

	test('the active class is applied to the active destination', () => {
		const view = renderFlow(coderModel())
		expect(classTokens(innerNode(view, 'coder'))).toEqual(['graph-node', 'graph-node--active'])
	})

	test('a role sublabel renders centered below the label', () => {
		const view = renderFlow(coderModel())
		const sublabel = childByClass(innerNode(view, 'coder'), 'text', 'graph-node-sublabel')
		expect(sublabel?.props).toEqual({ class: 'graph-node-sublabel', x: 80, y: 44, 'text-anchor': 'middle' })
		expect(sublabel?.children).toEqual(['coder'])
	})

	test('the cost line joins time and context with a middle dot and abbreviates thousands', () => {
		const view = renderFlow(coderModel({ tokens: 500, promptTokens: 400, completionTokens: 100, cachedPromptTokens: 0, lastPromptTokens: 1234, elapsedSeconds: 1.5 }))
		const cost = childByClass(innerNode(view, 'coder'), 'text', 'graph-node-cost')
		expect(cost?.children).toEqual(['1.5s · 1.2k ctx'])
		expect(cost?.props).toEqual({ class: 'graph-node-cost', x: 80, y: 58, 'text-anchor': 'middle' })
	})

	test('a node with no metrics renders no cost line, while a measured zero still renders', () => {
		expect(costTextOf(innerNode(renderFlow(coderModel()), 'coder'))).toBeUndefined()
		const measuredZero = renderFlow(coderModel({ tokens: 0, promptTokens: null, completionTokens: null, cachedPromptTokens: null, lastPromptTokens: null, elapsedSeconds: 0 }))
		expect(costTextOf(innerNode(measuredZero, 'coder'))).toBe('0s')
	})

	test('a null context figure renders no context part while a measured zero still renders', () => {
		const timeOnly = renderFlow(coderModel({ tokens: null, promptTokens: null, completionTokens: null, cachedPromptTokens: null, lastPromptTokens: null, elapsedSeconds: 1.5 }))
		expect(costTextOf(innerNode(timeOnly, 'coder'))).toBe('1.5s')
		const measuredZero = renderFlow(coderModel({ tokens: 0, promptTokens: null, completionTokens: null, cachedPromptTokens: null, lastPromptTokens: 0, elapsedSeconds: 0 }))
		expect(costTextOf(innerNode(measuredZero, 'coder'))).toBe('0s · 0 ctx')
	})

	test('the context figure renders raw below 1000 and in k from 1000 up with no larger unit', () => {
		const withContext = (lastPromptTokens: number): string | undefined => {
			const view = renderFlow(coderModel({ tokens: lastPromptTokens, promptTokens: null, completionTokens: null, cachedPromptTokens: null, lastPromptTokens, elapsedSeconds: 1 }))
			return costTextOf(innerNode(view, 'coder'))
		}
		expect(withContext(999)).toBe('1s · 999 ctx')
		expect(withContext(1000)).toBe('1s · 1k ctx')
		expect(withContext(1234)).toBe('1s · 1.2k ctx')
		expect(withContext(262144)).toBe('1s · 262.1k ctx')
		expect(withContext(1000000)).toBe('1s · 1000k ctx')
	})

	test('a human node renders no sublabel', () => {
		const view = renderFlow(coderModel())
		expect(childByClass(innerNode(view, 'you'), 'text', 'graph-node-sublabel')).toBeUndefined()
	})
})

describe('SVG node anchors', () => {
	const x = 100
	const y = 50

	test('top and bottom anchors sit on the horizontal center at the node edge', () => {
		expect(nodeAnchor(x, y, 'top')).toEqual({ x: x + NODE_WIDTH / 2, y })
		expect(nodeAnchor(x, y, 'bottom')).toEqual({ x: x + NODE_WIDTH / 2, y: y + NODE_HEIGHT })
	})

	test('left and right anchors sit on the vertical center at the node edge', () => {
		expect(nodeAnchor(x, y, 'left')).toEqual({ x, y: y + NODE_HEIGHT / 2 })
		expect(nodeAnchor(x, y, 'right')).toEqual({ x: x + NODE_WIDTH, y: y + NODE_HEIGHT / 2 })
	})

	test('an unrecognized side falls back to the box center', () => {
		expect(nodeAnchor(x, y, 'diagonal')).toEqual({ x: x + NODE_WIDTH / 2, y: y + NODE_HEIGHT / 2 })
	})
})

describe('graph node counter and sublabel props', () => {
	test('a counter renders the badge rect and the stringified count, including zero', () => {
		const counted = GraphNode(fakeH, { label: 'n', counter: 3 })
		const rect = childByClass(counted, 'rect', 'graph-node-counter-rect')
		expect(rect?.props).toEqual({ class: 'graph-node-counter-rect', x: NODE_WIDTH - 30, y: 6, width: 22, height: 16, rx: 8 })
		const text = childByClass(counted, 'text', 'graph-node-counter-text')
		expect(text?.props).toEqual({ class: 'graph-node-counter-text', x: NODE_WIDTH - 19, y: 17, 'text-anchor': 'middle' })
		expect(text?.children).toEqual(['3'])
		expect(childByClass(GraphNode(fakeH, { label: 'n', counter: 0 }), 'text', 'graph-node-counter-text')?.children).toEqual(['0'])
	})

	test('an absent or null counter renders no badge', () => {
		for (const counter of [undefined, null]) {
			const bare = GraphNode(fakeH, { label: 'n', counter })
			expect(childByClass(bare, 'rect', 'graph-node-counter-rect')).toBeUndefined()
			expect(childByClass(bare, 'text', 'graph-node-counter-text')).toBeUndefined()
		}
	})

	test('an absent, null, or empty sublabel renders none', () => {
		for (const sublabel of [undefined, null, '']) {
			const bare = GraphNode(fakeH, { label: 'n', sublabel })
			expect(childByClass(bare, 'text', 'graph-node-sublabel')).toBeUndefined()
		}
	})

	test('a present sublabel renders centered below the label', () => {
		const labeled = GraphNode(fakeH, { label: 'n', sublabel: 'role coder' })
		const sublabel = childByClass(labeled, 'text', 'graph-node-sublabel')
		expect(sublabel?.props).toEqual({ class: 'graph-node-sublabel', x: NODE_WIDTH / 2, y: 44, 'text-anchor': 'middle' })
		expect(sublabel?.children).toEqual(['role coder'])
	})
})

describe('edge geometry and classes', () => {
	const from = { x: 0, y: 0 }
	const to = { x: 200, y: 0 }

	test('an observe edge is a sideways-bowed dashed static line', () => {
		const edge = GraphEdge(fakeH, { fromAnchor: from, toAnchor: to, kind: 'observe' })
		expect(edge.props['d']).toBe('M 0 0 C 16 0, 216 0, 200 0')
		expect(edge.props['stroke-dasharray']).toBe('3 3')
		expect(classTokens(edge)).toEqual(['graph-edge'])
	})

	test('a terminate edge shares the observe geometry without its own dash attribute', () => {
		const edge = GraphEdge(fakeH, { fromAnchor: from, toAnchor: to, kind: 'terminate' })
		expect(edge.props['d']).toBe('M 0 0 C 16 0, 216 0, 200 0')
		expect(edge.props['stroke-dasharray']).toBeUndefined()
		expect(classTokens(edge)).toEqual(['graph-edge'])
	})

	test('the motion state layers its class onto the base edge class and an unknown state stays static', () => {
		expect(classTokens(GraphEdge(fakeH, { fromAnchor: from, toAnchor: to, kind: 'call', state: 'flowing' }))).toEqual(['graph-edge', 'graph-edge--flowing'])
		expect(classTokens(GraphEdge(fakeH, { fromAnchor: from, toAnchor: to, kind: 'call', state: 'returning' }))).toEqual(['graph-edge', 'graph-edge--returning'])
		expect(classTokens(GraphEdge(fakeH, { fromAnchor: from, toAnchor: to, kind: 'call', state: 'error' }))).toEqual(['graph-edge', 'graph-edge--error'])
		expect(classTokens(GraphEdge(fakeH, { fromAnchor: from, toAnchor: to, kind: 'call', state: 'terminated' }))).toEqual(['graph-edge', 'graph-edge--terminated'])
		expect(classTokens(GraphEdge(fakeH, { fromAnchor: from, toAnchor: to, kind: 'call', state: 'static' }))).toEqual(['graph-edge'])
	})

	test('the loopback U-turn bows 60 to the right of both anchors, out and back', () => {
		const edge = LoopbackEdge(fakeH, { fromAnchor: { x: 100, y: 50 }, toAnchor: { x: 100, y: 150 } })
		expect(edge.props['d']).toBe('M 100 50 C 160 50, 160 150, 100 150')
		expect(edge.props['marker-end']).toBeUndefined()
		expect(classTokens(edge)).toEqual(['graph-edge'])
	})

	test('the loopback attaches an extra class and marker-end only when provided', () => {
		const message = LoopbackEdge(fakeH, { fromAnchor: from, toAnchor: to, extraClass: 'seq-message', markerEnd: 'url(#seq-arrow)' })
		expect(classTokens(message)).toEqual(['graph-edge', 'seq-message'])
		expect(message.props['marker-end']).toBe('url(#seq-arrow)')
		expect(LoopbackEdge(fakeH, { fromAnchor: from, toAnchor: to, extraClass: '', markerEnd: null }).props['marker-end']).toBeUndefined()
	})
})

describe('graph edge primitives through the flow stage', () => {
	test('a call edge bows horizontally between the side anchors', () => {
		const view = renderFlow(coderModel())
		const edge = groupsWithClass(view, 'flow-edge--call')[0]
		const path = edge === undefined ? undefined : allByTag(edge, 'path')[0]
		expect(path?.props['class']).toBe('graph-edge graph-edge--flowing')
		expect(path?.props['d']).toBe('M 160 84 C 179.2 84, 236.8 84, 256 84')
	})

	test('a return edge bows downward between the bottom anchors', () => {
		const model: InteractionModel = {
			participants: [participant('you', 'human', 'human'), participant('coder', 'coder', 'role')],
			operations: [
				{ ...callOperation('op1', 'you', 'coder'), settledAt: 't1', lifecycle: 'settled' },
				returnOperation('op2', 'coder', 'you', 'success'),
			],
			status: 'running',
		}
		const view = renderFlow(model)
		const edge = groupsWithClass(view, 'flow-edge--return')[0]
		const path = edge === undefined ? undefined : allByTag(edge, 'path')[0]
		expect(path?.props['class']).toBe('graph-edge graph-edge--returning')
		expect(path?.props['d']).toBe('M 336 116 C 336 156, 80 156, 80 116')
	})

	test('the call edge carries no dash while an observe edge does', () => {
		const call = renderFlow(coderModel())
		const callEdge = groupsWithClass(call, 'flow-edge--call')[0]
		const callPath = callEdge === undefined ? undefined : allByTag(callEdge, 'path')[0]
		expect(callPath?.props['stroke-dasharray']).toBeUndefined()
	})
})
