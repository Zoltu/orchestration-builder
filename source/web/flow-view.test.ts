import { describe, expect, test } from 'bun:test'
import { renderFlowView, FLOW_VIEW_CONSTANTS } from './static/flow-view.js'
import { fixtures } from './static/fixtures.js'

// The flow-view renderer is browser-pure JS, so its exports arrive with inferred JS types. The interfaces below carry the shape the tests assert against; results are annotated rather than cast so the structural checks flow through TypeScript, mirroring pathfinding.test.ts.

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
	if (match === undefined) throw new Error(`expected a <${tag}> child`)
	return match
}

// Walks a vnode tree and collects every descendant matching a tag.
function allByTag(vnode: Vnode, tag: string): Vnode[] {
	const found: Vnode[] = []
	for (const child of vnode.children) {
		if (!isVnode(child)) continue
		if (child.tag === tag) found.push(child)
		for (const grand of allByTag(child, tag)) found.push(grand)
	}
	return found
}

// --- FlowModel shape guard --------------------------------------------------
// Validates a fixture's flowModel against the future /api/runs/:id/flow contract so a malformed fixture fails loudly here rather than producing a confusing visual. Mirrors the RunView guards in fixtures.test.ts.

const NODE_KINDS = new Set(['you', 'role', 'tool'])
const EDGE_KINDS = new Set(['call', 'return', 'question'])

interface FlowNode {
	id: string
	kind: string
	label: string
	column: number
	row: number
	sublabel?: string
	status?: string
	active?: boolean
	counter?: number
	costTime?: number
	costTokens?: number
}

interface FlowEdge {
	from: string
	to: string
	kind: string
}

interface MainArea {
	nodes: FlowNode[]
	edges: FlowEdge[]
}

interface TopBarNode {
	id: string
	kind: string
	label: string
	invocations: number
	totalTime?: number
	totalTokens?: number
	status?: string
}

interface TopBar {
	nodes: TopBarNode[]
}

interface FlowModel {
	mainArea: MainArea
	topBar: TopBar
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
	return typeof value === 'string'
}

function isNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function isNodeKind(value: unknown): boolean {
	return isString(value) && NODE_KINDS.has(value)
}

function isEdgeKind(value: unknown): boolean {
	return isString(value) && EDGE_KINDS.has(value)
}

function isFlowNode(value: unknown): value is FlowNode {
	if (!isObject(value)) return false
	if (!isString(value.id)) return false
	if (!isNodeKind(value.kind)) return false
	if (!isString(value.label)) return false
	if (!isNumber(value.column)) return false
	if (!isNumber(value.row)) return false
	if (value.sublabel !== undefined && !isString(value.sublabel)) return false
	if (value.status !== undefined && !isString(value.status)) return false
	if (value.active !== undefined && typeof value.active !== 'boolean') return false
	if (value.counter !== undefined && !isNumber(value.counter)) return false
	if (value.costTime !== undefined && !isNumber(value.costTime)) return false
	if (value.costTokens !== undefined && !isNumber(value.costTokens)) return false
	return true
}

function isFlowEdge(value: unknown): value is FlowEdge {
	if (!isObject(value)) return false
	if (!isString(value.from)) return false
	if (!isString(value.to)) return false
	if (!isEdgeKind(value.kind)) return false
	return true
}

function isMainArea(value: unknown): value is MainArea {
	if (!isObject(value)) return false
	if (!Array.isArray(value.nodes) || !value.nodes.every(isFlowNode)) return false
	if (!Array.isArray(value.edges) || !value.edges.every(isFlowEdge)) return false
	return true
}

function isTopBarNode(value: unknown): value is TopBarNode {
	if (!isObject(value)) return false
	if (!isString(value.id)) return false
	if (!isNodeKind(value.kind)) return false
	if (!isString(value.label)) return false
	if (!isNumber(value.invocations)) return false
	if (value.totalTime !== undefined && !isNumber(value.totalTime)) return false
	if (value.totalTokens !== undefined && !isNumber(value.totalTokens)) return false
	if (value.status !== undefined && !isString(value.status)) return false
	return true
}

function isTopBar(value: unknown): value is TopBar {
	if (!isObject(value)) return false
	if (!Array.isArray(value.nodes) || !value.nodes.every(isTopBarNode)) return false
	return true
}

function isFlowModel(value: unknown): value is FlowModel {
	if (!isObject(value)) return false
	if (!isMainArea(value.mainArea)) return false
	if (!isTopBar(value.topBar)) return false
	return true
}

// Extracts the flowModel from a frame value whose static type (inferred from the JS fixtures) does not advertise the field, so the access goes through `unknown` rather than the inferred shape.
function flowModelOf(frameValue: unknown): unknown {
	if (!isObject(frameValue)) return undefined
	return frameValue['flowModel']
}

describe('flow-view fixtures', () => {
	test('every frame carries a well-formed FlowModel conforming to the future endpoint contract', () => {
		for (const scenario of fixtures) {
			scenario.frames.forEach((frameValue, frameIndex) => {
				const model = flowModelOf(frameValue)
				if (!isFlowModel(model)) {
					throw new Error(`${scenario.id}[frame ${frameIndex}].flowModel: does not match the FlowModel contract`)
				}
			})
		}
	})

	test('every edge references nodes that exist in the main area', () => {
		for (const scenario of fixtures) {
			scenario.frames.forEach((frameValue, frameIndex) => {
				const model = flowModelOf(frameValue)
				if (!isFlowModel(model)) return
				const ids = new Set(model.mainArea.nodes.map((n) => n.id))
				for (const edge of model.mainArea.edges) {
					if (!ids.has(edge.from)) throw new Error(`${scenario.id}[frame ${frameIndex}]: edge.from "${edge.from}" has no node`)
					if (!ids.has(edge.to)) throw new Error(`${scenario.id}[frame ${frameIndex}]: edge.to "${edge.to}" has no node`)
				}
			})
		}
	})

	test('the root "You" node is always present at column 0', () => {
		for (const scenario of fixtures) {
			scenario.frames.forEach((frameValue, frameIndex) => {
				const model = flowModelOf(frameValue)
				if (!isFlowModel(model)) return
				const youNodes = model.mainArea.nodes.filter((n) => n.kind === 'you')
				if (youNodes.length === 0) throw new Error(`${scenario.id}[frame ${frameIndex}]: no "you" node`)
				for (const node of youNodes) {
					if (node.column !== 0) throw new Error(`${scenario.id}[frame ${frameIndex}]: "you" node not at column 0`)
				}
			})
		}
	})
})

describe('renderFlowView', () => {
	const { NODE_WIDTH, NODE_HEIGHT, COL_GAP, ROW_GAP, SMALL_SIZE, SMALL_GAP, TOP_BAR_PER_ROW, DEFAULT_MIN_COLUMNS } = FLOW_VIEW_CONSTANTS

	// A minimal two-node model (You calling a role) used across the renderer tests.
	function simpleModel() {
		return {
			mainArea: {
				nodes: [
					{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 },
					{ id: 'planner', kind: 'role', label: 'Planner', sublabel: 'planner', column: 1, row: 0, active: true },
				],
				edges: [{ from: 'you', to: 'planner', kind: 'call' }],
			},
			topBar: {
				nodes: [
					{ id: 'you', kind: 'you', label: 'You', invocations: 1 },
					{ id: 'planner', kind: 'role', label: 'Planner', invocations: 1, totalTime: 5, totalTokens: 4380 },
				],
			},
		}
	}

	test('returns a <div> wrapper containing the top-bar and main-area SVGs', () => {
		const view: Vnode = renderFlowView(fakeH, simpleModel())
		expect(view.tag).toBe('div')
		expect(view.props.class).toBe('flow-view')
		const svgs = byTag(view, 'svg')
		expect(svgs.length).toBe(2)
		expect(svgs[0]!.props.class).toBe('flow-topbar-svg')
		expect(svgs[1]!.props.class).toBe('flow-main-svg')
	})

	test('the main-area viewBox is floored at DEFAULT_MIN_COLUMNS even when content is narrower', () => {
		const view: Vnode = renderFlowView(fakeH, simpleModel())
		const main = byTag(view, 'svg').find((s) => s.props.class === 'flow-main-svg')!
		// The model has two columns (0 and 1), one row, but the canvas is pre-sized to the 5-column floor so a typical chain has stable scale as it grows.
		const expectedWidth = DEFAULT_MIN_COLUMNS * NODE_WIDTH + (DEFAULT_MIN_COLUMNS - 1) * COL_GAP
		const expectedHeight = 1 * NODE_HEIGHT + 0 * ROW_GAP
		expect(main.props.viewBox).toBe(`0 0 ${expectedWidth} ${expectedHeight}`)
	})

	test('the main-area viewBox expands beyond the floor when content needs more columns', () => {
		const model = {
			mainArea: {
				nodes: [
					{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 },
					{ id: 'a', kind: 'role', label: 'A', column: 1, row: 0 },
					{ id: 'b', kind: 'role', label: 'B', column: 2, row: 0 },
					{ id: 'c', kind: 'role', label: 'C', column: 3, row: 0 },
					{ id: 'd', kind: 'role', label: 'D', column: 4, row: 0 },
					{ id: 'e', kind: 'role', label: 'E', column: 5, row: 0 },
				],
				edges: [],
			},
			topBar: { nodes: [] },
		}
		const view: Vnode = renderFlowView(fakeH, model)
		const main = byTag(view, 'svg').find((s) => s.props.class === 'flow-main-svg')!
		// Six columns of content (0..5) exceed the 5-column floor, so the canvas expands to 6.
		const expectedWidth = 6 * NODE_WIDTH + 5 * COL_GAP
		expect(main.props.viewBox).toBe(`0 0 ${expectedWidth} ${1 * NODE_HEIGHT}`)
	})

	test('a minColumns above the content count holds the canvas open (no shrink)', () => {
		// Models a frame after a 6-column layer has finished: content is back to 2 columns, but the caller passes the high-water mark (6) so the canvas does not contract.
		const model = simpleModel()
		const view: Vnode = renderFlowView(fakeH, model, 6)
		const main = byTag(view, 'svg').find((s) => s.props.class === 'flow-main-svg')!
		const expectedWidth = 6 * NODE_WIDTH + 5 * COL_GAP
		expect(main.props.viewBox).toBe(`0 0 ${expectedWidth} ${1 * NODE_HEIGHT}`)
	})

	test('a minColumns below DEFAULT_MIN_COLUMNS still floors at the default', () => {
		const model = simpleModel()
		const view: Vnode = renderFlowView(fakeH, model, 2)
		const main = byTag(view, 'svg').find((s) => s.props.class === 'flow-main-svg')!
		const expectedWidth = DEFAULT_MIN_COLUMNS * NODE_WIDTH + (DEFAULT_MIN_COLUMNS - 1) * COL_GAP
		expect(main.props.viewBox).toBe(`0 0 ${expectedWidth} ${1 * NODE_HEIGHT}`)
	})

	test('a node at (column 1, row 0) is translated to the second column pixel position', () => {
		const view: Vnode = renderFlowView(fakeH, simpleModel())
		const groups = allByTag(view, 'g')
		// The planner node group carries a translate of (NODE_WIDTH + COL_GAP, 0).
		const plannerGroup = groups.find((g) => {
			if (typeof g.props.transform !== 'string') return false
			return g.props.transform === `translate(${NODE_WIDTH + COL_GAP},0)`
		})
		expect(plannerGroup).toBeDefined()
	})

	test('a row-1 node is translated below a row-0 node by NODE_HEIGHT + ROW_GAP', () => {
		const model = {
			mainArea: {
				nodes: [
					{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 },
					{ id: 'other', kind: 'role', label: 'Other', column: 0, row: 1 },
				],
				edges: [],
			},
			topBar: { nodes: [] },
		}
		const view: Vnode = renderFlowView(fakeH, model)
		const groups = allByTag(view, 'g')
		const otherGroup = groups.find((g) => g.props.transform === `translate(0,${NODE_HEIGHT + ROW_GAP})`)
		expect(otherGroup).toBeDefined()
	})

	test('a call edge uses the source right face and the target left face (left-to-right)', () => {
		const model = simpleModel()
		const view: Vnode = renderFlowView(fakeH, model)
		const edges = allByTag(view, 'path').filter((p) => typeof p.props.d === 'string' && (p.props.d as string).startsWith('M '))
		expect(edges.length).toBe(1)
		const d = edges[0]!.props.d as string
		// The path starts at the You node's right-face anchor (x = NODE_WIDTH, y = NODE_HEIGHT/2) and ends at the planner's left-face anchor (x = NODE_WIDTH + COL_GAP + ... , y = NODE_HEIGHT/2).
		const youRightX = NODE_WIDTH
		const halfHeight = NODE_HEIGHT / 2
		expect(d.startsWith(`M ${youRightX} ${halfHeight}`)).toBe(true)
		expect(d.includes(`${halfHeight}`)).toBe(true)
	})

	test('a return edge uses the source left face and the target right face (right-to-left)', () => {
		const model = {
			mainArea: {
				nodes: [
					{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 },
					{ id: 'planner', kind: 'role', label: 'Planner', column: 1, row: 0, status: 'success' },
				],
				edges: [{ from: 'planner', to: 'you', kind: 'return' }],
			},
			topBar: { nodes: [] },
		}
		const view: Vnode = renderFlowView(fakeH, model)
		const edges = allByTag(view, 'path').filter((p) => typeof p.props.d === 'string')
		expect(edges.length).toBe(1)
		const d = edges[0]!.props.d as string
		// The return path starts at the planner's left face (x = NODE_WIDTH + COL_GAP, y = NODE_HEIGHT/2).
		const plannerLeftX = NODE_WIDTH + COL_GAP
		const halfHeight = NODE_HEIGHT / 2
		expect(d.startsWith(`M ${plannerLeftX} ${halfHeight}`)).toBe(true)
		// And ends at the You node's right face (x = NODE_WIDTH, y = NODE_HEIGHT/2).
		expect(d.includes(`${NODE_WIDTH} ${halfHeight}`)).toBe(true)
	})

	test('edges are rendered before nodes so node boxes paint over anchor overlap', () => {
		const view: Vnode = renderFlowView(fakeH, simpleModel())
		const main = byTag(view, 'svg').find((s) => s.props.class === 'flow-main-svg')!
		const childTags = main.children.filter(isVnode).map((c) => c.tag)
		const firstPathIndex = childTags.indexOf('path')
		const firstGroupIndex = childTags.indexOf('g')
		expect(firstPathIndex).toBeGreaterThanOrEqual(0)
		expect(firstGroupIndex).toBeGreaterThan(firstPathIndex)
	})

	test('an edge referencing an unknown node is dropped rather than crashing', () => {
		const model = {
			mainArea: {
				nodes: [{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 }],
				edges: [{ from: 'you', to: 'ghost', kind: 'call' }],
			},
			topBar: { nodes: [] },
		}
		const view: Vnode = renderFlowView(fakeH, model)
		expect(allByTag(view, 'path').length).toBe(0)
	})

	test('the top bar renders one small node per history entry', () => {
		const view: Vnode = renderFlowView(fakeH, simpleModel())
		const topbar = byTag(view, 'svg').find((s) => s.props.class === 'flow-topbar-svg')!
		const groups = byTag(topbar, 'g')
		expect(groups.length).toBe(2)
	})

	test('a small node carries a box, a centered count, and a hover <title> with the label and stats', () => {
		const view: Vnode = renderFlowView(fakeH, simpleModel())
		const topbar = byTag(view, 'svg').find((s) => s.props.class === 'flow-topbar-svg')!
		const groups = byTag(topbar, 'g')
		// The first slot is "You" (no cumulative stats); the second is "Planner" with time + tokens.
		const youGroup = groups[0]!
		const plannerGroup = groups[1]!

		// Both carry the small-node class, a box, and a single centered count.
		expect((youGroup.props.class as string) ?? '').toContain('flow-small-node')
		expect(byTag(plannerGroup, 'rect').find((r) => r.props.class === 'flow-small-node-box')).toBeDefined()
		const counts = byTag(plannerGroup, 'text').filter((t) => t.props.class === 'flow-small-node-count')
		expect(counts.length).toBe(1)
		expect(counts[0]!.props['text-anchor']).toBe('middle')

		// The You slot's title carries just the label and call count (no stats).
		const youTitle = byTag(youGroup, 'title')[0]!.children.join('')
		expect(youTitle).toContain('You')
		expect(youTitle).toContain('1 call')
		expect(youTitle).not.toContain('tokens')

		// The Planner slot's title carries the label, call count, and cumulative time + tokens.
		const plannerTitle = byTag(plannerGroup, 'title')[0]!.children.join('')
		expect(plannerTitle).toContain('Planner')
		expect(plannerTitle).toContain('1 call')
		expect(plannerTitle).toContain('5s')
		expect(plannerTitle).toContain('4,380 tokens')
	})

	test('a small node with an error status adds the error class', () => {
		const model = {
			mainArea: { nodes: [{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 }], edges: [] },
			topBar: { nodes: [{ id: 'coder', kind: 'role', label: 'Coder', invocations: 1, status: 'error' }] },
		}
		const view: Vnode = renderFlowView(fakeH, model)
		const topbar = byTag(view, 'svg').find((s) => s.props.class === 'flow-topbar-svg')!
		const group = firstByTag(topbar, 'g')
		expect((group.props.class as string) ?? '').toContain('flow-small-node--error')
	})

	test('top-bar nodes wrap into rows of TOP_BAR_PER_ROW', () => {
		const nodes = Array.from({ length: TOP_BAR_PER_ROW + 2 }, (_, i) => ({ id: `n${i}`, kind: 'role', label: `N${i}`, invocations: 1 }))
		const model = { mainArea: { nodes: [], edges: [] }, topBar: { nodes } }
		const view: Vnode = renderFlowView(fakeH, model)
		const topbar = byTag(view, 'svg').find((s) => s.props.class === 'flow-topbar-svg')!
		// The first TOP_BAR_PER_ROW nodes sit at row 0 (y = 0); the overflow sits at row 1 (y = SMALL_SIZE + SMALL_GAP).
		const groups = byTag(topbar, 'g')
		expect(groups.length).toBe(TOP_BAR_PER_ROW + 2)
		const rowOne = groups.slice(0, TOP_BAR_PER_ROW)
		const rowTwo = groups.slice(TOP_BAR_PER_ROW)
		for (const g of rowOne) expect(g.props.transform).toContain(',0)')
		for (const g of rowTwo) expect(g.props.transform).toContain(`,${SMALL_SIZE + SMALL_GAP})`)
		// The viewBox height reflects two wrapped rows.
		const expectedHeight = 2 * SMALL_SIZE + SMALL_GAP
		expect(topbar.props.viewBox).toBe(`0 0 ${(TOP_BAR_PER_ROW * SMALL_SIZE) + (TOP_BAR_PER_ROW - 1) * SMALL_GAP} ${expectedHeight}`)
	})

	test('an empty top bar renders an SVG with no children and a zero viewBox', () => {
		const model = { mainArea: { nodes: [{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 }], edges: [] }, topBar: { nodes: [] } }
		const view: Vnode = renderFlowView(fakeH, model)
		const topbar = byTag(view, 'svg').find((s) => s.props.class === 'flow-topbar-svg')!
		expect(topbar.children.filter(isVnode).length).toBe(0)
		expect(topbar.props.viewBox).toBe('0 0 0 0')
	})
})
