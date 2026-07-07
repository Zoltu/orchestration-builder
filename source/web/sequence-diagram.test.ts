import { describe, expect, test } from 'bun:test'
import { renderSequenceView, COLUMN_WIDTH, HEADER_HEIGHT, ROW_HEIGHT, LEFT_MARGIN } from './static/sequence-diagram.js'
import { activeOperation, activeStack, observesOf } from './static/interaction-model.js'
import { createLabelResolver } from './static/labels.js'
import { labelsModule } from './label-resolver-fixture.js'
import { scenarios, GUILD_PARTICIPANTS } from './static/scenarios.js'

// Pull the model type off a helper signature so the inline fixtures are contextually checked against the JSDoc shape without a cast, mirroring the sibling mvc-flow-view.test.ts convention.
type InteractionModel = Parameters<typeof observesOf>[0]
type Participant = InteractionModel['participants'][number]
type Operation = InteractionModel['operations'][number]
type LabelTier = Parameters<ReturnType<typeof createLabelResolver>['resolveParticipantLabel']>[1]

// A fake `h` capturing the tag, props, and children of every vnode so the layout assertions walk a plain object tree rather than real DOM, mirroring the sibling test convention.
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
	return { id, kind: 'call', stack, source, destination, startedAt: 't0', settledAt: null, lifecycle: 'in_flight', outcome: null, details: null, metrics: null }
}

function render(model: InteractionModel, tier: LabelTier = 'detailed'): Vnode {
	return renderSequenceView(fakeH, model, labelsModule, tier)
}

// Renders with the demo's static guild participant set so the column-set behavior the demo harness exercises (every guild role column present from frame 0) is asserted against the same data the harness passes.
function renderWithGuild(model: InteractionModel, tier: LabelTier = 'detailed'): Vnode {
	return renderSequenceView(fakeH, model, labelsModule, tier, GUILD_PARTICIPANTS)
}

function columnRoles(view: Vnode): string[] {
	return groupsWithClass(view, 'seq-column').map((column) => propString(column.props, 'data-role') ?? '')
}

function messageGroups(view: Vnode): Vnode[] {
	return groupsWithClass(view, 'seq-message-group')
}

function messageGroupForOperation(view: Vnode, operationId: string): Vnode | undefined {
	return messageGroups(view).find((group) => propString(group.props, 'data-operation') === operationId)
}

function terminalNodeForOperation(view: Vnode, operationId: string): Vnode | undefined {
	return groupsWithClass(view, 'seq-node').find((node) => propString(node.props, 'data-operation') === operationId)
}

// Finds a terminal node by operation id and end ('source' | 'destination'). A return carries both ends — the source node on the callee's lifeline holds the outcome color, the destination node on the caller's lifeline pulses when the return is the active operation — so the per-end lookup is what the animation assertions key on.
function terminalNodeForOperationEnd(view: Vnode, operationId: string, end: 'source' | 'destination'): Vnode | undefined {
	return groupsWithClass(view, 'seq-node').find((node) => {
		if (propString(node.props, 'data-operation') !== operationId) return false
		return propString(node.props, 'data-node-end') === end
	})
}

// Collects every class token on the first <path> descendant of a message group, so the animation assertions read the line's modifier classes regardless of routing (cross-column vs. loopback).
function messagePathClasses(view: Vnode, operationId: string): string[] {
	const group = messageGroupForOperation(view, operationId)
	if (group === undefined) return []
	const path = allByTag(group, 'path')[0]
	if (path === undefined) return []
	return (propString(path.props, 'class') ?? '').split(' ')
}

const ANIMATION_CLASS_TOKENS = ['seq-message--flowing', 'seq-message--returning', 'seq-message--error', 'seq-message--terminated-flowing']

describe('renderSequenceView — columns', () => {
	test('the human column is always present and first across every demo scenario frame', () => {
		for (const scenario of scenarios) {
			scenario.frames.forEach((frame, frameIndex) => {
				const view = render(frame)
				const roles = columnRoles(view)
				if (roles.length === 0 || roles[0] !== 'human') {
					throw new Error(`${scenario.id} frame ${frameIndex}: expected human column first, got ${JSON.stringify(roles)}`)
				}
			})
		}
	})

	test('the column set matches the participants roles grouped human → interrupt → roles → tools', () => {
		// deep-call-tree terminal transit frame: human, then the role chain in first-appearance order, then the single shared "tools" column last (every tool collapses to one lifeline).
		const frame = scenarioFrame('deep-call-tree', 18)
		const view = render(frame)
		expect(columnRoles(view)).toEqual(['human', 'orchestrator', 'planner', 'coder', 'critic', 'tools'])
	})

	test('the interrupt column appears only when an Interrupt participant exists', () => {
		for (const scenario of scenarios) {
			scenario.frames.forEach((frame, frameIndex) => {
				const view = render(frame)
				const roles = columnRoles(view)
				const hasInterruptColumn = roles.includes('interrupt')
				const hasInterruptParticipant = frame.participants.some((entry) => entry.kind === 'interrupt')
				if (hasInterruptColumn !== hasInterruptParticipant) {
					throw new Error(`${scenario.id} frame ${frameIndex}: interrupt column presence ${hasInterruptColumn} does not match interrupt participant presence ${hasInterruptParticipant}`)
				}
			})
		}
	})

	test('a non-interrupt scenario never carries an interrupt column', () => {
		const view = render(scenarioFrame('delegation-chain', 6))
		expect(columnRoles(view)).not.toContain('interrupt')
	})

	test('an interrupt scenario carries the interrupt column in the second position', () => {
		// detected-loop-interrupt op3 transit: the interrupt's first call has just landed, so the interrupt pseudo-role column appears right after human.
		const view = render(scenarioFrame('detected-loop-interrupt', 4))
		expect(columnRoles(view)[1]).toBe('interrupt')
	})

	test('a role invoked twice (instance-per-invocation) collapses to a single column', () => {
		// retry-with-fresh-instance terminal transit frame: coder-1 and coder-2 share role 'coder', so one coder column appears.
		const view = render(scenarioFrame('retry-with-fresh-instance', 10))
		const coderColumns = columnRoles(view).filter((role) => role === 'coder')
		expect(coderColumns.length).toBe(1)
	})

	test('the static guild role set renders every guild role column from frame 0 even when no operation touches them', () => {
		// The guild defines its roles statically, so every guild role column (and the tools column) appears from the very first frame of a run that touches only one role. A column with no messages represents a guild role the run simply did not invoke — not a role that will be called later.
		const view = renderWithGuild(scenarioFrame('single-role-completion', 0))
		expect(columnRoles(view)).toEqual(['human', 'orchestrator', 'planner', 'coder', 'critic', 'loop_detector', 'tools'])
	})
})

describe('renderSequenceView — message rows', () => {
	test('one message group per operation in chronological order across every demo scenario frame', () => {
		for (const scenario of scenarios) {
			scenario.frames.forEach((frame, frameIndex) => {
				const view = render(frame)
				const groups = messageGroups(view)
				if (groups.length !== frame.operations.length) {
					throw new Error(`${scenario.id} frame ${frameIndex}: expected ${frame.operations.length} messages, got ${groups.length}`)
				}
				const renderedIds = groups.map((group) => propString(group.props, 'data-operation') ?? '')
				const expectedIds = frame.operations.map((operation) => operation.id)
				expect(renderedIds).toEqual(expectedIds)
			})
		}
	})

	test('a return to the human participant lands its destination terminal node on the human column', () => {
		// single-role-completion op2 transit: op2 is the coder→you return; its destination (caller) node must sit on the human column. The return's outcome color lives on the source (callee) node, so the destination node is what lands on the human column.
		const frame = scenarioFrame('single-role-completion', 2)
		const view = render(frame)
		const group = messageGroupForOperation(view, 'op2')
		expect(group).toBeDefined()
		expect(propString(group!.props, 'data-destination-role')).toBe('human')
		const node = terminalNodeForOperationEnd(view, 'op2', 'destination')
		expect(node).toBeDefined()
		expect(propString(node!.props, 'data-column-role')).toBe('human')
	})

	test('a success return source node carries the success state and an error return source node carries the error state', () => {
		// error-return op3 transit: op3 (coder→orchestrator, outcome error) carries the error color on its source (coder) node — the callee's outcome reads on the callee's lifeline, mirroring the flow view's returning node.
		const errorView = render(scenarioFrame('error-return', 4))
		const errorNode = terminalNodeForOperationEnd(errorView, 'op3', 'source')
		expect(errorNode).toBeDefined()
		expect(propString(errorNode!.props, 'data-state')).toBe('error')
		expect((propString(errorNode!.props, 'class') ?? '').split(' ')).toContain('seq-node--error')

		// single-role-completion op2 transit: op2 (coder→you, outcome success) carries the success color on its source (coder) node.
		const successView = render(scenarioFrame('single-role-completion', 2))
		const successNode = terminalNodeForOperationEnd(successView, 'op2', 'source')
		expect(successNode).toBeDefined()
		expect(propString(successNode!.props, 'data-state')).toBe('success')
		expect((propString(successNode!.props, 'class') ?? '').split(' ')).toContain('seq-node--success')
	})

	test('a terminated return source node carries the distinct terminated treatment', () => {
		// An in-flight terminated return (coder→orchestrator, outcome terminated) carries the terminated tone on its source (coder) node, distinct from success and error.
		const model: InteractionModel = {
			participants: [
				participant('you', 'human', 'human'),
				participant('orchestrator', 'orchestrator', 'role'),
				participant('coder', 'coder', 'role'),
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orchestrator', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, details: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orchestrator', destination: 'coder', startedAt: 't1', settledAt: 't2', lifecycle: 'settled', outcome: null, details: null, metrics: null },
				{ id: 'op5', kind: 'return', stack: 'root', source: 'coder', destination: 'orchestrator', startedAt: 't5', settledAt: null, lifecycle: 'in_flight', outcome: 'terminated', details: null, metrics: null },
			],
			status: 'running',
		}
		const view = render(model)
		const node = terminalNodeForOperationEnd(view, 'op5', 'source')
		expect(node).toBeDefined()
		expect(propString(node!.props, 'data-state')).toBe('terminated')
		const classValue = propString(node!.props, 'class') ?? ''
		expect(classValue.split(' ')).toContain('seq-node--terminated')
	})
})

describe('renderSequenceView — same-role cross-instance loopback', () => {
	test('a call between two instances of one role renders as the loopback path, not a cross-column arrow', () => {
		// coder-1 delegates to coder-2: both share role 'coder', so source and destination collapse to one column and the message renders the LoopbackEdge U-turn.
		const model: InteractionModel = {
			participants: [
				participant('you', 'human', 'human'),
				participant('orchestrator', 'orchestrator', 'role'),
				participant('coder-1', 'coder', 'role'),
				participant('coder-2', 'coder', 'role'),
			],
			operations: [
				callOperation('op1', 'root', 'you', 'orchestrator'),
				callOperation('op2', 'root', 'orchestrator', 'coder-1'),
				callOperation('op3', 'root', 'coder-1', 'coder-2'),
			],
			status: 'running',
		}
		const view = render(model)
		const group = messageGroupForOperation(view, 'op3')
		expect(group).toBeDefined()
		expect(propString(group!.props, 'data-routing')).toBe('loopback')
		expect(propString(group!.props, 'data-source-role')).toBe('coder')
		expect(propString(group!.props, 'data-destination-role')).toBe('coder')
		// The loopback path is a cubic curve that bows to the right of the single coder column (a straight cross-column arrow would be a single `L` command with no control points).
		const path = allByTag(group!, 'path')[0]
		expect(path).toBeDefined()
		const d = propString(path!.props, 'd') ?? ''
		expect(d.includes('C')).toBe(true)
		// The coder column sits at LEFT_MARGIN + 1 * COLUMN_WIDTH (human at 0, orchestrator at... coder is the second role column). The loopback's control points bow to x = coder column x + 60.
		const coderColumnX = LEFT_MARGIN + 2 * COLUMN_WIDTH
		const bowX = coderColumnX + 60
		expect(d.includes(String(bowX))).toBe(true)
	})

	test('a cross-column call renders as a straight arrow, not a loopback', () => {
		// delegation-chain op2 transit: op2 (orchestrator→planner) spans two distinct columns.
		const view = render(scenarioFrame('delegation-chain', 2))
		const group = messageGroupForOperation(view, 'op2')
		expect(propString(group!.props, 'data-routing')).toBe('cross-column')
		const path = allByTag(group!, 'path')[0]
		const d = propString(path!.props, 'd') ?? ''
		expect(d.startsWith('M')).toBe(true)
		expect(d.includes('L')).toBe(true)
		expect(d.includes('C')).toBe(false)
	})
})

describe('renderSequenceView — observe', () => {
	test('an observe renders a static cross-column line with no arrowhead and no terminal node', () => {
		// detected-loop-interrupt observe frame: the loop detector observes the looping coder; the observe crosses from the active interrupt stack into the paused root stack.
		const frame = scenarioFrame('detected-loop-interrupt', 8)
		expect(observesOf(frame).length).toBe(1)
		const view = render(frame)
		const group = messageGroupForOperation(view, 'op5')
		expect(group).toBeDefined()
		expect(propString(group!.props, 'data-routing')).toBe('observe')
		expect(propString(group!.props, 'data-kind')).toBe('observe')
		const path = allByTag(group!, 'path')[0]
		expect(path).toBeDefined()
		// The line carries the static observe class and no marching/flowing class.
		const lineClass = propString(path!.props, 'class') ?? ''
		expect(lineClass.split(' ')).toContain('seq-message--observe')
		expect(lineClass.split(' ')).not.toContain('seq-message--flowing')
		// No arrowhead marker is attached: observe is a reference, not a directed call.
		expect(propString(path!.props, 'marker-end')).toBeUndefined()
		// No terminal node activates the destination lifeline for an observe.
		const node = terminalNodeForOperation(view, 'op5')
		expect(node).toBeUndefined()
	})

	test('an observe line spans the two columns at the operation row', () => {
		const frame = scenarioFrame('detected-loop-interrupt', 8)
		const observe = observesOf(frame)[0]
		if (observe === undefined) throw new Error('expected one observe operation')
		const view = render(frame)
		const path = allByTag(messageGroupForOperation(view, observe.id)!, 'path')[0]
		const d = propString(path!.props, 'd') ?? ''
		// The observe is the 5th operation (index 4); its row center sits at HEADER_HEIGHT + 4 * ROW_HEIGHT + ROW_HEIGHT / 2. A static observe line is `M <sourceX> <rowY> L <destinationX> <rowY>` — both endpoints share the row y, never an arrowhead.
		const expectedRowY = HEADER_HEIGHT + 4 * ROW_HEIGHT + ROW_HEIGHT / 2
		const observePathPattern = new RegExp(`^M -?\\d+ ${expectedRowY} L -?\\d+ ${expectedRowY}$`)
		expect(observePathPattern.test(d)).toBe(true)
	})

	test('an observe from the active stack into a non-adjacent paused stack still renders as a static cross-column line', () => {
		// nested-interrupt-deep observe frame: the observe's source is the tool readMessageWindow-2 (role read_message_window, on the active interrupt-2 stack) and its destination is the coder (paused root stack) — two distinct columns with the middle interrupt-1 column between them in the flow view's row layout. The sequence view flattens to columns, so the observe renders as the same static cross-column line regardless of how many stacks sit between source and destination.
		const frame = scenarioFrame('nested-interrupt-deep', 12)
		const observe = observesOf(frame)[0]
		expect(observe).toBeDefined()
		expect(observe!.source).toBe('readMessageWindow-2')
		expect(observe!.destination).toBe('coder')
		const view = render(frame)
		const group = messageGroupForOperation(view, observe!.id)
		expect(group).toBeDefined()
		expect(propString(group!.props, 'data-routing')).toBe('observe')
		expect(propString(group!.props, 'data-source-role')).toBe('read_message_window')
		expect(propString(group!.props, 'data-destination-role')).toBe('coder')
		const path = allByTag(group!, 'path')[0]
		expect(path).toBeDefined()
		const lineClass = propString(path!.props, 'class') ?? ''
		expect(lineClass.split(' ')).toContain('seq-message--observe')
		for (const token of ANIMATION_CLASS_TOKENS) {
			expect(lineClass.split(' ')).not.toContain(token)
		}
		expect(propString(path!.props, 'marker-end')).toBeUndefined()
		expect(terminalNodeForOperation(view, observe!.id)).toBeUndefined()
	})
})

describe('renderSequenceView — animation (the single invariant)', () => {
	test("the active stack's in_flight call message animates flowing and every earlier message is solid", () => {
		// delegation-chain op2 transit: op1 (call you→orchestrator) is settled by the nested op2; op2 (call orchestrator→planner) is in_flight and is the active operation, so op2 marches and op1 stays solid.
		const frame = scenarioFrame('delegation-chain', 2)
		const view = render(frame)
		const op2Classes = messagePathClasses(view, 'op2')
		expect(op2Classes).toContain('seq-message--flowing')
		const op1Classes = messagePathClasses(view, 'op1')
		for (const token of ANIMATION_CLASS_TOKENS) {
			expect(op1Classes).not.toContain(token)
		}
	})

	test("the active stack's in_flight return message animates returning", () => {
		// single-role-completion op2 transit: op2 (coder→you, success return) is the active operation, so its line marches returning.
		const view = render(scenarioFrame('single-role-completion', 2))
		const classes = messagePathClasses(view, 'op2')
		expect(classes).toContain('seq-message--returning')
	})

	test('an error return on the active stack animates error', () => {
		// error-return op3 transit: op3 (coder→orchestrator, error) is the active operation, so its line marches in the error color.
		const view = render(scenarioFrame('error-return', 4))
		expect(messagePathClasses(view, 'op3')).toContain('seq-message--error')
	})

	test("a paused stack's in_flight message is solid (frozen)", () => {
		// detected-loop-interrupt op4 transit: op2 (orchestrator→coder, in_flight on the paused root stack) must not animate — only the active interrupt-stack's in_flight call marches.
		const frame = scenarioFrame('detected-loop-interrupt', 6)
		const view = render(frame)
		const op2Classes = messagePathClasses(view, 'op2')
		for (const token of ANIMATION_CLASS_TOKENS) {
			expect(op2Classes).not.toContain(token)
		}
		// The active stack's in_flight call (op4) does march, confirming the freeze is the paused-stack rule and not a global stillness.
		expect(messagePathClasses(view, 'op4')).toContain('seq-message--flowing')
	})

	test("the active participant's destination node carries the active class", () => {
		// delegation-chain op2 transit: the active operation is op2 (call orchestrator→planner), so the active participant is the destination (planner) and its destination node pulses.
		const view = render(scenarioFrame('delegation-chain', 2))
		const node = terminalNodeForOperationEnd(view, 'op2', 'destination')
		expect(node).toBeDefined()
		expect(propString(node!.props, 'data-state')).toBe('active')
		expect((propString(node!.props, 'class') ?? '').split(' ')).toContain('seq-node--active')
	})

	test("a paused stack's participant node does not carry the active class", () => {
		// detected-loop-interrupt op4 transit: the coder is in_flight on the paused root stack, so its node stays neutral (no active pulse) — only the active stack's destination pulses.
		const view = render(scenarioFrame('detected-loop-interrupt', 6))
		const node = terminalNodeForOperationEnd(view, 'op2', 'destination')
		expect(node).toBeDefined()
		expect(propString(node!.props, 'data-state')).toBe('neutral')
		expect((propString(node!.props, 'class') ?? '').split(' ')).not.toContain('seq-node--active')
	})

	test("a return's source node carries the outcome color", () => {
		// A return's outcome is a settled fact about the callee, so it reads on the source (callee) node regardless of whether the return is the active operation. error-return op3 transit carries error; single-role-completion op2 transit carries success.
		const errorView = render(scenarioFrame('error-return', 4))
		const errorSource = terminalNodeForOperationEnd(errorView, 'op3', 'source')
		expect(errorSource).toBeDefined()
		expect(propString(errorSource!.props, 'data-state')).toBe('error')

		const successView = render(scenarioFrame('single-role-completion', 2))
		const successSource = terminalNodeForOperationEnd(successView, 'op2', 'source')
		expect(successSource).toBeDefined()
		expect(propString(successSource!.props, 'data-state')).toBe('success')
	})

	test('observe never animates and carries no animation class', () => {
		// detected-loop-interrupt observe frame: op5 is the observe; its line is the static observe variant and never carries a marching class, and it carries no terminal node at either end.
		const frame = scenarioFrame('detected-loop-interrupt', 8)
		const view = render(frame)
		const classes = messagePathClasses(view, 'op5')
		expect(classes).toContain('seq-message--observe')
		for (const token of ANIMATION_CLASS_TOKENS) {
			expect(classes).not.toContain(token)
		}
		expect(terminalNodeForOperationEnd(view, 'op5', 'source')).toBeUndefined()
		expect(terminalNodeForOperationEnd(view, 'op5', 'destination')).toBeUndefined()
	})

	test('the working phase: a settled active operation renders a solid line while its destination keeps pulsing', () => {
		// delegation-chain op2 working: op2 (call orchestrator→planner) is the active operation but settled, so its line is solid (no marching class) and its destination node still pulses — "settled" stops the line animating, not the destination being active.
		const frame = scenarioFrame('delegation-chain', 3)
		expect(activeOperation(frame)?.id).toBe('op2')
		const op2 = frame.operations.find((operation) => operation.id === 'op2')
		expect(op2?.lifecycle).toBe('settled')
		const view = render(frame)
		const op2Classes = messagePathClasses(view, 'op2')
		for (const token of ANIMATION_CLASS_TOKENS) {
			expect(op2Classes).not.toContain(token)
		}
		const destination = terminalNodeForOperationEnd(view, 'op2', 'destination')
		expect(destination).toBeDefined()
		expect(propString(destination!.props, 'data-state')).toBe('active')
		expect((propString(destination!.props, 'class') ?? '').split(' ')).toContain('seq-node--active')
	})
})

describe('renderSequenceView — nested interrupts under stress', () => {
	test("three coexisting stacks: the active stack's in_flight call marches and the two paused stacks' in_flight lines stay solid", () => {
		// nested-interrupt-deep op5 transit: root (op2), interrupt-1-stack (op4), and interrupt-2-stack (op5) each carry an in_flight call. op5 is the active operation and marches; op2 and op4 are in_flight on paused stacks and stay solid. The model keeps op2 and op4 in_flight (lifecycle is unchanged by pause), so this asserts the view freezes them rather than the model settling them.
		const frame = scenarioFrame('nested-interrupt-deep', 8)
		expect(activeStack(frame)).toBe('interrupt-2-stack')
		expect(activeOperation(frame)?.id).toBe('op5')
		const op2 = frame.operations.find((operation) => operation.id === 'op2')
		const op4 = frame.operations.find((operation) => operation.id === 'op4')
		expect(op2?.lifecycle).toBe('in_flight')
		expect(op4?.lifecycle).toBe('in_flight')
		const view = render(frame)
		expect(messagePathClasses(view, 'op5')).toContain('seq-message--flowing')
		for (const operationId of ['op2', 'op4']) {
			const classes = messagePathClasses(view, operationId)
			for (const token of ANIMATION_CLASS_TOKENS) {
				expect(classes).not.toContain(token)
			}
		}
		// The two paused stacks' in_flight destinations do not pulse — only the active stack's destination does.
		expect(propString(terminalNodeForOperationEnd(view, 'op5', 'destination')!.props, 'data-state')).toBe('active')
		expect(propString(terminalNodeForOperationEnd(view, 'op2', 'destination')!.props, 'data-state')).toBe('neutral')
		expect(propString(terminalNodeForOperationEnd(view, 'op4', 'destination')!.props, 'data-state')).toBe('neutral')
	})

	test('a terminated return renders distinctly when active (marching warn) and when settled (static warn)', () => {
		// An in-flight terminated return (coder→orchestrator, outcome terminated) is the active operation, so its line marches in the warn tone (seq-message--terminated-flowing), its arrowhead is the warn marching marker, and its source (callee) node carries the terminated state — distinct from a green success march and a red error march.
		const activeModel: InteractionModel = {
			participants: [
				participant('you', 'human', 'human'),
				participant('orchestrator', 'orchestrator', 'role'),
				participant('coder', 'coder', 'role'),
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orchestrator', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, details: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orchestrator', destination: 'coder', startedAt: 't1', settledAt: 't2', lifecycle: 'settled', outcome: null, details: null, metrics: null },
				{ id: 'op5', kind: 'return', stack: 'root', source: 'coder', destination: 'orchestrator', startedAt: 't5', settledAt: null, lifecycle: 'in_flight', outcome: 'terminated', details: null, metrics: null },
			],
			status: 'running',
		}
		expect(activeOperation(activeModel)?.id).toBe('op5')
		const activeView = render(activeModel)
		const activeClasses = messagePathClasses(activeView, 'op5')
		expect(activeClasses).toContain('seq-message--terminated-flowing')
		expect(activeClasses).not.toContain('seq-message--returning')
		expect(activeClasses).not.toContain('seq-message--error')
		const activeGroup = messageGroupForOperation(activeView, 'op5')!
		const activePath = allByTag(activeGroup, 'path')[0]!
		expect(propString(activePath.props, 'marker-end')).toBe('url(#seq-arrow-terminated-flowing)')
		const activeSourceNode = terminalNodeForOperationEnd(activeView, 'op5', 'source')!
		expect(propString(activeSourceNode.props, 'data-state')).toBe('terminated')
		expect((propString(activeSourceNode.props, 'class') ?? '').split(' ')).toContain('seq-node--terminated')

		// Once settled, the line is the static warn variant (seq-message--terminated) and the source node still carries the terminated state.
		const settledModel: InteractionModel = {
			participants: [
				participant('you', 'human', 'human'),
				participant('orchestrator', 'orchestrator', 'role'),
				participant('coder', 'coder', 'role'),
			],
			operations: [
				{ id: 'op1', kind: 'call', stack: 'root', source: 'you', destination: 'orchestrator', startedAt: 't0', settledAt: 't1', lifecycle: 'settled', outcome: null, details: null, metrics: null },
				{ id: 'op2', kind: 'call', stack: 'root', source: 'orchestrator', destination: 'coder', startedAt: 't1', settledAt: 't2', lifecycle: 'settled', outcome: null, details: null, metrics: null },
				{ id: 'op5', kind: 'return', stack: 'root', source: 'coder', destination: 'orchestrator', startedAt: 't5', settledAt: 't6', lifecycle: 'settled', outcome: 'terminated', details: null, metrics: null },
			],
			status: 'running',
		}
		const settledView = render(settledModel)
		const settledClasses = messagePathClasses(settledView, 'op5')
		expect(settledClasses).toContain('seq-message--terminated')
		for (const token of ANIMATION_CLASS_TOKENS) {
			expect(settledClasses).not.toContain(token)
		}
		const settledSourceNode = terminalNodeForOperationEnd(settledView, 'op5', 'source')!
		expect(propString(settledSourceNode.props, 'data-state')).toBe('terminated')
	})

	test("a paused stack's in_flight op stays in_flight in the model but renders static in the view", () => {
		// rewind-multi-terminate op14 transit: interrupt-3 preempts mid-normal-operation, leaving op13 (coder-2→read_file) in_flight on the paused root stack while op14 marches on the active interrupt-3 stack. The model keeps op13 in_flight; the view must not animate it.
		const frame = scenarioFrame('rewind-multi-terminate', 24)
		expect(activeStack(frame)).toBe('interrupt-3-stack')
		expect(activeOperation(frame)?.id).toBe('op14')
		const op13 = frame.operations.find((operation) => operation.id === 'op13')
		expect(op13?.lifecycle).toBe('in_flight')
		const view = render(frame)
		expect(messagePathClasses(view, 'op14')).toContain('seq-message--flowing')
		const op13Classes = messagePathClasses(view, 'op13')
		for (const token of ANIMATION_CLASS_TOKENS) {
			expect(op13Classes).not.toContain(token)
		}
		expect(propString(terminalNodeForOperationEnd(view, 'op11', 'destination')!.props, 'data-state')).toBe('neutral')
	})
})
