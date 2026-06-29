import { describe, expect, test } from 'bun:test'
import { deriveSequenceDiagram, deriveSequenceActivity, renderSequenceDiagram, buildColumns, buildCallEdgeColumns, isRealDelegation, filterOrphanToolCalls, SEQUENCE_CONSTANTS } from './static/sequence-diagram.js'
import { deriveFlowAnimation } from './static/flow-view.js'
import { fixtures, mockConfig } from './static/fixtures.js'

// The sequence-diagram module is browser-pure JS, so its exports arrive with inferred JS types. The interfaces and fake `h` below carry the shape the tests assert against, mirroring flow-view.test.ts / tooltip.test.ts.

interface Vnode {
	tag: string
	props: Record<string, unknown>
	children: VnodeChild[]
}
type VnodeChild = Vnode | string

function fakeH(tag: string, props: Record<string, unknown>, children: unknown): Vnode {
	return { tag, props, children: normalizeChildren(children) }
}

function normalizeChildren(children: unknown): VnodeChild[] {
	const out: VnodeChild[] = []
	pushChildren(out, children)
	return out
}

function pushChildren(out: VnodeChild[], children: unknown): void {
	if (children === null || children === undefined || typeof children === 'boolean') return
	if (Array.isArray(children)) {
		for (const child of children) pushChildren(out, child)
		return
	}
	out.push(children as VnodeChild)
}

function isVnode(value: VnodeChild): value is Vnode {
	return typeof value !== 'string'
}

function byTag(vnode: Vnode, tag: string): Vnode[] {
	return vnode.children.filter((child): child is Vnode => isVnode(child) && child.tag === tag)
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

interface SequenceColumn {
	id: string
	label: string
	kind: string
}

interface SequenceMessage {
	from: string
	to: string
	direction: string
	label: string
	detailSections: unknown
	timestamp: string
	type: string
}

interface SequenceDiagram {
	columns: SequenceColumn[]
	messages: SequenceMessage[]
}

interface FlowNode {
	id: string
	kind: string
	label: string
	column: number
	row: number
	sublabel?: string
	status?: string
	active?: boolean
	costTime?: number
	costTokens?: number
}

interface FlowEdge {
	from: string
	to: string
	kind: string
}

interface FlowModel {
	mainArea: { nodes: FlowNode[]; edges: FlowEdge[] }
	topBar: { nodes: unknown[] }
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Returns a scenario frame's config + runView + flowModel, narrowed through `unknown` since the JS fixtures do not advertise those fields on their inferred frame type. The flowModel is the same shape the flow view consumes (and the same one flow-view.test.ts narrows through `unknown`), so deriveFlowActivity mirrors the flow view exactly.
function scenarioFrame(scenarioId: string, frameIndex: number): { config: unknown, runView: unknown, flowModel: FlowModel } {
	const scenario = fixtures.find((item) => item.id === scenarioId)
	if (scenario === undefined) throw new Error(`unknown fixture scenario: ${scenarioId}`)
	const frameValue = scenario.frames[frameIndex] as unknown as Record<string, unknown>
	if (!isObject(frameValue)) throw new Error(`${scenarioId}[frame ${frameIndex}]: frame is not an object`)
	const model = frameValue['flowModel']
	if (!isObject(model)) throw new Error(`${scenarioId}[frame ${frameIndex}]: flowModel missing`)
	return { config: frameValue['config'], runView: frameValue['runView'], flowModel: model as unknown as FlowModel }
}

// A synthetic recentLog entry mirroring the RunView shape, so the routing tests can pin a single event's column mapping without depending on a fixture's surrounding events.
function logEntry(p: { type: string, summary?: string, role?: string | null, parent?: string, child?: string, tool?: string, id?: string, question?: string, answer?: string, detailSections?: unknown[] }): Record<string, unknown> {
	const payload: Record<string, unknown> = {}
	if (p.role !== undefined) payload.role = p.role
	if (p.parent !== undefined) payload.parent = p.parent
	if (p.child !== undefined) payload.child = p.child
	if (p.tool !== undefined) payload.tool = p.tool
	if (p.id !== undefined) payload.id = p.id
	if (p.question !== undefined) payload.question = p.question
	if (p.answer !== undefined) payload.answer = p.answer
	const entry: Record<string, unknown> = {
		timestamp: '2026-06-26T09:00:00.000Z',
		type: p.type,
		summary: p.summary ?? p.type,
		payload,
	}
	if (p.detailSections !== undefined) entry.detailSections = p.detailSections
	return entry
}

function runViewWith(entries: Record<string, unknown>[]): Record<string, unknown> {
	return { recentLog: entries }
}

// Reconstructs the full chronological recentLog up to a frame, mirroring playback.js's accumulateRecentLog: each frame's window is the most-recent N events, so the union deduplicated by timestamp|type|summary in first-seen order is the full log. Overseer agent_calls (whose parent→child pair doesn't appear as a call edge in the frame where they first appear) are filtered, and orphan tool_calls (calls without matching results, not in-flight) are dropped, matching the playback harness.
function accumulateRecentLog(scenarioId: string, frameIndex: number): Record<string, unknown>[] {
	const scenario = fixtures.find((item) => item.id === scenarioId)
	if (scenario === undefined) throw new Error(`unknown fixture scenario: ${scenarioId}`)
	const seen = new Set<string>()
	const accumulated: Record<string, unknown>[] = []
	for (let i = 0; i <= frameIndex; i++) {
		const frameValue = scenario.frames[i] as unknown as { runView?: { recentLog?: Record<string, unknown>[] }, config: unknown, flowModel: FlowModel }
		const recentLog = frameValue.runView?.recentLog ?? []
		const callEdgeColumns = buildCallEdgeColumns(frameValue.flowModel)
		const columnIds = new Set(buildColumns(frameValue.config).map((column: SequenceColumn) => column.id))
		for (const entry of recentLog) {
			if (entry === null || typeof entry !== 'object') continue
			const key = `${entry.timestamp}|${entry.type}|${entry.summary}`
			if (seen.has(key)) continue
			if (entry.type === 'agent_call' && !isRealDelegation(entry.payload, callEdgeColumns, columnIds)) continue
			seen.add(key)
			accumulated.push(entry)
		}
	}
	// Drop orphan tool_calls: calls without matching tool_results in the accumulated log, unless the tool is currently in-flight (flowing in the flow view of the current frame).
	const frame = scenario.frames[frameIndex] as unknown as { flowModel: FlowModel }
	const flowAnimation = deriveFlowAnimation(frame.flowModel)
	const flowingToolNames = flowingToolNamesOf(frame.flowModel, flowAnimation)
	return filterOrphanToolCalls(accumulated, flowingToolNames)
}

// The set of tool names that are currently in-flight (the target of a flowing edge in the flow view). Mirrors the same helper in playback.js.
function flowingToolNamesOf(flowModel: FlowModel, flowAnimation: { activeIds: Set<string>, edgeStates: string[] }): Set<string> {
	const names = new Set<string>()
	const nodes = flowModel.mainArea.nodes
	const edges = flowModel.mainArea.edges
	const edgeStates = flowAnimation.edgeStates
	const nodeById = new Map<string, FlowNode>()
	for (const node of nodes) {
		if (typeof node.id === 'string') nodeById.set(node.id, node)
	}
	for (let i = 0; i < edges.length; i++) {
		if (edgeStates[i] !== 'flowing') continue
		const edge = edges[i]!
		const target = nodeById.get(edge.to)
		if (target !== undefined && target.kind === 'tool' && typeof target.id === 'string') names.add(target.id)
	}
	return names
}

describe('buildColumns', () => {
	test('the column set is Human + every config role + a tools column, with the entry role second', () => {
		const columns = buildColumns(mockConfig)
		const ids = columns.map((column) => column.id)
		expect(ids[0]).toBe('human')
		expect(ids[ids.length - 1]).toBe('tools')
		// The entry role (orchestrator) follows Human.
		expect(ids[1]).toBe('orchestrator')
		// Every config role has a column.
		for (const name of Object.keys(mockConfig.roles)) {
			expect(ids).toContain(name)
		}
	})

	test('side roles are grouped last among the role columns, before tools', () => {
		const columns = buildColumns(mockConfig)
		const ids = columns.map((column) => column.id)
		const toolsIndex = ids.indexOf('tools')
		// context_manager, recovery, loop_detector are the side roles and sit just before tools.
		expect(ids.indexOf('context_manager')).toBe(toolsIndex - 3)
		expect(ids.indexOf('recovery')).toBe(toolsIndex - 2)
		expect(ids.indexOf('loop_detector')).toBe(toolsIndex - 1)
		// The main worker roles sit between the entry role and the side roles.
		expect(ids.indexOf('planner')).toBeLessThan(ids.indexOf('context_manager'))
		expect(ids.indexOf('coder')).toBeLessThan(ids.indexOf('context_manager'))
	})

	test('column labels resolve the friendly tier, falling back to detailed then a title-cased name', () => {
		const columns = buildColumns(mockConfig)
		const byId = new Map(columns.map((column) => [column.id, column]))
		expect(byId.get('orchestrator')!.label).toBe('The conductor')
		expect(byId.get('human')!.label).toBe('You')
		expect(byId.get('tools')!.label).toBe('Tools')
		// A config with no label tiers falls back to a title-cased name.
		const sparse = { entryRole: 'data_scientist', roles: { data_scientist: { tools: [] } } }
		const sparseColumns = buildColumns(sparse)
		expect(sparseColumns.find((column) => column.id === 'data_scientist')!.label).toBe('Data Scientist')
	})

	test('a config with no entry role still lists Human, workers, side, tools', () => {
		const columns = buildColumns({ roles: { coder: { tools: [] }, context_manager: { tools: [] } } })
		const ids = columns.map((column) => column.id)
		expect(ids).toEqual(['human', 'coder', 'context_manager', 'tools'])
	})
})

describe('deriveSequenceDiagram — column set from config', () => {
	test('the columns come from the config, independent of the run view', () => {
		const diagram: SequenceDiagram = deriveSequenceDiagram(mockConfig, { recentLog: [] })
		expect(diagram.columns.map((column) => column.id)).toEqual(buildColumns(mockConfig).map((column) => column.id))
		expect(diagram.messages).toEqual([])
	})

	test('an empty recentLog yields no messages', () => {
		const diagram: SequenceDiagram = deriveSequenceDiagram(mockConfig, runViewWith([]))
		expect(diagram.messages.length).toBe(0)
	})
})

describe('deriveSequenceDiagram — message ordering', () => {
	test('messages appear in recentLog order, with role-internal and control-flow events dropped', () => {
		const { config, runView } = scenarioFrame('delegation-in-progress', 2)
		const diagram: SequenceDiagram = deriveSequenceDiagram(config, runView)
		const recentLog = (runView as { recentLog: { timestamp: string, type: string, payload: { tool?: string } }[] }).recentLog
		// Dropped from the timeline: the llm_call (role-internal self) and the tool_call(agent) dispatch wrapper (control-flow builtin). The surviving messages are the inter-column interactions, in recentLog order.
		const survivingTimestamps = recentLog
			.filter((entry) => entry.type !== 'llm_call')
			.filter((entry) => !(entry.type === 'tool_call' && entry.payload?.tool === 'agent'))
			.map((entry) => entry.timestamp)
		expect(diagram.messages.map((message) => message.timestamp)).toEqual(survivingTimestamps)
	})

	test('each message carries its one-line summary and detail sections for inspection', () => {
		const { config, runView } = scenarioFrame('single-role-in-progress', 2)
		const diagram: SequenceDiagram = deriveSequenceDiagram(config, runView)
		const toolCall = diagram.messages.find((message) => message.type === 'tool_call')
		expect(toolCall).toBeDefined()
		expect(toolCall!.label).toContain('glob_files')
		expect(Array.isArray(toolCall!.detailSections)).toBe(true)
	})
})

describe('deriveSequenceDiagram — event-type routing', () => {
	test('role_start routes from the caller to the child column (entry role: Human → entry)', () => {
		const entry: SequenceMessage = deriveSequenceDiagram(mockConfig, runViewWith([logEntry({ type: 'role_start', role: 'orchestrator', summary: 'orchestrator · role start' })])).messages[0]!
		expect(entry.from).toBe('human')
		expect(entry.to).toBe('orchestrator')
		expect(entry.direction).toBe('call')
	})

	test('a delegated child\'s role_start is dropped when its agent_call already drew the delegation — one row per delegation, matching the flow view', () => {
		// The flow view shows a delegation as a single parent→child edge that appears with the agent_call and settles when the child produces its first turn. The child's role_start arrives one log event later and would draw a second arrow on the same lane — a phantom row with no corresponding flow-view edge. It is dropped; the agent_call already recorded the parent→child link the later role_finished needs.
		const messages: SequenceMessage[] = deriveSequenceDiagram(mockConfig, runViewWith([
			logEntry({ type: 'role_start', role: 'orchestrator', summary: 'orchestrator · role start' }),
			logEntry({ type: 'agent_call', parent: 'orchestrator', child: 'coder', summary: 'orchestrator · agent call → coder' }),
			logEntry({ type: 'role_start', role: 'coder', parent: 'orchestrator', summary: 'coder · role start' }),
			logEntry({ type: 'role_finished', role: 'coder', summary: 'coder · finished (success)' }),
		])).messages
		// The delegated role_start is dropped: no role_start whose target is coder survives (the only role_start is the entry role's, human→orchestrator).
		expect(messages.some((message) => message.type === 'role_start' && message.to === 'coder')).toBe(false)
		// The agent_call survives and carries the delegation (parent → child).
		const agentCall = messages.find((message) => message.type === 'agent_call')!
		expect(agentCall.from).toBe('orchestrator')
		expect(agentCall.to).toBe('coder')
		// role_finished still returns to the recorded parent (orchestrator), even though the finish payload carries no parent — the agent_call recorded it.
		const finished = messages.find((message) => message.type === 'role_finished')!
		expect(finished.from).toBe('coder')
		expect(finished.to).toBe('orchestrator')
		expect(finished.direction).toBe('return')
	})

	test('a delegated role_start with no preceding agent_call (a scenario starting mid-delegation) is kept so the delegation is represented and the return is not dangling', () => {
		// retry frame 0 starts mid-run: coder-1 has already errored, so its agent_call is not in the visible log. The coder role_start (parent orchestrator) is the only record of the delegation and must survive so the role_finished return has a source.
		const { config, runView } = scenarioFrame('retry', 0)
		const diagram: SequenceDiagram = deriveSequenceDiagram(config, runView)
		const coderStart = diagram.messages.find((message) => message.type === 'role_start' && message.to === 'coder')
		expect(coderStart).toBeDefined()
		expect(coderStart!.from).toBe('orchestrator')
		expect(coderStart!.to).toBe('coder')
	})

	test('tool_call routes role → tools; tool_result routes tools → role', () => {
		const messages: SequenceMessage[] = deriveSequenceDiagram(mockConfig, runViewWith([
			logEntry({ type: 'tool_call', role: 'planner', tool: 'glob_files', summary: 'planner · glob_files' }),
			logEntry({ type: 'tool_result', role: 'planner', tool: 'glob_files', summary: 'planner · glob_files result' }),
		])).messages
		const call = messages[0]!
		expect(call.from).toBe('planner')
		expect(call.to).toBe('tools')
		expect(call.direction).toBe('call')
		const result = messages[1]!
		expect(result.from).toBe('tools')
		expect(result.to).toBe('planner')
		expect(result.direction).toBe('return')
	})

	test('tool_call/tool_result for control-flow builtins (agent/finish/ask_human) are skipped — their semantics are carried by the paired semantic events', () => {
		// The executor emits a tool_call/tool_result dispatch wrapper around the agent/finish/ask_human builtins, then the dedicated agent_call/role_finished/ask_human event that carries the real semantics (see source/executor/engine.ts dispatchAndRecord). The wrapper must not draw a line to the tools column or the operation double-counts and contradicts the flow view's delegation/question edges.
		const messages: SequenceMessage[] = deriveSequenceDiagram(mockConfig, runViewWith([
			logEntry({ type: 'role_start', role: 'orchestrator', summary: 'orchestrator · role start' }),
			logEntry({ type: 'tool_call', role: 'orchestrator', tool: 'agent', summary: 'orchestrator · agent' }),
			logEntry({ type: 'agent_call', parent: 'orchestrator', child: 'planner', summary: 'orchestrator · agent call → planner' }),
			logEntry({ type: 'role_start', role: 'planner', parent: 'orchestrator', summary: 'planner · role start' }),
			logEntry({ type: 'tool_call', role: 'planner', tool: 'finish', summary: 'planner · finish' }),
			logEntry({ type: 'role_finished', role: 'planner', summary: 'planner · finished (success)' }),
			logEntry({ type: 'tool_result', role: 'planner', tool: 'finish', summary: 'planner · finish result' }),
			logEntry({ type: 'tool_call', role: 'orchestrator', tool: 'ask_human', summary: 'orchestrator · ask_human' }),
			logEntry({ type: 'ask_human', question: 'q', summary: 'ask_human' }),
		])).messages
		// No message reaches the tools column: every tool_call/tool_result in the log is a control-flow builtin.
		expect(messages.some((message) => message.to === 'tools' || message.from === 'tools')).toBe(false)
		// The semantic events survive and carry the real routing.
		expect(messages.some((message) => message.type === 'agent_call' && message.from === 'orchestrator' && message.to === 'planner')).toBe(true)
		expect(messages.some((message) => message.type === 'role_finished' && message.from === 'planner' && message.to === 'orchestrator')).toBe(true)
		expect(messages.some((message) => message.type === 'ask_human' && message.from === 'orchestrator' && message.to === 'human')).toBe(true)
	})

	test('the deep-multi-role-tree delegation frame draws the agent_call to the child, not a tool_call to the tools column', () => {
		// deep-multi-role-tree frame 2: the orchestrator delegates to planner. Its recentLog window carries the orchestrator's tool_call(agent) dispatch wrapper plus the agent_call; the diagram must keep only the agent_call so it matches the flow view's orchestrator→planner delegation edge.
		const { config, runView } = scenarioFrame('deep-multi-role-tree', 2)
		const diagram: SequenceDiagram = deriveSequenceDiagram(config, runView)
		expect(diagram.messages.some((message) => message.to === 'tools' || message.from === 'tools')).toBe(false)
		const agentCall = diagram.messages.find((message) => message.type === 'agent_call')
		expect(agentCall).toBeDefined()
		expect(agentCall!.from).toBe('orchestrator')
		expect(agentCall!.to).toBe('planner')
	})

	test('the child\'s role_start frame adds no row vs the agent_call frame — the delegation is one row, the arrow just settles', () => {
		// delegation-in-progress: frame 2 is the orchestrator→coder agent_call (the call in flight, flowing); frame 3 is the coder thinking (the call settled, coder active). The flow view adds no new node/edge at frame 3 — only the call edge settles and the coder pulses — so the sequence diagram must add no row either. The agent_call remains the last row; its arrow loses the flowing highlight (settles to static) and the coder node carries the active highlight.
		const frame2 = scenarioFrame('delegation-in-progress', 2)
		const frame3 = scenarioFrame('delegation-in-progress', 3)
		const diagram2: SequenceDiagram = deriveSequenceDiagram(frame2.config, { ...(frame2.runView as Record<string, unknown>), recentLog: accumulateRecentLog('delegation-in-progress', 2) })
		const diagram3: SequenceDiagram = deriveSequenceDiagram(frame3.config, { ...(frame3.runView as Record<string, unknown>), recentLog: accumulateRecentLog('delegation-in-progress', 3) })
		expect(diagram3.messages.length).toBe(diagram2.messages.length)
		// The coder's role_start (which the frame-3 window carries) is dropped because the agent_call already drew the delegation.
		expect(diagram3.messages.some((message) => message.type === 'role_start' && message.to === 'coder')).toBe(false)
		expect(diagram3.messages.some((message) => message.type === 'agent_call' && message.to === 'coder')).toBe(true)
	})

	test('ask_human routes to the Human column; human_answer routes from the Human column', () => {
		// The executor logs ask_human/human_answer without a role; the derivation uses the most recent role-bearing event as the asker/recipient, so the question reads orchestrator ↔ Human.
		const messages: SequenceMessage[] = deriveSequenceDiagram(mockConfig, runViewWith([
			logEntry({ type: 'role_start', role: 'orchestrator', summary: 'orchestrator · role start' }),
			logEntry({ type: 'ask_human', question: 'Which CI provider?', summary: 'ask_human' }),
			logEntry({ type: 'human_answer', answer: 'GitHub Actions', summary: 'human_answer' }),
		])).messages
		const ask = messages.find((message) => message.type === 'ask_human')!
		expect(ask.from).toBe('orchestrator')
		expect(ask.to).toBe('human')
		expect(ask.direction).toBe('call')
		const answer = messages.find((message) => message.type === 'human_answer')!
		expect(answer.from).toBe('human')
		expect(answer.to).toBe('orchestrator')
		expect(answer.direction).toBe('return')
	})

	test('a roleless ask_human with no prior role still routes through the Human column', () => {
		const ask: SequenceMessage = deriveSequenceDiagram(mockConfig, runViewWith([logEntry({ type: 'ask_human', question: 'q', summary: 'ask_human' })])).messages[0]!
		expect(ask.to).toBe('human')
		// The from falls back to Human when no role is in scope, so the Human column is always an endpoint.
		expect(ask.from).toBe('human')
	})

	test('role-internal events (llm_call, effort_set, context_budget_exceeded) produce no message — no loopback', () => {
		// A thinking role, an effort change, or a context-budget warning is the agent working on its own, not an interaction between participants. Such events are dropped from the timeline (they would otherwise render as self-loop "loopback" notches that clutter the diagram); the thinking state is conveyed by highlighting the recipient of the last interaction instead (see deriveSequenceActivity).
		const diagram: SequenceDiagram = deriveSequenceDiagram(mockConfig, runViewWith([
			logEntry({ type: 'role_start', role: 'orchestrator', summary: 'orchestrator · role start' }),
			logEntry({ type: 'llm_call', role: 'orchestrator', summary: 'orchestrator · llm call' }),
			logEntry({ type: 'effort_set', summary: 'effort set (5)' }),
			logEntry({ type: 'context_budget_exceeded', role: 'orchestrator', summary: 'orchestrator · context budget exceeded' }),
		]))
		expect(diagram.messages.length).toBe(1)
		expect(diagram.messages[0]!.type).toBe('role_start')
	})

	test('a role referencing a column the guild lacks falls back to Human rather than dangling', () => {
		const ghost: SequenceMessage = deriveSequenceDiagram(mockConfig, runViewWith([logEntry({ type: 'tool_call', role: 'ghost_role', tool: 'x', summary: 'ghost · x' })])).messages[0]!
		expect(ghost.from).toBe('human')
		expect(ghost.to).toBe('tools')
	})
})

describe('deriveSequenceDiagram — self-delegation', () => {
	test('a self-delegation (agent_call where parent === child) produces a self-message (from === to) that renders as a loopback', () => {
		// self-delegation frame 2: coder calls itself. The agent_call has parent: 'coder', child: 'coder', so from === to === 'coder'. This is a real interaction (the parent delegates to a child invocation of the same role), not a role-internal event, so it produces a message — one that renders as a loopback arrow on the coder column.
		const { config, runView } = scenarioFrame('self-delegation', 2)
		const diagram: SequenceDiagram = deriveSequenceDiagram(config, { ...(runView as Record<string, unknown>), recentLog: accumulateRecentLog('self-delegation', 2) })
		const selfCall = diagram.messages.find((message) => message.type === 'agent_call')
		expect(selfCall).toBeDefined()
		expect(selfCall!.from).toBe('coder')
		expect(selfCall!.to).toBe('coder')
		expect(selfCall!.direction).toBe('call')
	})

	test('a self-return (role_finished returning to the same role) produces a self-message (from === to)', () => {
		// self-delegation frame 4: the child coder finishes and returns to its parent (coder). The role_finished at depth 1 has parent: 'coder', so from === to === 'coder'.
		const { config, runView } = scenarioFrame('self-delegation', 4)
		const diagram: SequenceDiagram = deriveSequenceDiagram(config, { ...(runView as Record<string, unknown>), recentLog: accumulateRecentLog('self-delegation', 4) })
		const selfReturn = diagram.messages.find((message) => message.type === 'role_finished' && message.from === message.to)
		expect(selfReturn).toBeDefined()
		expect(selfReturn!.from).toBe('coder')
		expect(selfReturn!.to).toBe('coder')
		expect(selfReturn!.direction).toBe('return')
	})

	test('the depth-0 entry role\'s role_finished returns to Human, not to itself, after a self-delegation', () => {
		// self-delegation frame 6: the parent coder (depth 0) finishes. Its parent-of was recorded at role_start (depth 0, no parent → Human). The self-delegation's agent_call recorded parent-of for (coder, depth 1) = coder, so the depth-0 parent-of (Human) is not overwritten. The depth-0 role_finished returns to Human.
		const { config, runView } = scenarioFrame('self-delegation', 6)
		const diagram: SequenceDiagram = deriveSequenceDiagram(config, { ...(runView as Record<string, unknown>), recentLog: accumulateRecentLog('self-delegation', 6) })
		const toHuman = diagram.messages.find((message) => message.type === 'role_finished' && message.to === 'human')
		expect(toHuman).toBeDefined()
		expect(toHuman!.from).toBe('coder')
		expect(toHuman!.to).toBe('human')
		expect(toHuman!.direction).toBe('return')
	})
})

describe('deriveSequenceDiagram — completed vs in-progress', () => {
	test('a completed run derives its messages from the recentLog window just as an in-progress run does', () => {
		const completed = scenarioFrame('completed-success', 13)
		const diagram: SequenceDiagram = deriveSequenceDiagram(completed.config, completed.runView)
		// The terminal frame's recentLog still carries events; the diagram is driven by the log, not the status.
		expect(diagram.messages.length).toBeGreaterThan(0)
		const inProgress = scenarioFrame('completed-success', 0)
		const inProgressDiagram: SequenceDiagram = deriveSequenceDiagram(inProgress.config, inProgress.runView)
		expect(inProgressDiagram.messages.length).toBeGreaterThan(0)
		// Both produce the same column set (config-derived, status-independent).
		expect(diagram.columns.map((column) => column.id)).toEqual(inProgressDiagram.columns.map((column) => column.id))
	})
})

describe('deriveSequenceActivity — mirrors the flow view', () => {
	test('an in-flight tool call (flowing edge) makes the last message line blue/flowing and its target node active', () => {
		// tool-call-in-progress frame 2: coder→write_file call is in flight. The flow view pulses write_file (the call's target) and flows the coder→write_file edge. The sequence diagram's last message is the tool_call (coder→tools); its line should flow blue and the tools node (write_file) should be active.
		const frame = scenarioFrame('tool-call-in-progress', 2)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, frame.runView)
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram)!
		expect(activity.lineState).toBe('flowing')
		// The target column is 'tools' (write_file collapses to the tools column); write_file is the flowing edge's recipient, so it is active.
		expect(activity.targetState).toBe('active')
		// The calling role (coder) is not the active recipient and has no terminal status, so the source carries no highlight.
		expect(activity.sourceState).toBeNull()
	})

	test('an in-flight tool return (returning edge) makes the last line green/returning, the caller active, and the tool success', () => {
		// tool-call-in-progress frame 3: write_file returns green. The flow view pulses coder (the return's target) and colors write_file green (success). The sequence diagram's last message is the tool_result (tools→coder): its line flows green, the coder node is active, and the tools node (write_file) carries the success outcome.
		const frame = scenarioFrame('tool-call-in-progress', 3)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, frame.runView)
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram)!
		expect(activity.lineState).toBe('returning')
		expect(activity.targetState).toBe('active')
		expect(activity.sourceState).toBe('success')
	})

	test('an error return makes the last line red/error, the caller active, and the failing role error', () => {
		// retry frame 0: coder-1 errored and its return edge to the orchestrator is an error edge (red, flowing). The flow view pulses the orchestrator (the error return's target) and colors coder-1 red. The sequence diagram's last message is the role_finished (coder→orchestrator return): its line flows red, the orchestrator node is active, and the coder node (coder-1) carries the error outcome.
		const frame = scenarioFrame('retry', 0)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, frame.runView)
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram)!
		expect(activity.lineState).toBe('error')
		expect(activity.targetState).toBe('active')
		expect(activity.sourceState).toBe('error')
	})

	test('a thinking frame (no flowing edge) highlights the last interaction recipient active, with a static line', () => {
		// tool-call-in-progress frame 4: write_file has departed; coder is thinking (active flag, no flowing edge). The last interaction is the tool_result (tools→coder); coder is the recipient and is active, but the line is static (the operation already completed — the agent is now thinking, not receiving an in-flight message).
		const frame = scenarioFrame('tool-call-in-progress', 4)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, frame.runView)
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram)!
		expect(activity.lineState).toBeNull()
		expect(activity.targetState).toBe('active')
		// write_file has departed the main area, so the tools column carries no terminal status here.
		expect(activity.sourceState).toBeNull()
	})

	test('a settled frame with no flow model yields no activity', () => {
		const diagram: SequenceDiagram = { columns: [], messages: [] }
		expect(deriveSequenceActivity(undefined, { activeIds: new Set(), edgeStates: [] }, diagram)).toBeNull()
	})

	test('a diagram with no messages yields no activity', () => {
		const diagram: SequenceDiagram = deriveSequenceDiagram(mockConfig, runViewWith([]))
		const flowModel: FlowModel = { mainArea: { nodes: [], edges: [] }, topBar: { nodes: [] } }
		expect(deriveSequenceActivity(flowModel, { activeIds: new Set(), edgeStates: [] }, diagram)).toBeNull()
	})

	test('a self-call in flight (self-delegation) highlights the loopback blue/flowing and the node active', () => {
		// self-delegation frame 2: coder calls itself (agent_call coder→coder). The flow view pulses the child coder (the call's target) and flows the coder→coder edge. The sequence diagram's last message is the self-call: its loopback arrow flows blue and the coder node is active.
		const frame = scenarioFrame('self-delegation', 2)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('self-delegation', 2) })
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram)!
		expect(activity.lineState).toBe('flowing')
		expect(activity.targetState).toBe('active')
		// No separate source node for a self-message (from === to).
		expect(activity.sourceState).toBeNull()
	})

	test('a self-call settled (child thinking) removes the loopback highlight but leaves the node active', () => {
		// self-delegation frame 3: the self-call has settled; the child coder is thinking (active flag, no flowing edge). The loopback arrow loses its highlight (static), and the coder node stays active.
		const frame = scenarioFrame('self-delegation', 3)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('self-delegation', 3) })
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram)!
		expect(activity.lineState).toBeNull()
		expect(activity.targetState).toBe('active')
		expect(activity.sourceState).toBeNull()
	})

	test('a self-return in flight carries the outcome (green success / red error) on the node, not the active blue', () => {
		// self-delegation frame 4: the child coder finishes (success) and returns to its parent (coder→coder). The flow view pulses coder-1 (the return's target) and colors coder-2 green (success). For a self-return in flight, the outcome (green) is the informative state on the single terminal node — the user wants the result color — so it takes precedence over the active blue.
		const frame = scenarioFrame('self-delegation', 4)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('self-delegation', 4) })
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram)!
		expect(activity.lineState).toBe('returning')
		expect(activity.targetState).toBe('success')
		expect(activity.sourceState).toBeNull()
	})

	test('a self-return settled (parent thinking) removes the highlight and reverts to active', () => {
		// self-delegation frame 5: the child has departed; the parent coder is thinking (active flag). The self-return loopback loses its highlight (static), and the coder node carries the active (blue) state — the parent is now processing.
		const frame = scenarioFrame('self-delegation', 5)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('self-delegation', 5) })
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram)!
		expect(activity.lineState).toBeNull()
		expect(activity.targetState).toBe('active')
		expect(activity.sourceState).toBeNull()
	})
})

describe('deriveSequenceActivity — edge cases across scenarios', () => {
	test('a flowing edge to a hidden ask_human tool does NOT animate the last message — the conductor is active, not the line', () => {
		// pending-question frame 2 (step 3): the orchestrator calls ask_human (a control-flow tool the sequence view doesn't show). The flow view flows the orchestrator→ask_human edge, but since the sequence view has no ask_human message, the last message (role_start) is not animated. The orchestrator (the caller of the hidden tool) is active instead.
		const frame = scenarioFrame('pending-question', 2)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('pending-question', 2) })
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram)!
		expect(activity.lineState).toBeNull()
		expect(activity.targetState).toBe('active')
	})

	test('a departed role retains its success color on the sequence node (top bar status scan)', () => {
		// deep-multi-role-tree frame 10 (step 11): context_manager has departed to the top bar with status:success. Its role_finished node should still be green (success), not neutral. The source of the last message (context_manager) carries the success outcome from the top bar.
		const frame = scenarioFrame('deep-multi-role-tree', 10)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('deep-multi-role-tree', 10) })
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram)!
		expect(activity.sourceState).toBe('success')
	})

	test('a role_finished without depth returns to the parent recorded at the agent_call (bare-key fallback)', () => {
		// deep-multi-role-tree frame 9 (step 10): the context_manager's role_finished payload has no `parent` and no `depth`, but the agent_call recorded the parent (planner) under the bare role-name key. The return goes to planner, not Human.
		const frame = scenarioFrame('deep-multi-role-tree', 9)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('deep-multi-role-tree', 9) })
		const last = diagram.messages[diagram.messages.length - 1]!
		expect(last.type).toBe('role_finished')
		expect(last.from).toBe('context_manager')
		expect(last.to).toBe('planner')
	})

	test('a thinking role is active on its own column with no animated line', () => {
		// detected-loop frame 1 (step 2): the coder is stuck repeating read_file (thinking, active flag). The orphan tool_calls are dropped, so the last message is the role_start (human→coder). The coder (target) is active, the line is static (no flowing edge), and there are no tool_call lines.
		const frame = scenarioFrame('detected-loop', 1)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('detected-loop', 1) })
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram, (frame.runView as { status: string }).status)
		expect(activity!.lineState).toBeNull()
		expect(activity!.targetState).toBe('active')
	})

	test('an overseer agent_call (loop_detector in its own row) is filtered — no line from builder to watchdog', () => {
		// detected-loop frame 2 (step 3): the loop_detector is spawned via an agent_call (parent: coder, child: loop_detector) but sits in its own row in the flow view (no call edge from coder to loop_detector). The agent_call is dropped from the accumulated timeline.
		const frame = scenarioFrame('detected-loop', 2)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('detected-loop', 2) })
		expect(diagram.messages.some((message) => message.type === 'agent_call' && message.from === 'coder' && message.to === 'loop_detector')).toBe(false)
	})

	test('a terminal success frame marks Human active and suppresses the source node', () => {
		// deep-multi-role-tree frame 14 (terminal success): the run is done, only You remains. The last message targets Human (role_finished orchestrator→human), so target=active (Human) and source=null (no node at the tail — the returning orchestrator has departed; its outcome was shown when it was in flight).
		const frame = scenarioFrame('deep-multi-role-tree', 14)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('deep-multi-role-tree', 14) })
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram, (frame.runView as { status: string }).status)
		expect(activity).not.toBeNull()
		expect(activity!.lineState).toBeNull()
		expect(activity!.targetState).toBe('active')
		expect(activity!.sourceState).toBeNull()
		expect(activity!.extraActiveColumn).toBeNull()
	})

	test('a terminal interrupted frame whose last message does not target Human renders an extra active node on Human', () => {
		// detected-loop frame 4 (terminal interrupted): the run is interrupted, only You remains. The trigger_interrupt tool_call is dropped (control-flow tool); the last message is the tool_result (tools→loop_detector), whose target is not Human. The terminal override marks Human active via an extra active node (extraActiveColumn='human') so "You" still reads as active, and the source is suppressed.
		const frame = scenarioFrame('detected-loop', 4)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('detected-loop', 4) })
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram, (frame.runView as { status: string }).status)
		expect(activity).not.toBeNull()
		expect(activity!.lineState).toBeNull()
		expect(activity!.sourceState).toBeNull()
		expect(activity!.extraActiveColumn).toBe('human')
		// The trigger_interrupt tool_call is dropped (control-flow tool) — no watchdog→tools line.
		expect(diagram.messages.some((message) => message.label.includes('trigger_interrupt'))).toBe(false)
	})
})

describe('filterOrphanToolCalls', () => {
	test('drops a tool_call with no matching tool_result (an orphan from a truncated window)', () => {
		const events = [
			logEntry({ type: 'role_start', role: 'coder', summary: 'coder · role start' }),
			logEntry({ type: 'tool_call', role: 'coder', tool: 'read_file', summary: 'coder · read_file' }),
			logEntry({ type: 'tool_call', role: 'coder', tool: 'read_file', summary: 'coder · read_file (2)' }),
		]
		const filtered = filterOrphanToolCalls(events, new Set())
		expect(filtered.length).toBe(1)
		expect((filtered[0] as { type: string }).type).toBe('role_start')
	})

	test('keeps a tool_call that has a matching tool_result', () => {
		const events = [
			logEntry({ type: 'tool_call', role: 'coder', tool: 'write_file', summary: 'coder · write_file' }),
			logEntry({ type: 'tool_result', role: 'coder', tool: 'write_file', summary: 'coder · write_file result' }),
		]
		const filtered = filterOrphanToolCalls(events, new Set())
		expect(filtered.length).toBe(2)
	})

	test('keeps the last orphan tool_call when the tool is currently in-flight (flowing)', () => {
		const events = [
			logEntry({ type: 'role_start', role: 'coder', summary: 'coder · role start' }),
			logEntry({ type: 'tool_call', role: 'coder', tool: 'write_file', summary: 'coder · write_file' }),
		]
		const filtered = filterOrphanToolCalls(events, new Set(['write_file']))
		expect(filtered.length).toBe(2)
		expect((filtered[1] as { type: string }).type).toBe('tool_call')
	})

	test('drops an orphan tool_call that is not the last event even if the tool is flowing', () => {
		const events = [
			logEntry({ type: 'tool_call', role: 'coder', tool: 'read_file', summary: 'coder · read_file' }),
			logEntry({ type: 'role_start', role: 'coder', summary: 'coder · role start' }),
		]
		const filtered = filterOrphanToolCalls(events, new Set(['read_file']))
		expect(filtered.length).toBe(1)
		expect((filtered[0] as { type: string }).type).toBe('role_start')
	})
})

describe('deriveSequenceDiagram — detected-loop scenario', () => {
	test('frame 1 (step 2) shows only the role_start with the builder active — no orphan tool_call lines', () => {
		// The coder is stuck mid-loop repeating read_file, but the recentLog windows don't capture the tool_results. The orphan tool_calls are dropped, leaving only the role_start (human→coder) row. The coder (source of the last interaction) is active.
		const frame = scenarioFrame('detected-loop', 1)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('detected-loop', 1) })
		expect(diagram.messages.length).toBe(1)
		expect(diagram.messages[0]!.type).toBe('role_start')
		expect(diagram.messages[0]!.from).toBe('human')
		expect(diagram.messages[0]!.to).toBe('coder')
	})

	test('frame 4 (step 5) has no trigger_interrupt tool_call — only the watchdog\'s complete recent_role_tool_calls interaction remains', () => {
		// trigger_interrupt is a control-flow tool (its dispatch wrapper is dropped; the interrupt_triggered event carries the semantics). The recent_role_tool_calls call+result is a complete interaction and stays. The terminal override marks only "You" active.
		const frame = scenarioFrame('detected-loop', 4)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, { ...(frame.runView as Record<string, unknown>), recentLog: accumulateRecentLog('detected-loop', 4) })
		expect(diagram.messages.some((message) => message.label.includes('trigger_interrupt'))).toBe(false)
		expect(diagram.messages.some((message) => message.type === 'tool_call' && message.label.includes('recent_role_tool_calls'))).toBe(true)
		expect(diagram.messages.some((message) => message.type === 'tool_result' && message.label.includes('recent_role_tool_calls'))).toBe(true)
	})
})

describe('renderSequenceDiagram', () => {
	const { COLUMN_WIDTH, HEADER_HEIGHT, ROW_HEIGHT, LEFT_MARGIN, RIGHT_MARGIN, BOTTOM_MARGIN } = SEQUENCE_CONSTANTS

	test('renders an SVG with a viewBox sized to the columns and messages', () => {
		const diagram: SequenceDiagram = deriveSequenceDiagram(mockConfig, runViewWith([logEntry({ type: 'role_start', role: 'orchestrator', summary: 'orchestrator · role start' })]))
		const view: Vnode = renderSequenceDiagram(fakeH, diagram)
		expect(view.tag).toBe('svg')
		expect(view.props.class).toBe('sequence-view-svg')
		const columnCount = diagram.columns.length
		const expectedWidth = LEFT_MARGIN + (columnCount - 1) * COLUMN_WIDTH + RIGHT_MARGIN
		const expectedHeight = HEADER_HEIGHT + diagram.messages.length * ROW_HEIGHT + BOTTOM_MARGIN
		expect(view.props.viewBox).toBe(`0 0 ${expectedWidth} ${expectedHeight}`)
	})

	test('renders one column header label and one lifeline per column', () => {
		const view: Vnode = renderSequenceDiagram(fakeH, deriveSequenceDiagram(mockConfig, runViewWith([])))
		const labels = allByTag(view, 'text').filter((text) => text.props.class === 'seq-column-label')
		expect(labels.length).toBe(diagramColumnCount(mockConfig))
		const lifelines = allByTag(view, 'line').filter((line) => line.props.class === 'seq-lifeline')
		expect(lifelines.length).toBe(diagramColumnCount(mockConfig))
		// An empty diagram still has a positive viewBox height (header + bottom margin) and zero-length lifelines.
		const viewBox = view.props.viewBox as string
		expect(viewBox.endsWith(` ${HEADER_HEIGHT + BOTTOM_MARGIN}`)).toBe(true)
	})

	test('renders one message path and one terminal node per message, each arrowed and titled', () => {
		const { config, runView } = scenarioFrame('delegation-in-progress', 2)
		const diagram: SequenceDiagram = deriveSequenceDiagram(config, runView)
		const view: Vnode = renderSequenceDiagram(fakeH, diagram)
		const messages = allByTag(view, 'path').filter((path) => typeof path.props.class === 'string' && (path.props.class as string).includes('seq-message'))
		expect(messages.length).toBe(diagram.messages.length)
		// Every message path references an arrowhead marker and carries a native <title>.
		const validMarkers = new Set(['url(#seq-arrow-neutral)', 'url(#seq-arrow-flowing)', 'url(#seq-arrow-returning)', 'url(#seq-arrow-error)'])
		for (const path of messages) {
			expect(validMarkers.has(path.props['marker-end'] as string)).toBe(true)
			expect(byTag(path, 'title').length).toBe(1)
		}
		// One terminal node per message, each carrying a hover title.
		const nodes = allByTag(view, 'g').filter((group) => typeof group.props.class === 'string' && (group.props.class as string).startsWith('seq-node'))
		expect(nodes.length).toBe(diagram.messages.length)
		for (const node of nodes) expect(byTag(node, 'title').length).toBe(1)
		// The four arrowhead markers (one per line color) are declared once each.
		for (const id of ['seq-arrow-neutral', 'seq-arrow-flowing', 'seq-arrow-returning', 'seq-arrow-error']) {
			expect(allByTag(view, 'marker').filter((marker) => marker.props.id === id).length).toBe(1)
		}
	})

	test('a past call is a solid neutral line and a past return is a dashed neutral line', () => {
		// Without an activity descriptor, every message renders in its past (settled) styling: calls solid neutral, returns dashed neutral. Uses real native tools so the call/return survive.
		const diagram: SequenceDiagram = deriveSequenceDiagram(mockConfig, runViewWith([
			logEntry({ type: 'role_start', role: 'orchestrator', summary: 'orchestrator · role start' }),
			logEntry({ type: 'tool_call', role: 'orchestrator', tool: 'write_file', summary: 'orchestrator · write_file' }),
			logEntry({ type: 'tool_result', role: 'orchestrator', tool: 'write_file', summary: 'orchestrator · write_file result' }),
		]))
		const view: Vnode = renderSequenceDiagram(fakeH, diagram)
		const lines = allByTag(view, 'path').filter((path) => typeof path.props.class === 'string' && (path.props.class as string).includes('seq-message'))
		// The call (role_start, tool_call) lines are solid neutral — just the base 'seq-message' class, no '--return'.
		const calls = lines.filter((path) => !(path.props.class as string).includes('seq-message--return'))
		expect(calls.length).toBe(2)
		// The return (tool_result) line is dashed neutral.
		const ret = lines.find((path) => (path.props.class as string).includes('seq-message--return'))!
		expect(ret).toBeDefined()
		// A call line travels from its source column x to the target node's near edge (an M ... L ... path).
		const callD = calls[1]!.props.d as string
		expect(callD.startsWith('M ')).toBe(true)
		expect(callD.includes(' L ')).toBe(true)
	})

	test('the active (last) message line carries the flowing/returning/error class and its node carries the active/success/error state', () => {
		// tool-call-in-progress frame 3: the last message (tool_result) is a returning line; the coder node is active and the tools node (write_file) is success.
		const frame = scenarioFrame('tool-call-in-progress', 3)
		const diagram: SequenceDiagram = deriveSequenceDiagram(frame.config, frame.runView)
		const flowAnimation = deriveFlowAnimation(frame.flowModel)
		const activity = deriveSequenceActivity(frame.flowModel, flowAnimation, diagram)!
		const view: Vnode = renderSequenceDiagram(fakeH, diagram, activity)
		// The last message line carries the returning class (green marching ants).
		const lines = allByTag(view, 'path').filter((path) => typeof path.props.class === 'string' && (path.props.class as string).includes('seq-message'))
		const lastLine = lines[lines.length - 1]!
		expect((lastLine.props.class as string).includes('seq-message--returning')).toBe(true)
		// The last message's target node (coder) carries the active class; the source node (tools, write_file) carries the success class.
		const nodes = allByTag(view, 'g').filter((group) => typeof group.props.class === 'string' && (group.props.class as string).startsWith('seq-node'))
		expect(nodes.some((node) => (node.props.class as string).includes('seq-node--active'))).toBe(true)
		expect(nodes.some((node) => (node.props.class as string).includes('seq-node--success'))).toBe(true)
	})

	test('a message to an unknown column id is still placed at the left margin rather than dropped', () => {
		const diagram: SequenceDiagram = { columns: [{ id: 'human', label: 'You', kind: 'human' }], messages: [{ from: 'human', to: 'ghost', direction: 'call', label: 'x', detailSections: null, timestamp: 't', type: 'tool_call' }] }
		const view: Vnode = renderSequenceDiagram(fakeH, diagram)
		const messages = allByTag(view, 'path').filter((path) => typeof path.props.class === 'string' && (path.props.class as string).includes('seq-message'))
		expect(messages.length).toBe(1)
	})

	test('a self-message (from === to) renders as a rectangular loopback path, not a straight line', () => {
		// A self-delegation's agent_call (coder→coder) and self-return (coder→coder) render as small rectangular loops: right-then-down-then-left for calls, left-then-down-then-right for returns. The path's `d` attribute uses the h/v/h pattern (not the M ... L ... straight-line pattern).
		const diagram: SequenceDiagram = deriveSequenceDiagram(mockConfig, runViewWith([
			logEntry({ type: 'role_start', role: 'coder', summary: 'coder · role start' }),
			logEntry({ type: 'agent_call', parent: 'coder', child: 'coder', summary: 'coder · agent call → coder' }),
			logEntry({ type: 'role_finished', role: 'coder', parent: 'coder', summary: 'coder · finished (success)' }),
		]))
		const view: Vnode = renderSequenceDiagram(fakeH, diagram)
		const lines = allByTag(view, 'path').filter((path) => typeof path.props.class === 'string' && (path.props.class as string).includes('seq-message'))
		// The self-call (agent_call, direction 'call') loopback goes right: h 20 v 14 h -20.
		const selfCall = lines.find((path) => (path.props.d as string).includes('h 20') && (path.props.d as string).includes('h -20'))
		expect(selfCall).toBeDefined()
		// The self-return (role_finished, direction 'return') loopback goes left: h -20 v 14 h 20.
		const selfReturn = lines.find((path) => (path.props.d as string).includes('h -20') && (path.props.d as string).includes('h 20') && !(path.props.d as string).includes('h -20 v 14 h -20'))
		expect(selfReturn).toBeDefined()
		// Neither self-message uses the straight-line L command.
		expect((selfCall!.props.d as string).includes(' L ')).toBe(false)
		expect((selfReturn!.props.d as string).includes(' L ')).toBe(false)
	})
})

function diagramColumnCount(config: unknown): number {
	return buildColumns(config).length
}
