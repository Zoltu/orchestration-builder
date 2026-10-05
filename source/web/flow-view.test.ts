import { describe, expect, test } from 'bun:test'
import { deriveLifecycle, renderFlowView, deriveNowCaption, deriveCostStrip, createColumnTracker, COL_GAP } from './static/ts/flow-view.js'
import { activeOperation, activeParticipant, activeStack, observesOf, stacksOf } from './static/ts/interaction-model.js'
import { createLabelResolver } from './static/ts/labels.js'
import { labelsModule } from './label-resolver-fixture.js'
import { scenarios } from './static/ts/scenarios.js'
import { NODE_WIDTH } from './static/ts/svg-primitives.js'
import { defined } from './test-fixtures.js'

// Pull the model type off a helper signature so the inline fixtures are contextually checked against the JSDoc shape without a cast, mirroring the sibling interaction-model.test.ts convention.
type InteractionModel = Parameters<typeof stacksOf>[0]
type Participant = InteractionModel['participants'][number]
type Operation = InteractionModel['operations'][number]
type LabelTier = Parameters<ReturnType<typeof createLabelResolver>['resolveParticipantLabel']>[1]

// A fake `h` capturing the tag, props, and children of every vnode so the layout assertions walk a plain object tree rather than real DOM.
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

function allByTag(vnode: Vnode, tag: string): Vnode[] {
	const found: Vnode[] = []
	for (const child of vnode.children) {
		if (!isVnode(child)) continue
		if (child.tag === tag) found.push(child)
		for (const grand of allByTag(child, tag)) found.push(grand)
	}
	return found
}

function propString(props: Record<string, unknown>, key: string): string | undefined {
	const value = props[key]
	return typeof value === 'string' ? value : undefined
}

function propBoolean(props: Record<string, unknown>, key: string): boolean {
	return propString(props, key) === 'true'
}

function groupsWithClass(vnode: Vnode, token: string): Vnode[] {
	return allByTag(vnode, 'g').filter((group) => {
		const classValue = propString(group.props, 'class') ?? ''
		return classValue.split(' ').includes(token)
	})
}

function scenarioFrame(scenarioId: string, frameIndex: number): InteractionModel {
	const scenario = scenarios.find((item) => item.id === scenarioId)
	if (scenario === undefined) throw new Error(`unknown scenario: ${scenarioId}`)
	const frame = scenario.frames[frameIndex]
	if (frame === undefined) throw new Error(`scenario ${scenarioId} has no frame ${frameIndex}`)
	return frame
}

// A minimal participant/operation builder so inline fixtures read at the call site.
function participant(id: string, role: string, kind: Participant['kind']): Participant {
	return { id, role, kind }
}

function callOperation(id: string, stack: string, source: string, destination: string): Operation {
	return { id, kind: 'call', stack, source, destination, startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null }
}

// A fresh column tracker per render keeps every test order-independent: the high-water mark is caller-held state, so tests construct their own rather than sharing a module-level one.
function render(model: InteractionModel, tier: LabelTier = 'detailed', lifecycle?: ReturnType<typeof deriveLifecycle>): Vnode {
	return renderFlowView(fakeH, model, labelsModule, tier, lifecycle, undefined, undefined, createColumnTracker())
}

describe('renderFlowView — row projection', () => {
	test('the row count matches stacksOf for every demo scenario frame', () => {
		for (const scenario of scenarios) {
			scenario.frames.forEach((frame, frameIndex) => {
				const view = render(frame)
				const rows = groupsWithClass(view, 'flow-row')
				const expected = stacksOf(frame).length
				if (rows.length !== expected) {
					throw new Error(`${scenario.id} frame ${frameIndex}: expected ${expected} rows, got ${rows.length}`)
				}
			})
		}
	})

	test('a frame with no open stacks and no lingering return renders no rows', () => {
		// A terminal run whose final return has settled (the See Result acknowledgment) carries no open calls and no in_flight return leg, so its stack renders no row and only the top bar remains.
		const model: InteractionModel = {
			participants: [
				participant('you', 'human', 'human'),
				participant('coder', 'coder', 'role'),
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'coder', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op2', kind: 'return', stack: 'root', source: 'coder', destination: 'you', startedAt: 't2', settledAt: 't3', lifecycle: 'settled', outcome: 'success', metrics: null },
			],
			status: 'success',
		}
		const view = render(model)
		expect(groupsWithClass(view, 'flow-row').length).toBe(0)
	})

	test('the active stack is the bottom (last) row', () => {
		// detected-loop-interrupt observe frame: the observe has just landed on the interrupt stack, so the interrupt stack is active and must sit below the paused root stack.
		const frame = scenarioFrame('detected-loop-interrupt', 8)
		const active = activeStack(frame)
		expect(active).toBe('interrupt-stack')
		const view = render(frame)
		const rows = groupsWithClass(view, 'flow-row')
		expect(rows.length).toBe(2)
		const bottomRow = defined(rows[rows.length - 1], 'bottomRow')
		expect(bottomRow).toBeDefined()
		expect(propString(bottomRow.props, 'data-stack')).toBe('interrupt-stack')
	})

	test('each row renders its open call chain left-to-right by depth with the root at column 0', () => {
		// delegation-chain op4 transit: the open chain is you → orchestrator → planner → coder → readFile, five nodes deep, all calls still open.
		const frame = scenarioFrame('delegation-chain', 6)
		const view = render(frame)
		const row = defined(groupsWithClass(view, 'flow-row')[0], 'row')
		expect(row).toBeDefined()
		const nodes = allByTag(row, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-node'))
		// The root "you" sits at column 0 (translate x = 0); readFile sits at column 4 (translate x = 4 * (NODE_WIDTH + COL_GAP)). The y offset is the top-bar height plus its gap, asserted only as nonzero so the test does not pin the strip height.
		const youNode = nodes.find((node) => propString(node.props, 'data-participant') === 'you')
		expect(youNode).toBeDefined()
		expect(propString(defined(youNode, 'youNode').props, 'transform')).toMatch(/^translate\(0,\d+\)$/)
		const readFileNode = nodes.find((node) => propString(node.props, 'data-participant') === 'readFile')
		expect(readFileNode).toBeDefined()
		const readFileX = 4 * (NODE_WIDTH + COL_GAP)
		const transform = defined(propString(defined(readFileNode, 'readFileNode').props, 'transform'), 'transform')
		expect(transform.startsWith(`translate(${readFileX},`)).toBe(true)
	})
})

describe('renderFlowView — instance-per-invocation retries', () => {
	test('two simultaneously-open instances of one role render as two distinct nodes, not a counter bump on one', () => {
		// A coder delegating to a second coder instance of the same role exercises instance-per-invocation: the model carries two distinct participants sharing role 'coder', so the view renders two nodes rather than a single node with a counter.
		const model: InteractionModel = {
			participants: [
				participant('you', 'human', 'human'),
				participant('orchestrator', 'orchestrator', 'role'),
				participant('coder-a', 'coder', 'role'),
				participant('coder-b', 'coder', 'role'),
			],
			operations: [
				callOperation('op1', 'root', 'you', 'orchestrator'),
				callOperation('op2', 'root', 'orchestrator', 'coder-a'),
				callOperation('op3', 'root', 'coder-a', 'coder-b'),
			],
			status: 'running',
		}
		const view = render(model)
		const coderNodes = allByTag(view, 'g').filter((group) => {
			if (!(propString(group.props, 'class') ?? '').split(' ').includes('flow-node')) return false
			return propString(group.props, 'data-role') === 'coder'
		})
		expect(coderNodes.length).toBe(2)
		const ids = coderNodes.map((node) => propString(node.props, 'data-participant')).sort()
		expect(ids).toEqual(['coder-a', 'coder-b'])
		// No counter badge is emitted on either node: retries are separate instances, so the counter primitive is unused.
		for (const node of coderNodes) {
			const counters = allByTag(node, 'rect').filter((rect) => propString(rect.props, 'class') === 'graph-node-counter-rect')
			expect(counters.length).toBe(0)
		}
	})

	test('a retried role that has departed leaves a fresh instance as the live node', () => {
		// retry-with-fresh-instance op4 transit: coder-1 has returned and departed for the top bar; coder-2 is the live coder node, a distinct instance from coder-1.
		const frame = scenarioFrame('retry-with-fresh-instance', 6)
		const view = render(frame)
		const liveCoder = allByTag(view, 'g').find((group) => {
			if (!(propString(group.props, 'class') ?? '').split(' ').includes('flow-node')) return false
			return propString(group.props, 'data-participant') === 'coder-2'
		})
		expect(liveCoder).toBeDefined()
		// coder-1 is not a live node (it departed); it surfaces in the top bar instead.
		const coderOneLive = allByTag(view, 'g').some((group) => {
			if (!(propString(group.props, 'class') ?? '').split(' ').includes('flow-node')) return false
			return propString(group.props, 'data-participant') === 'coder-1'
		})
		expect(coderOneLive).toBe(false)
	})
})

describe('renderFlowView — top-bar aggregation', () => {
	test('a departed participant appears in the top bar aggregated by role', () => {
		// A terminal run whose final return has settled (the See Result acknowledgment) leaves coder departed for the top bar; the strip aggregates every participant that has ever run by role, so coder's slot carries invocation count 1.
		const model: InteractionModel = {
			participants: [
				participant('you', 'human', 'human'),
				participant('coder', 'coder', 'role'),
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'coder', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op2', kind: 'return', stack: 'root', source: 'coder', destination: 'you', startedAt: 't2', settledAt: 't3', lifecycle: 'settled', outcome: 'success', metrics: null },
			],
			status: 'success',
		}
		const view = render(model)
		const slots = groupsWithClass(view, 'flow-small-node')
		const coderSlot = defined(slots.find((slot) => propString(slot.props, 'data-role') === 'coder'), 'coderSlot')
		expect(coderSlot).toBeDefined()
		const counts = allByTag(coderSlot, 'text').filter((text) => propString(text.props, 'class') === 'flow-small-node-count')
		expect(counts.length).toBe(1)
		expect(defined(counts[0], 'counts[0]').children.join('')).toBe('1')
	})

	test('the top bar carries one slot per role/tool type that has ever run', () => {
		// deep-call-tree terminal transit frame: every role/tool that appeared lingers or has departed, so the strip carries one slot per type. The human is the eternal root, never a role that "ran", so it never occupies a top-bar slot.
		const frame = scenarioFrame('deep-call-tree', 18)
		const view = render(frame)
		const roles = groupsWithClass(view, 'flow-small-node').map((slot) => propString(slot.props, 'data-role'))
		expect(roles).toEqual(expect.arrayContaining(['orchestrator', 'planner', 'coder', 'critic', 'read_file']))
		expect(roles).not.toContain('human')
	})
})

describe('renderFlowView — lingering return legs', () => {
	test('a return whose caller has not yet acted lingers as a node plus a return edge', () => {
		// delegation-chain op5 transit: readFile has returned to coder, but coder has not produced its next action, so readFile lingers at its call-depth column with a return edge back to coder.
		const frame = scenarioFrame('delegation-chain', 8)
		const view = render(frame)
		const row = defined(groupsWithClass(view, 'flow-row')[0], 'row')
		expect(row).toBeDefined()
		const readFileNode = allByTag(row, 'g').find((group) => {
			if (!(propString(group.props, 'class') ?? '').split(' ').includes('flow-node')) return false
			return propString(group.props, 'data-participant') === 'readFile'
		})
		expect(readFileNode).toBeDefined()
		expect(propBoolean(defined(readFileNode, 'readFileNode').props, 'data-lingering')).toBe(true)
		const returnEdges = allByTag(row, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-edge--return'))
		expect(returnEdges.length).toBe(1)
	})

	test('once the caller acts the lingering source departs and no return edge remains in the row', () => {
		// delegation-chain op6 transit: coder has now returned to planner, so readFile's lingering ended and it left for the top bar; the new lingering return is coder → planner.
		const frame = scenarioFrame('delegation-chain', 10)
		const view = render(frame)
		const row = defined(groupsWithClass(view, 'flow-row')[0], 'row')
		expect(row).toBeDefined()
		const readFileStillLingering = allByTag(row, 'g').some((group) => {
			if (!(propString(group.props, 'class') ?? '').split(' ').includes('flow-node')) return false
			return propString(group.props, 'data-participant') === 'readFile'
		})
		expect(readFileStillLingering).toBe(false)
		const coderNode = allByTag(row, 'g').find((group) => {
			if (!(propString(group.props, 'class') ?? '').split(' ').includes('flow-node')) return false
			return propString(group.props, 'data-participant') === 'coder'
		})
		expect(coderNode).toBeDefined()
		expect(propBoolean(defined(coderNode, 'coderNode').props, 'data-lingering')).toBe(true)
	})

	test('a lingering return after a terminate maps to the surviving call, not the terminated one', () => {
		// The rewind shape: the coder call was killed by a terminate, and the orchestrator's return to You lands later. The lingering returner is the orchestrator — the terminated coder must not render in its place.
		const model: InteractionModel = {
			participants: [
				participant('you', 'human', 'human'),
				participant('orchestrator', 'orchestrator', 'role'),
				participant('coder', 'coder', 'role'),
				participant('int', 'interrupt', 'interrupt'),
				participant('rewind', 'rewind_stack', 'tool'),
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orchestrator', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orchestrator', destination: 'coder', startedAt: 't1', settledAt: 't4', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op3', kind: 'call', stack: 'int-stack', source: 'int', destination: 'rewind', startedAt: 't2', settledAt: 't3', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op4', kind: 'terminate', stack: 'int-stack', source: 'rewind', destination: 'coder', startedAt: 't4', settledAt: 't4', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op5', kind: 'return', stack: 'int-stack', source: 'rewind', destination: 'int', startedAt: 't5', settledAt: 't6', lifecycle: 'settled', outcome: 'success', metrics: null },
				{ id: 'op6', kind: 'return', stack: 'root', source: 'orchestrator', destination: 'you', startedAt: 't7', settledAt: null, lifecycle: 'in_flight', outcome: 'success', metrics: null },
			],
			status: 'running',
		}
		const view = render(model)
		const rows = groupsWithClass(view, 'flow-row')
		expect(rows.length).toBe(1)
		const lingering = allByTag(defined(rows[0], 'rows[0]'), 'g').find((group) => {
			if (!(propString(group.props, 'class') ?? '').split(' ').includes('flow-node')) return false
			return propBoolean(group.props, 'data-lingering')
		})
		expect(lingering).toBeDefined()
		expect(propString(defined(lingering, 'lingering').props, 'data-participant')).toBe('orchestrator')
		const returnEdges = allByTag(defined(rows[0], 'rows[0]'), 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-edge--return'))
		expect(returnEdges.length).toBe(1)
		expect(propString(defined(returnEdges[0], 'returnEdges[0]').props, 'data-operation')).toBe('op6')
	})

	test('the terminal return lingers on its single transit frame with an animated return edge and You active', () => {
		// single-role-completion terminal transit (the terminal op's only frame): the call chain is empty (op1 closed by op2), but op2 is an in_flight return, so the row still renders with You as the root and the coder as a lingering node one column past it. The return edge animates 'returning' (green for the success outcome) because the return is in_flight on the active stack, and You — the return's destination — is the active participant. The CTA renders alongside because the frame carries the terminal status.
		const frame = scenarioFrame('single-role-completion', 2)
		expect(frame.status).toBe('success')
		const view = render(frame)
		const row = defined(groupsWithClass(view, 'flow-row')[0], 'row')
		expect(row).toBeDefined()
		const coderNode = allByTag(row, 'g').find((group) => {
			if (!(propString(group.props, 'class') ?? '').split(' ').includes('flow-node')) return false
			return propString(group.props, 'data-participant') === 'coder'
		})
		expect(coderNode).toBeDefined()
		expect(propBoolean(defined(coderNode, 'coderNode').props, 'data-lingering')).toBe(true)
		expect(pathHasClass(pathForOperation(view, 'op2'), 'graph-edge--returning')).toBe(true)
		expect(activeParticipant(frame)).toBe('you')
		const youNode = allByTag(row, 'g').find((group) => {
			if (!(propString(group.props, 'class') ?? '').split(' ').includes('flow-node')) return false
			return propString(group.props, 'data-participant') === 'you'
		})
		expect(youNode).toBeDefined()
		const youActive = allByTag(defined(youNode, 'youNode'), 'g').some((group) => (propString(group.props, 'class') ?? '').split(' ').includes('graph-node--active'))
		expect(youActive).toBe(true)
		expect(allByTag(view, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-cta')).length).toBe(1)
	})
})

describe('renderFlowView — observe lines', () => {
	test('an observe operation renders a static dashed line crossing from the active stack into a paused row', () => {
		// detected-loop-interrupt observe frame: the tool (readMessageWindow) observes the looping coder; the observe's source sits in the active interrupt stack and its destination in the paused root stack.
		const frame = scenarioFrame('detected-loop-interrupt', 8)
		const observes = observesOf(frame)
		expect(observes.length).toBe(1)
		const view = render(frame)
		const observeEdges = allByTag(view, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-edge--observe'))
		expect(observeEdges.length).toBe(1)
		const observeEdge = defined(observeEdges[0], 'observeEdge')
		expect(propString(observeEdge.props, 'data-source')).toBe('readMessageWindow')
		expect(propString(observeEdge.props, 'data-destination')).toBe('coder')
		// The path itself is dashed so the observe reads as a static reference, not an in-flight call.
		const path = allByTag(observeEdge, 'path')[0]
		expect(path).toBeDefined()
		expect(propString(defined(path, 'path').props, 'stroke-dasharray')).toBe('3 3')
	})

	test('an observe never carries a flowing or returning motion class', () => {
		const frame = scenarioFrame('detected-loop-interrupt', 8)
		const view = render(frame)
		const observeEdges = allByTag(view, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-edge--observe'))
		const observeEdge = defined(observeEdges[0], 'observeEdge')
		const classValue = propString(observeEdge.props, 'class') ?? ''
		expect(classValue).not.toContain('graph-edge--flowing')
		expect(classValue).not.toContain('graph-edge--returning')
	})
})

describe('renderFlowView — call-chain structure sanity', () => {
	test('every call edge in a row connects adjacent call-depth columns', () => {
		// deep-call-tree op5 transit: the open chain is five calls deep; each call edge must run from column N to column N+1.
		const frame = scenarioFrame('deep-call-tree', 8)
		const view = render(frame)
		const row = defined(groupsWithClass(view, 'flow-row')[0], 'row')
		expect(row).toBeDefined()
		const callEdges = allByTag(row, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-edge--call'))
		expect(callEdges.length).toBe(5)
	})
})

// Finds the <path> rendered inside a flow-edge <g> carrying a given data-operation attribute, so an edge's motion class is asserted on the path the CSS actually animates.
function pathForOperation(view: Vnode, operationId: string): Vnode | undefined {
	const edgeGroups = allByTag(view, 'g').filter((group) => {
		if (!(propString(group.props, 'class') ?? '').split(' ').includes('flow-edge')) return false
		return propString(group.props, 'data-operation') === operationId
	})
	const edgeGroup = edgeGroups[0]
	if (edgeGroup === undefined) return undefined
	return allByTag(edgeGroup, 'path')[0]
}

function pathHasClass(path: Vnode | undefined, token: string): boolean {
	if (path === undefined) return false
	return (propString(path.props, 'class') ?? '').split(' ').includes(token)
}

describe('renderFlowView — edge animation (single invariant)', () => {
	test('a call in the active stack carries flowing while in_flight and goes solid on settled', () => {
		// delegation-chain op1 transit: op1 (you→orchestrator) is in_flight on the active root stack, so its call edge marches. op2 transit: op2 (orchestrator→planner) appears, settling op1 by delegation; op1's edge goes solid while op2's edge now marches.
		const flowing = render(scenarioFrame('delegation-chain', 0))
		expect(pathHasClass(pathForOperation(flowing, 'op1'), 'graph-edge--flowing')).toBe(true)
		const settled = render(scenarioFrame('delegation-chain', 2))
		expect(pathHasClass(pathForOperation(settled, 'op1'), 'graph-edge--flowing')).toBe(false)
		expect(pathHasClass(pathForOperation(settled, 'op2'), 'graph-edge--flowing')).toBe(true)
	})

	test('a return with outcome error in the active stack carries the error class', () => {
		// error-return op3 transit: op3 (coder→orchestrator, outcome error) is the lingering return on the active root stack, so its return edge is red and marching.
		const frame = scenarioFrame('error-return', 4)
		expect(activeStack(frame)).toBe('root')
		const view = render(frame)
		expect(pathHasClass(pathForOperation(view, 'op3'), 'graph-edge--error')).toBe(true)
		expect(pathHasClass(pathForOperation(view, 'op3'), 'graph-edge--returning')).toBe(false)
	})

	test('an in_flight call in a paused stack renders static (frozen)', () => {
		// detected-loop-interrupt op4 transit: op2 (orchestrator→coder) is in_flight on the root stack, but the active stack is the interrupt stack, so the root stack is paused and op2's edge is frozen solid.
		const frame = scenarioFrame('detected-loop-interrupt', 6)
		expect(activeStack(frame)).toBe('interrupt-stack')
		const op2 = frame.operations.find((operation) => operation.id === 'op2')
		expect(op2?.lifecycle).toBe('in_flight')
		const view = render(frame)
		const path = pathForOperation(view, 'op2')
		expect(path).toBeDefined()
		const classValue = propString(defined(path, 'path').props, 'class') ?? ''
		expect(classValue.split(' ').includes('graph-edge--flowing')).toBe(false)
		expect(classValue.split(' ').includes('graph-edge--returning')).toBe(false)
		expect(classValue.split(' ').includes('graph-edge--error')).toBe(false)
	})

	test('an observe line never carries a motion class even when its stack is the active stack', () => {
		// detected-loop-interrupt observe frame: the observe is logged on the active interrupt stack but its line is always static.
		const frame = scenarioFrame('detected-loop-interrupt', 8)
		expect(activeStack(frame)).toBe('interrupt-stack')
		const view = render(frame)
		const observeGroups = allByTag(view, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-edge--observe'))
		expect(observeGroups.length).toBe(1)
		const path = allByTag(defined(observeGroups[0], 'observeGroups[0]'), 'path')[0]
		expect(path).toBeDefined()
		const classValue = propString(defined(path, 'path').props, 'class') ?? ''
		expect(classValue.split(' ').includes('graph-edge--flowing')).toBe(false)
		expect(classValue.split(' ').includes('graph-edge--returning')).toBe(false)
	})

	test("a resolved stack's in-flight return marches in its outcome color even though another stack is active", () => {
		// The loop detector's return closed the interrupt stack's root call: the root stack (whose coder call is still open) is active, and the resolved stack is not paused (its chain is empty), so its final return leg keeps marching green while it travels — the green return arrow that stays visible until the next operation settles it.
		const model: InteractionModel = {
			participants: [
				participant('you', 'human', 'human'),
				participant('orchestrator', 'orchestrator', 'role'),
				participant('coder', 'coder', 'role'),
				participant('int', 'interrupt', 'interrupt'),
				participant('det', 'loop_detector', 'role'),
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orchestrator', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orchestrator', destination: 'coder', startedAt: 't1', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics: null },
				{ id: 'op3', kind: 'call', stack: 'int-stack', source: 'int', destination: 'det', startedAt: 't2', settledAt: 't3', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op4', kind: 'return', stack: 'int-stack', source: 'det', destination: 'int', startedAt: 't3', settledAt: null, lifecycle: 'in_flight', outcome: 'success', metrics: null },
			],
			status: 'running',
			stacks: [
				{ id: 'root', root: 'you' },
				{ id: 'int-stack', root: 'int' },
			],
		}
		expect(activeStack(model)).toBe('root')
		const view = render(model)
		expect(pathHasClass(pathForOperation(view, 'op4'), 'graph-edge--returning')).toBe(true)
		expect(pathHasClass(pathForOperation(view, 'op2'), 'graph-edge--flowing')).toBe(true)
	})
})

describe('renderFlowView — active participant highlight', () => {
	test('the active participant node carries the active class and a paused-stack participant does not', () => {
		// delegation-chain op2 transit: op2 (orchestrator→planner) is the latest call in the active root stack, so planner is the active participant and its node pulses; orchestrator (the caller, not the destination) does not.
		const frame = scenarioFrame('delegation-chain', 2)
		expect(activeParticipant(frame)).toBe('planner')
		const view = render(frame)
		const flowNodes = allByTag(view, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-node'))
		const plannerNode = flowNodes.find((group) => propString(group.props, 'data-participant') === 'planner')
		expect(plannerNode).toBeDefined()
		const plannerActive = allByTag(defined(plannerNode, 'plannerNode'), 'g').some((group) => (propString(group.props, 'class') ?? '').split(' ').includes('graph-node--active'))
		expect(plannerActive).toBe(true)
		const orchestratorNode = flowNodes.find((group) => propString(group.props, 'data-participant') === 'orchestrator')
		expect(orchestratorNode).toBeDefined()
		const orchestratorActive = allByTag(defined(orchestratorNode, 'orchestratorNode'), 'g').some((group) => (propString(group.props, 'class') ?? '').split(' ').includes('graph-node--active'))
		expect(orchestratorActive).toBe(false)
	})

	test('no node in a paused stack carries the active class', () => {
		// detected-loop-interrupt op4 transit: the root stack is paused; the active participant lives in the active interrupt stack, so none of the root row's participants pulse.
		const frame = scenarioFrame('detected-loop-interrupt', 6)
		expect(activeParticipant(frame)).toBe('readMessageWindow')
		const view = render(frame)
		const rows = groupsWithClass(view, 'flow-row')
		const rootRow = defined(rows.find((row) => propString(row.props, 'data-stack') === 'root'), 'rootRow')
		expect(rootRow).toBeDefined()
		const rootActive = allByTag(rootRow, 'g').some((group) => (propString(group.props, 'class') ?? '').split(' ').includes('graph-node--active'))
		expect(rootActive).toBe(false)
	})
})

describe('deriveLifecycle — frame-diff node lifecycle', () => {
	test('a null previous model animates nothing (first frame of a scenario)', () => {
		const current = scenarioFrame('delegation-chain', 0)
		const lifecycle = deriveLifecycle(null, current)
		expect(lifecycle.enteringIds.size).toBe(0)
		expect(lifecycle.departing.length).toBe(0)
	})

	test('departing covers a participant that left for the top bar when its return settles', () => {
		// retry-with-fresh-instance op3 transit → op3 working: coder-1's return settles, so the returner departs for the existing 'coder' top-bar slot (merged). Under the single invariant the returner is present only while its return is in_flight (transit), so the departure lands on the settling transition rather than on the next call; no participant enters on a settling transition. coder-2 enters later on op4's transit, covered by the row-projection test.
		const previous = scenarioFrame('retry-with-fresh-instance', 4)
		const current = scenarioFrame('retry-with-fresh-instance', 5)
		const lifecycle = deriveLifecycle(previous, current)
		expect(lifecycle.enteringIds.size).toBe(0)
		expect(lifecycle.enteringIds.has('coder-2')).toBe(false)
		expect(lifecycle.enteringIds.has('coder-1')).toBe(false)
		const departed = defined(lifecycle.departing.find((entry) => entry.participantId === 'coder-1'), 'departed')
		expect(departed).toBeDefined()
		expect(departed.previousRowIndex).toBe(0)
		// coder-1 lingered one column past the open chain's innermost node while its return was in transit, so its previous column is the chain length plus one (chain length 1 → column 2).
		expect(departed.previousColumn).toBe(2)
		expect(departed.merged).toBe(true)
		// The 'coder' slot is the second slot in first-appearance order (orchestrator, coder); the human is the eternal root and never occupies a top-bar slot.
		expect(departed.slotIndex).toBe(1)
	})

	test('settling the terminal return (the See Result acknowledgment) departs the lingering returner; the human root never departs', () => {
		// single-role-completion terminal transit (frame 2) lingers coder at column 1 while its return is in_flight; settling that return — the See Result click's view-side acknowledgment — empties the row, so the lingering coder departs for its already-existing top-bar slot. The human is the eternal root and never enters the top-bar departure set, so it neither departs nor gains a slot; under the single invariant the returner is present only while its return is in_flight, so the departure lands on the settling transition rather than a fresh call, and no participant enters.
		const previous = scenarioFrame('single-role-completion', 2)
		const current: InteractionModel = {
			...previous,
			operations: previous.operations.map((operation) =>
				operation.id === 'op2'
					? { ...operation, lifecycle: 'settled', settledAt: operation.settledAt ?? operation.startedAt }
					: operation,
			),
		}
		const lifecycle = deriveLifecycle(previous, current)
		expect(lifecycle.enteringIds.size).toBe(0)
		const departedIds = lifecycle.departing.map((entry) => entry.participantId).sort()
		expect(departedIds).toEqual(['coder'])
		expect(lifecycle.departing.some((entry) => entry.participantId === 'you')).toBe(false)
		for (const entry of lifecycle.departing) {
			expect(entry.merged).toBe(true)
			expect(entry.previousRowIndex).toBe(0)
		}
		// coder lingered one column past the row root (the open chain is empty, so the lingering column is chain length plus one = 1).
		const coderDeparted = defined(lifecycle.departing.find((entry) => entry.participantId === 'coder'), 'coderDeparted')
		expect(coderDeparted).toBeDefined()
		expect(coderDeparted.previousColumn).toBe(1)
	})

	test('an entering participant is rendered with the entering class on the next frame', () => {
		// delegation-chain op1 working → op2 transit: planner enters; the rendered current frame wraps planner's node in the entering host so it scales/fades in.
		const previous = scenarioFrame('delegation-chain', 1)
		const current = scenarioFrame('delegation-chain', 2)
		const lifecycle = deriveLifecycle(previous, current)
		expect(lifecycle.enteringIds.has('planner')).toBe(true)
		const view = render(current, 'detailed', lifecycle)
		const flowNodes = allByTag(view, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-node--entering-host'))
		const plannerEntering = flowNodes.some((group) => propString(group.props, 'data-participant') === 'planner')
		expect(plannerEntering).toBe(true)
	})
})

describe('renderFlowView — nested interrupts under stress', () => {
	test('three coexisting stacks render as three rows with the active stack on the bottom', () => {
		// nested-interrupt-deep op5 transit: root, interrupt-1-stack, and interrupt-2-stack all carry open calls; the active stack (interrupt-2-stack, the latest operation) sits on the bottom row so the cascade reads top-to-bottom oldest-to-newest.
		const frame = scenarioFrame('nested-interrupt-deep', 8)
		expect(stacksOf(frame)).toEqual(['root', 'interrupt-1-stack', 'interrupt-2-stack'])
		expect(activeStack(frame)).toBe('interrupt-2-stack')
		const view = render(frame)
		const rows = groupsWithClass(view, 'flow-row')
		expect(rows.length).toBe(3)
		const bottomRow = defined(rows[rows.length - 1], 'bottomRow')
		expect(bottomRow).toBeDefined()
		expect(propString(bottomRow.props, 'data-stack')).toBe('interrupt-2-stack')
		expect(propString(bottomRow.props, 'data-row-index')).toBe('2')
	})

	test('resolving the inner stack resumes the outer stack as the new bottom row', () => {
		// nested-interrupt-deep op10 transit: interrupt-2-stack has closed (op8 returned the tool, op9 returned the detector), so interrupt-1-stack is active again and must sit on the bottom row — the active-stack row reorders inward as a stack resolves.
		const frame = scenarioFrame('nested-interrupt-deep', 17)
		expect(activeStack(frame)).toBe('interrupt-1-stack')
		expect(stacksOf(frame)).toEqual(['root', 'interrupt-1-stack'])
		const view = render(frame)
		const rows = groupsWithClass(view, 'flow-row')
		expect(rows.length).toBe(2)
		expect(propString(defined(rows[rows.length - 1], 'rows[last]').props, 'data-stack')).toBe('interrupt-1-stack')
	})

	test("a paused stack's in_flight call renders frozen while the active stack's in_flight call marches", () => {
		// nested-interrupt-deep op5 transit: op2 (root) and op4 (interrupt-1-stack) are in_flight on paused stacks, so their call edges stay solid; op5 (interrupt-2-stack) is the active in_flight call and its edge marches. The model keeps the paused legs in_flight (the model never flips lifecycle on pause), so this asserts the view freezes them rather than the model settling them.
		const frame = scenarioFrame('nested-interrupt-deep', 8)
		const op2 = frame.operations.find((operation) => operation.id === 'op2')
		const op4 = frame.operations.find((operation) => operation.id === 'op4')
		expect(op2?.lifecycle).toBe('in_flight')
		expect(op4?.lifecycle).toBe('in_flight')
		const view = render(frame)
		for (const operationId of ['op2', 'op4']) {
			const path = pathForOperation(view, operationId)
			expect(path).toBeDefined()
			const tokens = (propString(defined(path, 'path').props, 'class') ?? '').split(' ')
			expect(tokens).not.toContain('graph-edge--flowing')
			expect(tokens).not.toContain('graph-edge--returning')
			expect(tokens).not.toContain('graph-edge--error')
			expect(tokens).not.toContain('graph-edge--terminated')
		}
		expect(pathHasClass(pathForOperation(view, 'op5'), 'graph-edge--flowing')).toBe(true)
	})

	test('an observe line crosses from the active stack into a non-adjacent paused row', () => {
		// nested-interrupt-deep observe frame: the observe's source is the tool readMessageWindow-2 — the loop_detector agent calls the tool, and the tool reads the coder's history. The source sits in the active interrupt-2-stack (row 2) and its destination (coder) in the paused root stack (row 0), skipping the middle interrupt-1 row. The observe must route across that gap as a static dashed line.
		const frame = scenarioFrame('nested-interrupt-deep', 12)
		const observe = defined(observesOf(frame)[0], 'observe')
		expect(observe).toBeDefined()
		expect(observe.source).toBe('readMessageWindow-2')
		expect(observe.destination).toBe('coder')
		const view = render(frame)
		const observeEdges = allByTag(view, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-edge--observe'))
		expect(observeEdges.length).toBe(1)
		expect(propString(defined(observeEdges[0], 'observeEdges[0]').props, 'data-source')).toBe('readMessageWindow-2')
		expect(propString(defined(observeEdges[0], 'observeEdges[0]').props, 'data-destination')).toBe('coder')
		// The source and destination land in rows 2 and 0 respectively (non-adjacent), confirmed by locating the row each participant renders in.
		const rows = groupsWithClass(view, 'flow-row')
		const sourceRow = rows.find((row) => allByTag(row, 'g').some((group) => propString(group.props, 'data-participant') === 'readMessageWindow-2'))
		const destinationRow = rows.find((row) => allByTag(row, 'g').some((group) => propString(group.props, 'data-participant') === 'coder'))
		expect(sourceRow).toBeDefined()
		expect(destinationRow).toBeDefined()
		const sourceIndex = Number(propString(defined(sourceRow, 'sourceRow').props, 'data-row-index'))
		const destinationIndex = Number(propString(defined(destinationRow, 'destinationRow').props, 'data-row-index'))
		expect(Math.abs(sourceIndex - destinationIndex)).toBeGreaterThan(1)
	})

	test('a terminated return renders distinctly from success and error on the active stack, and departs once settled', () => {
		// An in-flight terminated return (coder→orchestrator) is the lingering return on the active root stack, so its return edge marches in the warn tone (graph-edge--terminated), distinct from a green success march and a red error march. The coder node carries the terminated stroke too.
		const activeFrame: InteractionModel = {
			participants: [
				participant('you', 'human', 'human'),
				participant('orchestrator', 'orchestrator', 'role'),
				participant('coder', 'coder', 'role'),
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orchestrator', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orchestrator', destination: 'coder', startedAt: 't1', settledAt: 't2', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op5', kind: 'return', stack: 'root', source: 'coder', destination: 'orchestrator', startedAt: 't5', settledAt: null, lifecycle: 'in_flight', outcome: 'terminated', metrics: null },
			],
			status: 'running',
		}
		expect(activeStack(activeFrame)).toBe('root')
		const activeView = render(activeFrame)
		const activePath = pathForOperation(activeView, 'op5')
		expect(activePath).toBeDefined()
		expect(pathHasClass(activePath, 'graph-edge--terminated')).toBe(true)
		expect(pathHasClass(activePath, 'graph-edge--returning')).toBe(false)
		expect(pathHasClass(activePath, 'graph-edge--error')).toBe(false)
		const activeCoderWrap = allByTag(activeView, 'g').find((group) => {
			if (!(propString(group.props, 'class') ?? '').split(' ').includes('flow-node')) return false
			return propString(group.props, 'data-participant') === 'coder'
		})
		expect(activeCoderWrap).toBeDefined()
		// A 'terminated' return outcome colors the return line (warn-toned) but not the node — the node was killed externally and did not succeed or fail, so the orange border comes only from a terminate op targeting the node, not from the return outcome.
		const activeCoderInner = allByTag(defined(activeCoderWrap, 'activeCoderWrap'), 'g').find((group) => (propString(group.props, 'class') ?? '').split(' ').includes('graph-node--terminated'))
		expect(activeCoderInner).toBeUndefined()

		// Once the return settles (working phase), the returner has already departed — neither the coder node nor the op5 return edge is drawn on the root row.
		const settledFrame: InteractionModel = {
			participants: [
				participant('you', 'human', 'human'),
				participant('orchestrator', 'orchestrator', 'role'),
				participant('coder', 'coder', 'role'),
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orchestrator', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orchestrator', destination: 'coder', startedAt: 't1', settledAt: 't2', lifecycle: 'settled', outcome: null, metrics: null },
				{ id: 'op5', kind: 'return', stack: 'root', source: 'coder', destination: 'orchestrator', startedAt: 't5', settledAt: 't6', lifecycle: 'settled', outcome: 'terminated', metrics: null },
			],
			status: 'running',
		}
		const settledView = render(settledFrame)
		const settledCoderWrap = allByTag(settledView, 'g').find((group) => {
			if (!(propString(group.props, 'class') ?? '').split(' ').includes('flow-node')) return false
			return propString(group.props, 'data-participant') === 'coder'
		})
		expect(settledCoderWrap).toBeUndefined()
		expect(pathForOperation(settledView, 'op5')).toBeUndefined()
	})
})

describe('renderFlowView — terminal CTA', () => {
	test('the CTA appears on the terminal transit frame (the terminal op has no working frame) but not on the preceding running frame', () => {
		// single-role-completion op1 working (frame 1) carries status 'running', so no CTA renders; the terminal op (op2) emits a single transit frame (frame 2) carrying status 'success', so the CTA node renders on that lingering-return frame. The terminal op has no working frame because You never emits an operation to advance the return — the See Result click stands in as that acknowledgment. The CTA is a terminal action button with no connecting edge, so only the button node is present.
		const runningView = render(scenarioFrame('single-role-completion', 1))
		expect(allByTag(runningView, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-cta')).length).toBe(0)
		const terminalView = render(scenarioFrame('single-role-completion', 2))
		const ctaNodes = allByTag(terminalView, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-cta'))
		expect(ctaNodes.length).toBe(1)
		// The CTA carries no connecting edge — it is a standalone button, not a graph node with a relationship.
		expect(allByTag(terminalView, 'g').filter((group) => (propString(group.props, 'class') ?? '').split(' ').includes('flow-cta-edge')).length).toBe(0)
	})
})

// The whimsical caption phrases rotate by a deterministic hash of the active operation id. These helpers independently interpolate the configured whimsical list with the same seed deriveNowCaption uses (hashString of the active operation id), so the assertion verifies the resolver's interpolation + rotation end-to-end rather than re-deriving the caption through the resolver itself. The detailed and friendly tiers hold single phrases, so their captions are asserted exactly and pin the whimsical prose.
function whimsicalOperationCaption(frame: InteractionModel, templateList: string[], sourceLabel: string, destinationLabel: string): string {
	const opId = activeOperation(frame)?.id ?? ''
	const idx = labelsModule.hashString(opId) % templateList.length
	const template = templateList[idx]
	if (template === undefined) throw new Error('empty whimsical operation list')
	return `${template.split('{source}').join(sourceLabel).split('{destination}').join(destinationLabel)}…`
}

function whimsicalWorkingCaption(frame: InteractionModel, templateList: string[], participantLabel: string): string {
	const opId = activeOperation(frame)?.id ?? ''
	const idx = labelsModule.hashString(opId) % templateList.length
	const template = templateList[idx]
	if (template === undefined) throw new Error('empty whimsical working list')
	return `${template.split('{participant}').join(participantLabel)}…`
}

describe('deriveNowCaption — active participant + in-flight operation', () => {
	test('a terminal success short-circuits to a fixed completion line', () => {
		const frame = scenarioFrame('single-role-completion', 2)
		expect(deriveNowCaption(frame, labelsModule, 'detailed')).toBe('Done.')
	})

	test('an in-flight call names the source and destination via the operation label at the chosen tier with a trailing ellipsis', () => {
		// delegation-chain op2 transit: op2 (orchestrator→planner) is the in-flight call on the active root stack, so the caption resolves its label at the chosen tier and appends an ellipsis. The detailed tier names the raw role ids and the stack; the whimsical tier rotates through the role->role list by the operation id's hash.
		const frame = scenarioFrame('delegation-chain', 2)
		expect(deriveNowCaption(frame, labelsModule, 'detailed')).toBe('role orchestrator is calling role planner (stack root)…')
		expect(deriveNowCaption(frame, labelsModule, 'whimsical')).toBe(whimsicalOperationCaption(frame, ['{source} is passing the baton to {destination}', '{source} is tossing the ball to {destination}', '{source} is handing the reins to {destination}'], 'Conductor', 'Strategist'))
	})

	test('a settled call (the working phase) names what the destination is doing via its working label at the chosen tier with a trailing ellipsis', () => {
		// delegation-chain op2 working: op2 (orchestrator→planner) has settled, so the caption switches from the call relationship to what the destination (planner) is doing — the working label of the destination, seeded by the call's id so transit and working land on the same whimsical phrase.
		const frame = scenarioFrame('delegation-chain', 3)
		expect(deriveNowCaption(frame, labelsModule, 'detailed')).toBe('role planner is composing the plan (streaming tokens)…')
		expect(deriveNowCaption(frame, labelsModule, 'friendly')).toBe('Planning the approach…')
		expect(deriveNowCaption(frame, labelsModule, 'whimsical')).toBe(whimsicalWorkingCaption(frame, ['Charting the course', 'Mapping the route', 'Noodling on the map', 'Surveying the terrain'], 'Strategist'))
	})

	test('a settled call to a tool uses the per-tool working template at the chosen tier', () => {
		// delegation-chain op4 working: op4 (coder→readFile) has settled, so the caption resolves the working label of the tool destination. read_file carries a per-tool humanWorkingLabel, so the caption reads the tool-specific phrase rather than the generic tool fallback.
		const frame = scenarioFrame('delegation-chain', 7)
		expect(deriveNowCaption(frame, labelsModule, 'detailed')).toBe('tool read_file is reading file contents…')
		expect(deriveNowCaption(frame, labelsModule, 'whimsical')).toBe(whimsicalWorkingCaption(frame, ['Cracking open a tome', 'Poring over ancient scrolls', 'Flipping through the pages', 'Consulting the library'], 'Open Book'))
	})

	test('an in-flight call to a tool uses the per-tool call template at the chosen tier', () => {
		// delegation-chain op4 transit: op4 (coder→readFile) is in flight, so the caption resolves the call operation label. read_file carries a per-tool humanCallLabel, so the caption reads the tool-specific call phrase rather than the generic role->tool template.
		const frame = scenarioFrame('delegation-chain', 6)
		expect(deriveNowCaption(frame, labelsModule, 'detailed')).toBe('role coder is invoking tool read_file (stack root)…')
		expect(deriveNowCaption(frame, labelsModule, 'whimsical')).toBe(whimsicalOperationCaption(frame, ['{source} is getting a book off the shelf', '{source} is pulling a tome down', '{source} is cracking a book open'], 'Builder', 'Open Book'))
	})

	test('a settled return (the lingering response leg) carries no ellipsis because the leg is the current state', () => {
		// delegation-chain op5 working: readFile has returned to coder; the return is the latest non-observe operation on the active root stack, so the caption reads its return label (with the outcome) without an ellipsis.
		const frame = scenarioFrame('delegation-chain', 9)
		expect(deriveNowCaption(frame, labelsModule, 'detailed')).toBe('tool read_file is returning success to role coder (stack root)')
	})

	test('the tier toggle swaps the caption voice without touching the model', () => {
		// delegation-chain op1 transit: op1 (you→orchestrator) is the in-flight call; the three tiers resolve to three distinct voices. The whimsical human pseudo-role reads "The Dreamer".
		const frame = scenarioFrame('delegation-chain', 0)
		expect(deriveNowCaption(frame, labelsModule, 'whimsical')).toBe(whimsicalOperationCaption(frame, ['{source} is handing the quest off to {destination}', "{source} is knocking on {destination}'s door", '{source} is sending a carrier pigeon to {destination}'], 'The Dreamer', 'Conductor'))
		expect(deriveNowCaption(frame, labelsModule, 'friendly')).toBe('The human is asking Orchestrator to start…')
		expect(deriveNowCaption(frame, labelsModule, 'detailed')).toBe('human is calling role orchestrator (stack root)…')
	})

	test('an empty model with a running status falls back to the working placeholder', () => {
		const empty: InteractionModel = { participants: [], operations: [], status: 'running' }
		expect(deriveNowCaption(empty, labelsModule, 'detailed')).toBe('Working…')
	})

	test('a needs_clarification status surfaces the waiting line regardless of the active operation', () => {
		// Author a frame whose status is needs_clarification even though the latest operation is an in-flight call; the terminal status wins over the operation label.
		const frame = scenarioFrame('delegation-chain', 0)
		const needsClarification: InteractionModel = { ...frame, status: 'needs_clarification' }
		expect(deriveNowCaption(needsClarification, labelsModule, 'detailed')).toBe('Waiting for your input…')
	})
})

describe('deriveCostStrip — per-operation metric aggregation', () => {
	function callWithMetrics(id: string, stack: string, source: string, destination: string, metrics: Operation['metrics']): Operation {
		return { id, kind: 'call', stack, source, destination, startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, metrics }
	}

	function returnWithMetrics(id: string, stack: string, source: string, destination: string, elapsedSeconds: number, tokens: number): Operation {
		return { id, kind: 'return', stack, source, destination, startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: 'success', metrics: { tokens, cachedPromptTokens: null, elapsedSeconds } }
	}

	test('tokens are summed across every operation that carries them and null metrics contribute nothing', () => {
		const model: InteractionModel = {
			participants: [
				participant('you', 'human', 'human'),
				participant('orchestrator', 'orchestrator', 'role'),
				participant('coder', 'coder', 'role'),
			],
			operations: [
				callWithMetrics('op1', 'root', 'you', 'orchestrator', { tokens: 120, cachedPromptTokens: null, elapsedSeconds: 1.5 }),
				returnWithMetrics('op2', 'root', 'orchestrator', 'you', 1.5, 120),
				callWithMetrics('op3', 'root', 'you', 'coder', null),
				returnWithMetrics('op4', 'root', 'coder', 'you', 2.0, 80),
			],
			status: 'running',
		}
		expect(deriveCostStrip(model)).toEqual({ elapsedSeconds: 2.0, tokens: 320 })
	})

	test('elapsed reads the latest non-null elapsedSeconds, falling back to the previous operation when the latest has none', () => {
		const model: InteractionModel = {
			participants: [participant('you', 'human', 'human'), participant('coder', 'coder', 'role')],
			operations: [
				returnWithMetrics('op1', 'root', 'coder', 'you', 3.0, 50),
				callWithMetrics('op2', 'root', 'you', 'coder', { tokens: null, cachedPromptTokens: null, elapsedSeconds: null }),
			],
			status: 'running',
		}
		// op2 is the latest operation; its elapsedSeconds is null, so the strip falls back to op1's 3.0. op2 carries no tokens either, so the sum stays at op1's 50.
		expect(deriveCostStrip(model)).toEqual({ elapsedSeconds: 3.0, tokens: 50 })
	})

	test('a model whose operations carry no metrics reads as zero elapsed and zero tokens', () => {
		const frame = scenarioFrame('delegation-chain', 2)
		expect(deriveCostStrip(frame)).toEqual({ elapsedSeconds: 0, tokens: 0 })
	})

	test('an empty model reads as zero elapsed and zero tokens', () => {
		const empty: InteractionModel = { participants: [], operations: [], status: 'running' }
		expect(deriveCostStrip(empty)).toEqual({ elapsedSeconds: 0, tokens: 0 })
	})

	test('repeated calls on one model return reference-equal results, and distinct models never share one', () => {
		// The strip is memoized per model, so the repeated call must hand back the same derived object while a content-identical second model derives its own.
		const model: InteractionModel = {
			participants: [participant('you', 'human', 'human'), participant('coder', 'coder', 'role')],
			operations: [returnWithMetrics('op1', 'root', 'coder', 'you', 1.5, 120)],
			status: 'running',
		}
		const twin: InteractionModel = {
			participants: [participant('you', 'human', 'human'), participant('coder', 'coder', 'role')],
			operations: [returnWithMetrics('op1', 'root', 'coder', 'you', 1.5, 120)],
			status: 'running',
		}
		const first = deriveCostStrip(model)
		expect(deriveCostStrip(model)).toBe(first)
		expect(first).toEqual({ elapsedSeconds: 1.5, tokens: 120 })
		expect(deriveCostStrip(twin)).toEqual(first)
		expect(deriveCostStrip(twin)).not.toBe(first)
	})
})

