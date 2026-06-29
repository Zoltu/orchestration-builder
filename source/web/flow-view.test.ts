import { describe, expect, test } from 'bun:test'
import { renderFlowView, deriveFlowAnimation, deriveLifecycle, deriveNowCaption, FLOW_VIEW_CONSTANTS } from './static/flow-view.js'
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
const EDGE_KINDS = new Set(['call', 'return', 'question', 'inspect'])

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

	test('the root "You" node is always present', () => {
		// The "You" node represents the user. It normally sits at column 0 as the run's root, but when the user is the respondent of a pending ask_human question it is placed at the question edge's target column (to the right of ask_human) so the question flows toward it; the column is therefore not pinned to 0, but a you node is always present.
		for (const scenario of fixtures) {
			scenario.frames.forEach((frameValue, frameIndex) => {
				const model = flowModelOf(frameValue)
				if (!isFlowModel(model)) return
				const youNodes = model.mainArea.nodes.filter((n) => n.kind === 'you')
				if (youNodes.length === 0) throw new Error(`${scenario.id}[frame ${frameIndex}]: no "you" node`)
			})
		}
	})
})

describe('renderFlowView', () => {
	const { NODE_WIDTH, NODE_HEIGHT, COL_GAP, ROW_GAP, SMALL_SIZE, SMALL_GAP, TOP_BAR_PER_ROW, DEFAULT_MIN_COLUMNS } = FLOW_VIEW_CONSTANTS

	// A minimal two-node model (You calling a role) with no top bar, used across the main-area layout tests so positions are not offset by a history strip.
	function simpleModel() {
		return {
			mainArea: {
				nodes: [
					{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 },
					{ id: 'planner', kind: 'role', label: 'Planner', sublabel: 'planner', column: 1, row: 0, active: true },
				],
				edges: [{ from: 'you', to: 'planner', kind: 'call' }],
			},
			topBar: { nodes: [] },
		}
	}

	// A model carrying a populated top bar (two history slots) for the top-bar rendering tests.
	function topBarModel() {		return {
			mainArea: { nodes: [{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 }], edges: [] },
			topBar: {
				nodes: [
					{ id: 'you', kind: 'you', label: 'You', invocations: 1 },
					{ id: 'planner', kind: 'role', label: 'Planner', invocations: 1, totalTime: 5, totalTokens: 4380 },
				],
			},
		}
	}

	test('an empty top bar renders a main-area-only SVG (no top-bar children, no offset)', () => {
		const model = { mainArea: { nodes: [{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 }], edges: [] }, topBar: { nodes: [] } }
		const view: Vnode = renderFlowView(fakeH, model)
		// No top-bar slots means the main area starts at y=0 (no offset) and the viewBox is the 5-column floor with one row of height.
		const smallNodes = allByTag(view, 'g').filter((g) => ((g.props.class as string) ?? '').includes('flow-small-node'))
		expect(smallNodes.length).toBe(0)
		const expectedWidth = DEFAULT_MIN_COLUMNS * NODE_WIDTH + (DEFAULT_MIN_COLUMNS - 1) * COL_GAP
		expect(view.props.viewBox).toBe(`0 0 ${expectedWidth} ${NODE_HEIGHT}`)
	})

	test('returns a single flow-view SVG containing the top-bar and main-area content', () => {
		const view: Vnode = renderFlowView(fakeH, topBarModel())
		expect(view.tag).toBe('svg')
		expect(view.props.class).toBe('flow-view-svg')
		// The small top-bar nodes and the main-area node groups are all children of the one shared SVG (a node can travel from the main area to its top-bar slot in this shared coordinate space).
		const groups = allByTag(view, 'g')
		expect(groups.filter((g) => ((g.props.class as string) ?? '').includes('flow-small-node')).length).toBe(2)
		expect(groups.filter((g) => (g.props.class as string) === 'flow-node').length).toBe(1)
	})

	test('the main-area viewBox is floored at DEFAULT_MIN_COLUMNS even when content is narrower', () => {
		const view: Vnode = renderFlowView(fakeH, simpleModel())
		// The model has two columns (0 and 1), one row, but the canvas is pre-sized to the 5-column floor so a typical chain has stable scale as it grows. With no top bar the viewBox is just the main area.
		const expectedWidth = DEFAULT_MIN_COLUMNS * NODE_WIDTH + (DEFAULT_MIN_COLUMNS - 1) * COL_GAP
		const expectedHeight = 1 * NODE_HEIGHT + 0 * ROW_GAP
		expect(view.props.viewBox).toBe(`0 0 ${expectedWidth} ${expectedHeight}`)
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
		// Six columns of content (0..5) exceed the 5-column floor, so the canvas expands to 6.
		const expectedWidth = 6 * NODE_WIDTH + 5 * COL_GAP
		expect(view.props.viewBox).toBe(`0 0 ${expectedWidth} ${1 * NODE_HEIGHT}`)
	})

	test('a minColumns above the content count holds the canvas open (no shrink)', () => {
		// Models a frame after a 6-column layer has finished: content is back to 2 columns, but the caller passes the high-water mark (6) so the canvas does not contract.
		const model = simpleModel()
		const view: Vnode = renderFlowView(fakeH, model, 6)
		const expectedWidth = 6 * NODE_WIDTH + 5 * COL_GAP
		expect(view.props.viewBox).toBe(`0 0 ${expectedWidth} ${1 * NODE_HEIGHT}`)
	})

	test('a minColumns below DEFAULT_MIN_COLUMNS still floors at the default', () => {
		const model = simpleModel()
		const view: Vnode = renderFlowView(fakeH, model, 2)
		const expectedWidth = DEFAULT_MIN_COLUMNS * NODE_WIDTH + (DEFAULT_MIN_COLUMNS - 1) * COL_GAP
		expect(view.props.viewBox).toBe(`0 0 ${expectedWidth} ${1 * NODE_HEIGHT}`)
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

	test('a return edge routes along the bottom faces so the response leg sits below the call line', () => {
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
		// The return path starts at the planner's bottom-face anchor (x = NODE_WIDTH + COL_GAP + NODE_WIDTH/2, y = NODE_HEIGHT) and ends at the You node's bottom-face anchor (x = NODE_WIDTH/2, y = NODE_HEIGHT), bowing below so it never overlaps a forward call line at the vertical center.
		const plannerBottomX = NODE_WIDTH + COL_GAP + NODE_WIDTH / 2
		const youBottomX = NODE_WIDTH / 2
		expect(d.startsWith(`M ${plannerBottomX} ${NODE_HEIGHT}`)).toBe(true)
		expect(d.includes(`${youBottomX} ${NODE_HEIGHT}`)).toBe(true)
		// The control points bow downward (y > NODE_HEIGHT), never at the center half-height.
		const halfHeight = NODE_HEIGHT / 2
		expect(d.includes(`${halfHeight}`)).toBe(false)
	})

	test('edges are rendered before nodes so node boxes paint over anchor overlap', () => {
		const view: Vnode = renderFlowView(fakeH, simpleModel())
		const childTags = view.children.filter(isVnode).map((c) => c.tag)
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
		const view: Vnode = renderFlowView(fakeH, topBarModel())
		const smallNodes = allByTag(view, 'g').filter((g) => ((g.props.class as string) ?? '').includes('flow-small-node'))
		expect(smallNodes.length).toBe(2)
	})

	test('a small node carries a box, a centered count, and a hover <title> with the label and stats', () => {
		const view: Vnode = renderFlowView(fakeH, topBarModel())
		const smallNodes = allByTag(view, 'g').filter((g) => ((g.props.class as string) ?? '').includes('flow-small-node'))
		// The first slot is "You" (no cumulative stats); the second is "Planner" with time + tokens.
		const youGroup = smallNodes[0]!
		const plannerGroup = smallNodes[1]!

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

	test('a small node is neutral: the top bar carries no per-invocation status coloring', () => {
		// The strip is cumulative/aggregate history, so a slot never turns red or green even when the role's last invocation errored.
		const model = {
			mainArea: { nodes: [{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 }], edges: [] },
			topBar: { nodes: [{ id: 'coder', kind: 'role', label: 'Coder', invocations: 1, status: 'error' }] },
		}
		const view: Vnode = renderFlowView(fakeH, model)
		const group = allByTag(view, 'g').find((g) => ((g.props.class as string) ?? '').includes('flow-small-node'))!
		expect((group.props.class as string) ?? '').toBe('flow-small-node')
	})

	test('top-bar nodes wrap into rows of TOP_BAR_PER_ROW', () => {
		const nodes = Array.from({ length: TOP_BAR_PER_ROW + 2 }, (_, i) => ({ id: `n${i}`, kind: 'role', label: `N${i}`, invocations: 1 }))
		const model = { mainArea: { nodes: [], edges: [] }, topBar: { nodes } }
		const view: Vnode = renderFlowView(fakeH, model)
		const smallNodes = allByTag(view, 'g').filter((g) => ((g.props.class as string) ?? '').includes('flow-small-node'))
		// The first TOP_BAR_PER_ROW nodes sit at row 0 (y = 0); the overflow sits at row 1 (y = SMALL_SIZE + SMALL_GAP).
		expect(smallNodes.length).toBe(TOP_BAR_PER_ROW + 2)
		const rowOne = smallNodes.slice(0, TOP_BAR_PER_ROW)
		const rowTwo = smallNodes.slice(TOP_BAR_PER_ROW)
		for (const g of rowOne) expect(g.props.transform).toContain(',0)')
		for (const g of rowTwo) expect(g.props.transform).toContain(`,${SMALL_SIZE + SMALL_GAP})`)
	})
})

// --- Animation derivation ---------------------------------------------------

// Locates a scenario by id (the fixture order is not guaranteed to be stable across edits).
function scenarioById(id: string): { frames: unknown[] } {
	const scenario = fixtures.find((item) => item.id === id)
	if (scenario === undefined) throw new Error(`unknown fixture scenario: ${id}`)
	return scenario
}

// Returns the FlowModel of a scenario's frame, narrowed through `unknown` since the JS fixtures do not advertise the field on their inferred type.
function frameModel(scenarioId: string, frameIndex: number): FlowModel {
	const scenario = scenarioById(scenarioId)
	const model = flowModelOf(scenario.frames[frameIndex])
	if (!isFlowModel(model)) throw new Error(`${scenarioId}[frame ${frameIndex}]: flowModel missing or malformed`)
	return model
}

// Returns a scenario frame's config + runView + flowModel triple, narrowed through `unknown` since the JS fixtures do not advertise those fields on their inferred frame type. Used by the product-surface derivations that consume the same shapes the live API will return.
function scenarioFrame(scenarioId: string, frameIndex: number): { config: unknown, runView: unknown, flowModel: unknown } {
	const scenario = scenarioById(scenarioId)
	const frameValue = scenario.frames[frameIndex]
	if (!isObject(frameValue)) throw new Error(`${scenarioId}[frame ${frameIndex}]: frame is not an object`)
	return { config: frameValue['config'], runView: frameValue['runView'], flowModel: flowModelOf(frameValue) }
}

// The animation state of a single edge identified by its endpoints, or undefined when no such edge exists.
function edgeState(model: FlowModel, from: string, to: string): string | undefined {
	const { edgeStates } = deriveFlowAnimation(model)
	const index = model.mainArea.edges.findIndex((edge) => edge.from === from && edge.to === to)
	if (index === -1) return undefined
	return edgeStates[index]
}

describe('deriveFlowAnimation — agent→agent delegation', () => {
	test('the call edge to the entry role is static once the entry role has produced its first turn (costTokens set)', () => {
		// delegation-in-progress frame 1: the orchestrator has already emitted an llm_call (costTokens populated), so the you→orchestrator call has settled and the orchestrator is thinking.
		const model = frameModel('delegation-in-progress', 1)
		expect(edgeState(model, 'you', 'orchestrator')).toBe('static')
	})

	test('the call edge to a child that has not produced its first turn flows left→right', () => {
		// frame 2: the orchestrator delegates to coder; coder has started (role_start) but has no llm_call yet (no costTokens), so orchestrator→coder is in flight.
		const model = frameModel('delegation-in-progress', 2)
		expect(edgeState(model, 'orchestrator', 'coder')).toBe('flowing')
		expect(edgeState(model, 'you', 'orchestrator')).toBe('static')
	})

	test('the flow moves to the child\u2019s outgoing edge once the child produces its first turn', () => {
		// single-role-in-progress walks the full arc: frame 0 the you→planner call flows (planner, no llm yet); frame 1 planner has had its llm_call (costTokens set) so you→planner settles; frame 2 the flow reappears on planner→glob_files (the outgoing tool call in flight).
		const flowing = frameModel('single-role-in-progress', 0)
		expect(edgeState(flowing, 'you', 'planner')).toBe('flowing')
		const settled = frameModel('single-role-in-progress', 1)
		expect(edgeState(settled, 'you', 'planner')).toBe('static')
		const moved = frameModel('single-role-in-progress', 2)
		expect(edgeState(moved, 'you', 'planner')).toBe('static')
		expect(edgeState(moved, 'planner', 'glob_files')).toBe('flowing')
	})
})

describe('deriveFlowAnimation — agent→tool call and tool return', () => {
	test('an in-flight tool call (no result yet) flows', () => {
		// tool-call-in-progress frame 2: coder→write_file call is in flight.
		const model = frameModel('tool-call-in-progress', 2)
		expect(edgeState(model, 'coder', 'write_file')).toBe('flowing')
	})

	test('a tool_result triggers the returning flow right→left and settles the call edge', () => {
		// frame 3: write_file has returned; a return edge write_file→coder lingers, so the coder→write_file call settles and the write_file→coder leg returns.
		const model = frameModel('tool-call-in-progress', 3)
		expect(edgeState(model, 'coder', 'write_file')).toBe('static')
		expect(edgeState(model, 'write_file', 'coder')).toBe('returning')
	})
})

describe('deriveFlowAnimation — return, question, and error edges', () => {
	test('a lingering return edge from a successfully-finished node returns right→left', () => {
		// tool-call-in-progress frame 3: write_file has returned and lingers with a return edge to coder.
		const model = frameModel('tool-call-in-progress', 3)
		expect(edgeState(model, 'write_file', 'coder')).toBe('returning')
	})

	test('a return edge from an errored node is an error edge (red, flowing)', () => {
		// retry frame 0: the builder (coder-1) errored and lingers with a return edge to the orchestrator; the return leg reads as an error edge (red, marching). The call edge into the builder is settled grey (the call itself completed; only the return leg carries the failure).
		const model = frameModel('retry', 0)
		expect(edgeState(model, 'coder-1', 'orchestrator')).toBe('error')
		expect(edgeState(model, 'orchestrator', 'coder-1')).toBe('static')
	})

	test('a pending ask_human question edge flows toward the You respondent; the call edges settle', () => {
		// pending-question frame 3: the question travels ask_human → you-ask (the respondent You); the call edges (you→orchestrator, orchestrator→ask_human) have settled because orchestrator has its first turn and ask_human has emitted its question and is waiting for the answer.
		const model = frameModel('pending-question', 3)
		expect(edgeState(model, 'ask_human', 'you-ask')).toBe('flowing')
		expect(edgeState(model, 'orchestrator', 'ask_human')).toBe('static')
		expect(edgeState(model, 'you', 'orchestrator')).toBe('static')
	})

	test('after the user answers, the child You and ask_human linger as return edges flowing right→left', () => {
		// pending-question frame 4: the question edge is gone; the child You (you-ask) returns to ask_human, and ask_human returns to the orchestrator. Both returns flow; the call edges settle because the returns now carry the motion.
		const model = frameModel('pending-question', 4)
		expect(edgeState(model, 'you-ask', 'ask_human')).toBe('returning')
		expect(edgeState(model, 'ask_human', 'orchestrator')).toBe('returning')
		expect(edgeState(model, 'orchestrator', 'ask_human')).toBe('static')
		expect(edgeState(model, 'you', 'orchestrator')).toBe('static')
	})

	test('after the answer, the orchestrator (the outermost return target) is active', () => {
		// pending-question frame 4: the orchestrator is receiving the answer (the return target of ask_human→orchestrator), so it pulses.
		const model = frameModel('pending-question', 4)
		const { activeIds } = deriveFlowAnimation(model)
		expect(activeIds.has('orchestrator')).toBe(true)
	})

	test('the child You departs to the top-bar "You" slot when the caller acts, bumping its count', () => {
		// pending-question frame 4→5: the orchestrator emits a new action, so you-ask and ask_human leave the main area for their top-bar slots. you-ask merges into the existing "You" slot (incrementing its count to 2: the root plus one completed Q&A); ask_human merges into its existing slot.
		const previous = frameModel('pending-question', 4)
		const current = frameModel('pending-question', 5)
		expect(current.mainArea.nodes.map((n) => n.id).sort()).toEqual(['orchestrator', 'you'])
		const lifecycle = deriveLifecycle(previous, current)
		const departingIds = lifecycle.departing.map((entry) => entry.node.id).sort()
		expect(departingIds).toEqual(['ask_human', 'you-ask'])
		for (const entry of lifecycle.departing) expect(entry.merged).toBe(true)
		const youSlot = current.topBar.nodes.find((node) => node.id === 'you')
		expect(youSlot).toBeDefined()
		expect(youSlot!.invocations).toBe(2)
	})

	test('the active node set mirrors the model\u2019s active flags', () => {
		// delegation-in-progress frame 1: orchestrator is thinking (active flag, no flowing edge).
		const model = frameModel('delegation-in-progress', 1)
		const { activeIds } = deriveFlowAnimation(model)
		expect(activeIds.has('orchestrator')).toBe(true)
	})

	test('during an in-flight tool call the tool (the recipient) is active, not the calling agent', () => {
		// single-role-in-progress frame 2: planner has called glob_files; the tool is the current focus, so glob_files pulses and planner does not.
		const model = frameModel('single-role-in-progress', 2)
		const { activeIds } = deriveFlowAnimation(model)
		expect(activeIds.has('glob_files')).toBe(true)
		expect(activeIds.has('planner')).toBe(false)
	})

	test('the renderer applies the derived active set, not just the model\u2019s active flag', () => {
		// retry frame 0: the error return edge coder-1→orchestrator is flowing; the conductor is the return's target so it should pulse. The conductor has no `active` flag in the model (its active state is purely edge-derived), so the renderer MUST use deriveFlowAnimation's activeIds — passing the raw model flag would leave it non-pulsing.
		const model = frameModel('retry', 0)
		const view: Vnode = renderFlowView(fakeH, model)
		// Find the orchestrator node group and check it carries the graph-node--active class.
		const activeNodes = allByTag(view, 'g').filter((g) => {
			const cls = (g.props.class as string) ?? ''
			return cls.includes('graph-node--active')
		})
		expect(activeNodes.length).toBeGreaterThan(0)
		// The orchestrator (the error return's target) should be among the active nodes, not the builder.
		const { activeIds } = deriveFlowAnimation(model)
		expect(activeIds.has('orchestrator')).toBe(true)
		expect(activeIds.has('coder-1')).toBe(false)
	})
})

describe('deriveFlowAnimation — inspect edges', () => {
	test('an inspect edge is static (an observation reference, not an in-flight call)', () => {
		// detected-loop frame 2: the watchdog's recent_role_tool_calls tool reads coder's history via an inspect edge; the inspection line never flows.
		const model = frameModel('detected-loop', 2)
		expect(edgeState(model, 'recent_role_tool_calls', 'coder')).toBe('static')
	})

	test('the watchdog\u2019s tool call flows while the inspect reference to the builder stays static', () => {
		const model = frameModel('detected-loop', 2)
		expect(edgeState(model, 'loop_detector', 'recent_role_tool_calls')).toBe('flowing')
		expect(edgeState(model, 'recent_role_tool_calls', 'coder')).toBe('static')
	})
})

describe('deriveFlowAnimation — completed run', () => {
	test('a completed run has an empty main area (only the root You) and a full top bar', () => {
		const model = frameModel('completed-success', 13)
		const mainNodes = model.mainArea.nodes
		expect(mainNodes.length).toBe(1)
		expect(mainNodes[0]!.kind).toBe('you')
		expect(model.mainArea.edges.length).toBe(0)
		// The top bar carries every role/tool that ever ran, with terminal statuses.
		const topBarIds = model.topBar.nodes.map((node) => node.id)
		expect(topBarIds).toContain('orchestrator')
		expect(topBarIds).toContain('planner')
		expect(topBarIds).toContain('coder')
		expect(topBarIds).toContain('write_file')
	})

	test('a failed run settles to only the root You with the failing role\u2019s top-bar slot in error', () => {
		const model = frameModel('failed-run', 4)
		expect(model.mainArea.nodes.length).toBe(1)
		expect(model.mainArea.nodes[0]!.kind).toBe('you')
		const coderSlot = model.topBar.nodes.find((node) => node.id === 'coder')
		expect(coderSlot).toBeDefined()
		expect(coderSlot!.status).toBe('error')
	})
})

describe('renderFlowView — edge and lifecycle classes', () => {
	function edgeClasses(view: Vnode): string[] {
		return allByTag(view, 'path')
			.filter((path) => typeof path.props.class === 'string')
			.map((path) => path.props.class as string)
	}

	test('a flowing call edge renders with the graph-edge--flowing class', () => {
		// delegation-in-progress frame 2: orchestrator→coder call is in flight.
		const model = frameModel('delegation-in-progress', 2)
		const view: Vnode = renderFlowView(fakeH, model)
		expect(edgeClasses(view).some((classes) => classes.includes('graph-edge--flowing'))).toBe(true)
	})

	test('a returning edge renders with the graph-edge--returning class', () => {
		// tool-call-in-progress frame 3: write_file→coder return edge lingers.
		const model = frameModel('tool-call-in-progress', 3)
		const view: Vnode = renderFlowView(fakeH, model)
		expect(edgeClasses(view).some((classes) => classes.includes('graph-edge--returning'))).toBe(true)
	})

	test('an error edge renders with the graph-edge--error class', () => {
		const model = frameModel('retry', 0)
		const view: Vnode = renderFlowView(fakeH, model)
		expect(edgeClasses(view).some((classes) => classes.includes('graph-edge--error'))).toBe(true)
	})

	test('an entering node carries the flow-node--entering class on an inner group', () => {
		// delegation frame 1→2: coder is newly arrived in frame 2.
		const previous = frameModel('delegation-in-progress', 1)
		const current = frameModel('delegation-in-progress', 2)
		const lifecycle = deriveLifecycle(previous, current)
		const view: Vnode = renderFlowView(fakeH, current, FLOW_VIEW_CONSTANTS.DEFAULT_MIN_COLUMNS, lifecycle)
		const enteringGroups = allByTag(view, 'g').filter((group) => typeof group.props.class === 'string' && (group.props.class as string).includes('flow-node--entering'))
		expect(enteringGroups.length).toBeGreaterThan(0)
	})

	test('a departing node renders an overlay carrying flow-node--departing with from/to travel coordinates', () => {
		// completed-success frame 4→5: planner leaves the main area for its existing top-bar slot (a merge).
		const previous = frameModel('completed-success', 4)
		const current = frameModel('completed-success', 5)
		const lifecycle = deriveLifecycle(previous, current)
		const plannerDepart = lifecycle.departing.find((entry) => entry.node.id === 'planner')
		expect(plannerDepart).toBeDefined()
		expect(plannerDepart!.merged).toBe(true)
		const view: Vnode = renderFlowView(fakeH, current, FLOW_VIEW_CONSTANTS.DEFAULT_MIN_COLUMNS, lifecycle)
		const overlay = allByTag(view, 'g').find((group) => typeof group.props.class === 'string' && (group.props.class as string).includes('flow-node--departing'))
		expect(overlay).toBeDefined()
		// The overlay travels from its previous main-area position to its top-bar slot; both coordinates are passed as `--from-*`/`--to-*` custom properties (a style object, since hyperapp routes `-`-prefixed keys through setProperty) so the single CSS keyframe serves every departing node. The travel is what makes the counter increment read as the node arriving.
		const style = overlay!.props.style as Record<string, string>
		expect(typeof style).toBe('object')
		expect(style['--from-x']).toBeDefined()
		expect(style['--to-x']).toBeDefined()
	})
})

describe('deriveLifecycle', () => {
	test('the first frame of a scenario has no entering or departing nodes', () => {
		const current = frameModel('delegation-in-progress', 0)
		const lifecycle = deriveLifecycle(undefined, current)
		expect(lifecycle.enteringIds.size).toBe(0)
		expect(lifecycle.departing.length).toBe(0)
	})

	test('a node present this frame but not last frame is entering', () => {
		// delegation frame 1→2: coder is newly arrived in frame 2.
		const previous = frameModel('delegation-in-progress', 1)
		const current = frameModel('delegation-in-progress', 2)
		const lifecycle = deriveLifecycle(previous, current)
		expect(lifecycle.enteringIds.has('coder')).toBe(true)
		expect(lifecycle.enteringIds.has('orchestrator')).toBe(false)
		expect(lifecycle.departing.length).toBe(0)
	})

	test('a node that left the main area for an existing top-bar slot departs and merges', () => {
		// completed-success frame 4→5: planner leaves the main area for the existing planner top-bar slot (a merge).
		const previous = frameModel('completed-success', 4)
		const current = frameModel('completed-success', 5)
		const lifecycle = deriveLifecycle(previous, current)
		const plannerDepart = lifecycle.departing.find((entry) => entry.node.id === 'planner')
		expect(plannerDepart).toBeDefined()
		expect(plannerDepart!.merged).toBe(true)
	})

	test('a node that departs to a brand-new slot is not a merge', () => {
		// Synthetic pair: a lone role finishes and leaves for a top-bar slot that did not exist last frame.
		const previous: FlowModel = {
			mainArea: {
				nodes: [
					{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 },
					{ id: 'planner', kind: 'role', label: 'Planner', column: 1, row: 0, status: 'success' },
				],
				edges: [{ from: 'planner', to: 'you', kind: 'return' }],
			},
			topBar: { nodes: [{ id: 'you', kind: 'you', label: 'You', invocations: 1 }] },
		}
		const current: FlowModel = {
			mainArea: { nodes: [{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 }], edges: [] },
			topBar: {
				nodes: [
					{ id: 'you', kind: 'you', label: 'You', invocations: 1 },
					{ id: 'planner', kind: 'role', label: 'Planner', invocations: 1, status: 'success' },
				],
			},
		}
		const lifecycle = deriveLifecycle(previous, current)
		expect(lifecycle.departing.length).toBe(1)
		expect(lifecycle.departing[0]!.node.id).toBe('planner')
		expect(lifecycle.departing[0]!.merged).toBe(false)
	})

	test('a completed run settles: every non-root node departs and merges into its existing slot', () => {
		// completed-success frame 12→13: orchestrator leaves the main area for its existing top-bar slot.
		const previous = frameModel('completed-success', 12)
		const current = frameModel('completed-success', 13)
		const lifecycle = deriveLifecycle(previous, current)
		// Frame 12 main area has you + orchestrator; frame 13 has only you.
		const departingIds = lifecycle.departing.map((entry) => entry.node.id).sort()
		expect(departingIds).toEqual(['orchestrator'])
		for (const entry of lifecycle.departing) expect(entry.merged).toBe(true)
	})
})

// --- Product surfaces: "now" caption + budget bar -------------------------

describe('deriveNowCaption', () => {
	test('an active worker role yields its friendly description', () => {
		// single-role-in-progress frame 1: the planner is thinking (active flag, no flowing edge), so the caption is the planner's friendly description.
		const frame = scenarioFrame('single-role-in-progress', 1)
		expect(deriveNowCaption(frame.config, frame.runView, frame.flowModel)).toBe('Looks around and figures out the plan of attack…')
	})

	test('an in-flight tool call pairs the calling role and the tool friendly labels', () => {
		// single-role-in-progress frame 2: planner→glob_files call is in flight, so the caption names both the role and the tool.
		const frame = scenarioFrame('single-role-in-progress', 2)
		const caption = deriveNowCaption(frame.config, frame.runView, frame.flowModel)
		expect(caption).toBe('The planner · Search for files…')
		expect(caption).toContain('The planner')
		expect(caption).toContain('Search for files')
	})

	test('a pending ask_human question yields the ask_human friendly description', () => {
		// pending-question frame 3: the question edge flows toward the You respondent.
		const frame = scenarioFrame('pending-question', 3)
		expect(deriveNowCaption(frame.config, frame.runView, frame.flowModel)).toBe('Needs your input before continuing…')
	})

	test('a completed run yields a completion caption', () => {
		const frame = scenarioFrame('completed-success', 13)
		expect(deriveNowCaption(frame.config, frame.runView, frame.flowModel)).toBe('Done.')
	})

	test('a failed run yields an error caption', () => {
		const frame = scenarioFrame('failed-run', 4)
		expect(deriveNowCaption(frame.config, frame.runView, frame.flowModel)).toBe('The run stopped with an error.')
	})

	test('a lingering return to the root You reads as wrapping up', () => {
		// completed-success frame 12: the orchestrator has finished and its return edge flows back to You; the run is unwinding.
		const frame = scenarioFrame('completed-success', 12)
		expect(deriveNowCaption(frame.config, frame.runView, frame.flowModel)).toBe('Wrapping up…')
	})

	test('the fallback chain uses detailed when the friendly tier is absent', () => {
		const config = {
			roles: {
				customrole: {
					tools: [],
					label: { detailed: 'Custom Role' },
					description: { detailed: 'Does the custom thing.' },
				},
			},
			tools: {},
		}
		const model: FlowModel = {
			mainArea: {
				nodes: [
					{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 },
					{ id: 'customrole', kind: 'role', label: 'Custom Role', sublabel: 'customrole', column: 1, row: 0, active: true },
				],
				edges: [{ from: 'you', to: 'customrole', kind: 'call' }],
			},
			topBar: { nodes: [] },
		}
		expect(deriveNowCaption(config, { status: 'unknown' }, model)).toBe('Does the custom thing…')
	})

	test('the fallback chain falls to a title-cased name when no description tier is present', () => {
		const config = {
			roles: {
				norole: { tools: [], label: { detailed: 'Norole' } },
			},
			tools: {},
		}
		const model: FlowModel = {
			mainArea: {
				nodes: [
					{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 },
					{ id: 'norole', kind: 'role', label: 'Norole', sublabel: 'norole', column: 1, row: 0, active: true },
				],
				edges: [{ from: 'you', to: 'norole', kind: 'call' }],
			},
			topBar: { nodes: [] },
		}
		expect(deriveNowCaption(config, { status: 'unknown' }, model)).toBe('Norole…')
	})

	test('a tool-in-flight caption falls back to the detailed tool label when friendly is absent', () => {
		const config = {
			roles: {
				coder: { tools: ['write_file'], label: { detailed: 'Coder' }, description: { detailed: 'Writes code.' } },
			},
			tools: {
				write_file: { humanLabel: { detailed: 'Write a file' }, humanDescription: { detailed: 'Writes a file.' } },
			},
		}
		const model: FlowModel = {
			mainArea: {
				nodes: [
					{ id: 'you', kind: 'you', label: 'You', column: 0, row: 0 },
					{ id: 'coder', kind: 'role', label: 'Coder', sublabel: 'coder', column: 1, row: 0, costTokens: 100 },
					{ id: 'write_file', kind: 'tool', label: 'Write a file', column: 2, row: 0 },
				],
				edges: [
					{ from: 'you', to: 'coder', kind: 'call' },
					{ from: 'coder', to: 'write_file', kind: 'call' },
				],
			},
			topBar: { nodes: [] },
		}
		expect(deriveNowCaption(config, { status: 'unknown' }, model)).toBe('Coder · Write a file…')
	})
})
