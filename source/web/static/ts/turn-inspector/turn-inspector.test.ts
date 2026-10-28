import { describe, expect, test } from 'bun:test'
import { createInspectorSession } from './index.js'
import type { FetchRequest, InspectorSession, InspectorView } from './index.js'

function defined<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`${label} is undefined`)
	return value
}

function present<T>(value: T | null, label: string): T {
	if (value === null) throw new Error(`${label} is null`)
	return value
}

interface WindowEvent {
	index: number
	timestamp: string
	type: string
	payload: unknown
}

function startEvent(index: number, role: string, roleId = `${role}-1`): WindowEvent {
	const payload: Record<string, unknown> = { role, roleId }
	return { index, timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`, type: 'llm_call_start', payload }
}

function callEvent(index: number, role: string, overrides: Record<string, unknown> = {}): WindowEvent {
	return {
		index,
		timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`,
		type: 'llm_call',
		payload: {
			role,
			roleId: `${role}-1`,
			messageCount: 3,
			sentFrom: 0,
			sent: [{ role: 'user', content: 'do the thing' }],
			received: { content: 'on it', reasoning: 'thinking hard', toolCalls: [] },
			usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
			finishReason: 'tool_calls',
			...overrides,
		},
	}
}

function standardCallEvent(index: number, role: string): WindowEvent {
	return callEvent(index, role, { sent: undefined, received: undefined, sentFrom: undefined })
}

function turnFailureEvent(index: number, type: 'llm_unavailable' | 'context_budget_exceeded', role: string): WindowEvent {
	const payload: Record<string, unknown> = type === 'llm_unavailable' ? { role, message: 'endpoint down' } : { role, promptTokens: 9000, contextWindow: 8000 }
	return { index, timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`, type, payload }
}

function providerFailureEvent(index: number, role: string, roleId = `${role}-1`): WindowEvent {
	return { index, timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`, type: 'provider_failure', payload: { role, roleId, category: 'billing', attempts: 1, partialOutput: false, message: 'The model provider reports insufficient quota or credit (HTTP 402)' } }
}

function roleStartEvent(index: number, roleId: string, role: string, extras: Record<string, unknown> = {}): WindowEvent {
	return { index, timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`, type: 'role_start', payload: { role, roleId, depth: 0, task: 't', ...extras } }
}

function roleFinishedEvent(index: number, roleId: string, role: string): WindowEvent {
	return { index, timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}Z`, type: 'role_finished', payload: { role, roleId, depth: 0, status: 'success' } }
}

function wireToolCall(id: string, name: string, args: string): Record<string, unknown> {
	return { id, type: 'function', function: { name, arguments: args } }
}

function windowBody(events: unknown[], total = events.length, offset = 0, runId = 'run-1'): Record<string, unknown> {
	return { runId, total, offset, events }
}

function startedSession(options: { wireDetailCacheLimit?: number } = {}): { session: InspectorSession; request: FetchRequest } {
	const session = createInspectorSession(options)
	const request = session.start('run-1')
	if (request === null) throw new Error('start did not return a probe')
	return { session, request }
}

// Lands a probe and the window it asks for, so a helper can present an already-loaded window through the public contract without pretending a probe is a window response.
function landWindow(session: InspectorSession, request: FetchRequest, body: unknown): void {
	const result = session.receive(request, body, null)
	if (result.followUp !== null) session.receive(result.followUp, body, null)
}

function sessionFor(events: unknown[], options: { scopedRoleId?: string | null; total?: number; offset?: number; wireDetailCacheLimit?: number } = {}): InspectorSession {
	const { session, request } = startedSession({ wireDetailCacheLimit: options.wireDetailCacheLimit })
	const body = windowBody(events, options.total ?? events.length, options.offset ?? 0)
	landWindow(session, request, body)
	if (options.scopedRoleId !== undefined && options.scopedRoleId !== null) {
		const scoped = session.scope(options.scopedRoleId)
		if (scoped.request !== null) landWindow(session, scoped.request, body)
	}
	return session
}

const stitchEvents: WindowEvent[] = [
	startEvent(0, 'coder', 'coder-1'),
	callEvent(1, 'coder', {
		roleId: 'coder-1',
		messageCount: 2,
		sentFrom: 0,
		sent: [
			{ role: 'system', content: 'system prompt text' },
			{ role: 'user', content: 'the task text' },
		],
		received: { content: 'turn one reply', reasoning: 'turn one thinking', toolCalls: [wireToolCall('c1', 'write_file', '{"path":"a.txt"}')] },
		usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
		finishReason: 'tool_calls',
	}),
	callEvent(2, 'coder', {
		roleId: 'coder-1',
		messageCount: 4,
		sentFrom: 2,
		sent: [
			{ role: 'assistant', content: 'turn one reply', tool_calls: [wireToolCall('c1', 'write_file', '{"path":"a.txt"}')] },
			{ role: 'tool', content: '{"kind":"tool_error","message":"no space"}' },
		],
		received: { content: 'turn two reply', reasoning: 'turn two thinking', toolCalls: [] },
		usage: { promptTokens: 200, completionTokens: 10, totalTokens: 210 },
		finishReason: 'stop',
	}),
]

function transcriptOf(session: InspectorSession): InspectorView['transcript'] {
	return session.view().transcript
}

describe('turn pairing and view scoping', () => {
	test('pairs llm_call_start with the following same-role llm_call into one completed turn', () => {
		const session = sessionFor([startEvent(0, 'planner'), callEvent(3, 'planner')], { scopedRoleId: 'planner-1' })
		const turns = transcriptOf(session)
		expect(turns).toHaveLength(1)
		const turn = defined(turns[0], 'turns[0]')
		expect(turn.kind).toBe('completed')
		expect(turn.eventIndex).toBe(3)
		expect(turn.turnNumber).toBe(1)
		expect(turn.bodyLevel).toBe('full')
		expect(turn.finishReason).toBe('tool_calls')
		expect(present(turn.usage, 'turn.usage')).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 })
	})

	test('an llm_call_start without a matching llm_call is in flight; a failure event closes it', () => {
		const flight = sessionFor([startEvent(4, 'coder')], { scopedRoleId: 'coder-1' })
		const turns = transcriptOf(flight)
		expect(turns).toHaveLength(1)
		const turn = defined(turns[0], 'turns[0]')
		expect(turn.kind).toBe('in_flight')
		expect(turn.usage).toBeNull()
		expect(turn.finishReason).toBeNull()
		expect(turn.bodyLevel).toBeNull()
		expect(sessionFor([startEvent(0, 'coder', 'coder-1'), turnFailureEvent(1, 'llm_unavailable', 'coder')]).view().transcript).toEqual([])
		expect(sessionFor([startEvent(0, 'coder', 'coder-1'), turnFailureEvent(1, 'context_budget_exceeded', 'coder')]).view().transcript).toEqual([])
		expect(sessionFor([startEvent(0, 'coder', 'coder-1'), providerFailureEvent(1, 'coder', 'coder-1')]).view().transcript).toEqual([])
	})

	test('provider_failure closes the exact in-flight instance and leaves a same-named sibling open', () => {
		const events = [startEvent(0, 'coder', 'coder-1'), startEvent(1, 'coder', 'coder-2'), providerFailureEvent(2, 'coder', 'coder-1')]
		expect(transcriptOf(sessionFor(events, { scopedRoleId: 'coder-1' }))).toEqual([])
		const sibling = transcriptOf(sessionFor(events, { scopedRoleId: 'coder-2' }))
		expect(sibling.map((turn) => turn.kind)).toEqual(['in_flight'])
		expect(defined(sibling[0], 'sibling[0]').eventIndex).toBe(1)
	})

	test('a resume replay after a provider failure pairs the fresh start and call without reviving the failed turn', () => {
		const events = [
			startEvent(0, 'coder', 'coder-1'),
			providerFailureEvent(1, 'coder', 'coder-1'),
			{ index: 2, timestamp: '2026-01-01T00:00:02Z', type: 'run_resumed', payload: { runId: 'run-1', resumedFrames: 1 } },
			startEvent(3, 'coder', 'coder-1'),
			callEvent(4, 'coder', { roleId: 'coder-1' }),
		]
		const turns = transcriptOf(sessionFor(events, { scopedRoleId: 'coder-1' }))
		expect(turns).toHaveLength(1)
		const turn = defined(turns[0], 'turns[0]')
		expect(turn.kind).toBe('completed')
		expect(turn.eventIndex).toBe(4)
	})

	test('same-name nesting pairs LIFO, and the failure closes the newest open start', () => {
		const nested = sessionFor([startEvent(0, 'coder'), startEvent(1, 'coder'), callEvent(2, 'coder'), callEvent(3, 'coder')], { scopedRoleId: 'coder-1' })
		expect(transcriptOf(nested).map((turn) => turn.eventIndex)).toEqual([2, 3])
		const failed = sessionFor([startEvent(0, 'coder'), startEvent(1, 'coder'), turnFailureEvent(2, 'llm_unavailable', 'coder')], { scopedRoleId: 'coder-1' })
		const turns = transcriptOf(failed)
		expect(turns).toHaveLength(1)
		expect(defined(turns[0], 'turns[0]').eventIndex).toBe(0)
	})

	test('pairing is keyed by roleId, so a same-named sibling does not complete another instance start', () => {
		const events = [startEvent(0, 'coder', 'coder-1'), callEvent(1, 'coder', { roleId: 'coder-2' })]
		const first = transcriptOf(sessionFor(events, { scopedRoleId: 'coder-1' }))
		expect(first.map((turn) => turn.kind)).toEqual(['in_flight'])
		expect(defined(first[0], 'first[0]').roleId).toBe('coder-1')
		const second = transcriptOf(sessionFor(events, { scopedRoleId: 'coder-2' }))
		expect(second.map((turn) => turn.kind)).toEqual(['completed'])
		expect(defined(second[0], 'second[0]').roleId).toBe('coder-2')
	})

	test('turn headers carry the payload roleId', () => {
		const session = sessionFor([
			startEvent(0, 'planner', 'planner-0-1'),
			callEvent(3, 'planner', { roleId: 'planner-0-1' }),
			startEvent(5, 'coder', 'coder-1'),
			standardCallEvent(7, 'critic'),
		])
		expect(session.view().scopedRoleId).toBe('coder-1')
		expect(sessionFor([startEvent(0, 'coder', 'coder-1')], { scopedRoleId: 'coder-1' }).view().transcript[0]?.roleId).toBe('coder-1')
		expect(sessionFor([standardCallEvent(7, 'critic')], { scopedRoleId: 'critic-1' }).view().transcript[0]?.roleId).toBe('critic-1')
	})

	test('malformed rows are skipped so one torn row cannot corrupt the list', () => {
		const session = sessionFor([
			null,
			'broken',
			{ index: 0, timestamp: 't', type: 'tool_call', payload: { role: 'x' } },
			{ index: 1, timestamp: 't', type: 'llm_call', payload: 'not-a-record' },
			{ index: 2, timestamp: 't', type: 'llm_call', payload: { usage: {} } },
			{ timestamp: 't', type: 'llm_call', payload: { role: 'planner' } },
			{ index: '4', timestamp: 't', type: 'llm_call', payload: { role: 'planner' } },
			{ index: -1, timestamp: 't', type: 'llm_call', payload: { role: 'planner' } },
			startEvent(5, 'coder'),
		], { scopedRoleId: 'coder-1' })
		const turns = transcriptOf(session)
		expect(turns).toHaveLength(1)
		expect(defined(turns[0], 'turns[0]').kind).toBe('in_flight')
	})

	test('a sparse completed llm_call and a failure with no open start leave the list honest', () => {
		const sparse = sessionFor([{ index: 3, timestamp: 't', type: 'llm_call', payload: { role: 'planner', roleId: 'planner-1' } }], { scopedRoleId: 'planner-1' })
		const turn = defined(sparse.view().transcript[0], 'sparse turn')
		expect(turn.kind).toBe('completed')
		expect(turn.usage).toBeNull()
		expect(turn.finishReason).toBeNull()
		expect(turn.bodyLevel).toBe('standard')
		expect(turn.messageCount).toBeNull()
		const failed = sessionFor([
			callEvent(0, 'planner', { roleId: 'planner-0-1' }),
			turnFailureEvent(1, 'context_budget_exceeded', 'coder'),
		], { scopedRoleId: 'planner-0-1' })
		expect(failed.view().transcript.map((entry) => entry.eventIndex)).toEqual([0])
	})

	test('a standard-level turn renders header data only, and usage/messageCount survive', () => {
		const session = sessionFor([standardCallEvent(0, 'coder')], { scopedRoleId: 'coder-1' })
		const turn = defined(transcriptOf(session)[0], 'turn')
		expect(turn.bodyLevel).toBe('standard')
		expect(turn.messages).toHaveLength(0)
		expect(turn.received).toBeNull()
		expect(present(turn.usage, 'usage').totalTokens).toBe(120)
		expect(turn.finishReason).toBe('tool_calls')
		expect(turn.messageCount).toBe(3)
	})

	test('usage carries cached tokens and malformed usage reads as none', () => {
		const cached = sessionFor([callEvent(0, 'coder', { usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 8 } })], { scopedRoleId: 'coder-1' })
		expect(present(defined(transcriptOf(cached)[0], 'cached[0]').usage, 'usage').cachedPromptTokens).toBe(8)
		expect(defined(transcriptOf(sessionFor([callEvent(1, 'coder', { usage: 'broken' })], { scopedRoleId: 'coder-1' }))[0], 'missing').usage).toBeNull()
		expect(defined(transcriptOf(sessionFor([callEvent(2, 'coder', { usage: { promptTokens: Number.NaN, completionTokens: 5, totalTokens: 15 } })], { scopedRoleId: 'coder-1' }))[0], 'nan').usage).toBeNull()
	})

	test('the default scope is the newest in-flight turn, else the newest completed one; a failed ghost is ignored', () => {
		const settled = sessionFor([callEvent(1, 'planner', { roleId: 'planner-0-1' }), callEvent(5, 'critic', { roleId: 'critic-0-1' })])
		expect(settled.view().scopedRoleId).toBe('critic-0-1')
		const withFlight = sessionFor([callEvent(1, 'planner', { roleId: 'planner-0-1' }), startEvent(3, 'coder', 'coder-1-2')])
		expect(withFlight.view().scopedRoleId).toBe('coder-1-2')
		const mixed = sessionFor([startEvent(1, 'coder', 'coder-1-2'), callEvent(5, 'critic', { roleId: 'critic-0-1' })])
		expect(mixed.view().scopedRoleId).toBe('coder-1-2')
		const failed = sessionFor([startEvent(0, 'coder', 'coder-1-2'), turnFailureEvent(1, 'llm_unavailable', 'coder'), callEvent(5, 'critic', { roleId: 'critic-0-1' })])
		expect(failed.view().scopedRoleId).toBe('critic-0-1')
		expect(sessionFor([]).view().scopedRoleId).toBeNull()
	})
})

describe('instances and ancestry', () => {
	test('lists real instances from role_start/role_finished with parent linkage and live status', () => {
		const session = sessionFor([
			roleStartEvent(0, 'orchestrator-0', 'orchestrator'),
			roleStartEvent(2, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
			roleFinishedEvent(9, 'coder-1', 'coder'),
		])
		const instances = session.view().instances
		expect(instances).toHaveLength(2)
		expect(defined(instances[0], 'instances[0]')).toEqual({ roleId: 'orchestrator-0', role: 'orchestrator', parentRoleId: null, parentRole: null, live: true })
		expect(defined(instances[1], 'instances[1]')).toEqual({ roleId: 'coder-1', role: 'coder', parentRoleId: 'orchestrator-0', parentRole: 'orchestrator', live: false })
	})

	test('a role_finished without a role_start adds a finished instance with no parent', () => {
		const instances = sessionFor([roleFinishedEvent(1, 'planner-0-1', 'planner')]).view().instances
		expect(instances).toEqual([{ roleId: 'planner-0-1', role: 'planner', parentRoleId: null, parentRole: null, live: false }])
	})

	test('turn events with a roleId add a startless instance; events without one do not', () => {
		expect(sessionFor([startEvent(0, 'coder', 'coder-1')]).view().instances).toEqual([{ roleId: 'coder-1', role: 'coder', parentRoleId: null, parentRole: null, live: true }])
		expect(sessionFor([callEvent(0, 'coder', { roleId: 'coder-1-9' })]).view().instances).toEqual([{ roleId: 'coder-1-9', role: 'coder', parentRoleId: null, parentRole: null, live: false }])
		expect(sessionFor([callEvent(0, 'coder', { roleId: undefined })]).view().instances).toEqual([])
	})

	test('walks a deep chain root-first through exact parent ids, ending at the root-most known start', () => {
		const events = [
			roleStartEvent(0, 'orchestrator-0', 'orchestrator', { depth: 0 }),
			roleStartEvent(2, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
			roleStartEvent(5, 'coder-1-2', 'coder', { depth: 2, parent: 'coder', parentRoleId: 'coder-1' }),
		]
		expect(sessionFor(events, { scopedRoleId: 'coder-1-2' }).view().chain).toEqual([
			{ roleId: 'orchestrator-0', role: 'orchestrator' },
			{ roleId: 'coder-1', role: 'coder' },
			{ roleId: 'coder-1-2', role: 'coder' },
		])
		expect(sessionFor([defined(events[2], 'events[2]')], { scopedRoleId: 'coder-1-2' }).view().chain).toEqual([{ roleId: 'coder-1-2', role: 'coder' }])
	})

	test('an instance with no role_start renders a lone crumb, and a malformed cycle ends the walk', () => {
		const events = [roleStartEvent(0, 'orchestrator-0', 'orchestrator'), callEvent(9, 'coder', { roleId: 'coder-1-9' })]
		expect(sessionFor(events, { scopedRoleId: 'coder-1-9' }).view().chain).toEqual([{ roleId: 'coder-1-9', role: 'coder' }])
		const cyclic = [
			roleStartEvent(0, 'a-0', 'a', { depth: 0, parentRoleId: 'b-0' }),
			roleStartEvent(1, 'b-0', 'b', { depth: 1, parentRoleId: 'a-0' }),
		]
		expect(sessionFor(cyclic, { scopedRoleId: 'a-0' }).view().chain).toEqual([{ roleId: 'b-0', role: 'b' }, { roleId: 'a-0', role: 'a' }])
	})

	test('childInstanceFor matches the first role_start after the turn by parent id', () => {
		const events = [
			roleStartEvent(0, 'orchestrator-0', 'orchestrator', { depth: 0 }),
			callEvent(1, 'orchestrator', { roleId: 'orchestrator-0' }),
			roleStartEvent(2, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
			callEvent(3, 'coder', { roleId: 'coder-1' }),
			roleStartEvent(4, 'coder-1-1', 'coder', { depth: 2, parent: 'coder', parentRoleId: 'coder-1' }),
		]
		const session = sessionFor(events, { scopedRoleId: 'orchestrator-0' })
		expect(session.view().childInstance(1)).toBe('coder-1')
		expect(session.view().childInstance(2)).toBeNull()
	})

	test('ambiguous child timing resolves by position, and malformed timing reads as no child', () => {
		const repeated = [
			roleStartEvent(2, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
			callEvent(5, 'orchestrator', { roleId: 'orchestrator-0' }),
			roleStartEvent(7, 'coder-2', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
		]
		expect(sessionFor(repeated, { scopedRoleId: 'orchestrator-0' }).view().childInstance(5)).toBe('coder-2')
		const parallel = [
			roleStartEvent(6, 'first-1', 'coder', { parentRoleId: 'parent-0' }),
			roleStartEvent(8, 'second-1', 'writer', { parentRoleId: 'parent-0' }),
		]
		expect(sessionFor(parallel, { scopedRoleId: 'parent-0' }).view().childInstance(5)).toBe('first-1')
		const malformed = sessionFor([
			{ index: 4, type: 'role_start', payload: { role: 'coder' } },
			roleStartEvent(5, 'coder-1', 'coder', { parentRoleId: 'parent-0' }),
		], { scopedRoleId: 'parent-0' })
		expect(malformed.view().childInstance(2.5)).toBeNull()
		expect(malformed.view().childInstance(4)).toBe('coder-1')
	})
})

describe('transcript stitching', () => {
	test('stitches each turn out of its own slice only, so no message repeats across turns', () => {
		const turns = transcriptOf(sessionFor(stitchEvents, { scopedRoleId: 'coder-1' }))
		expect(turns).toHaveLength(2)
		const first = defined(turns[0], 'turns[0]')
		const second = defined(turns[1], 'turns[1]')
		expect(first.messages).toHaveLength(0)
		expect(present(first.received, 'first.received').content).toBe('turn one reply')
		expect(second.messages).toHaveLength(0)
		expect(present(second.received, 'second.received').content).toBe('turn two reply')
		expect(JSON.stringify(turns).split('turn one reply').length - 1).toBe(1)
	})

	test('the first turn hoists its leading system/user messages as the opening, stopping at the first assistant/tool message', () => {
		const turns = transcriptOf(sessionFor(stitchEvents, { scopedRoleId: 'coder-1' }))
		const first = defined(turns[0], 'turns[0]')
		expect(first.opening.map((message) => message.role)).toEqual(['system', 'user'])
		expect(first.opening.map((message) => message.content)).toEqual(['system prompt text', 'the task text'])
		expect(defined(turns[1], 'turns[1]').opening).toHaveLength(0)
		const boundary = [callEvent(4, 'coder', {
			roleId: 'coder-1',
			messageCount: 3,
			sentFrom: 2,
			sent: [{ role: 'assistant', content: 'earlier reply', tool_calls: [wireToolCall('c9', 'read_file', '{}')] }, { role: 'tool', content: '{"path":"ok"}' }],
			received: { content: 'later reply', reasoning: '', toolCalls: [] },
		})]
		expect(defined(transcriptOf(sessionFor(boundary, { scopedRoleId: 'coder-1' }))[0], 'boundary').opening).toHaveLength(0)
	})

	test('a tool call outcome joins from the answering tool result in the following turn', () => {
		const turns = transcriptOf(sessionFor(stitchEvents, { scopedRoleId: 'coder-1' }))
		const call = defined(present(defined(turns[0], 'turns[0]').received, 'received').toolCalls[0], 'toolCalls[0]')
		expect(call.id).toBe('c1')
		expect(call.name).toBe('write_file')
		expect(call.argumentsText).toBe('{"path":"a.txt"}')
		const outcome = present(call.outcome, 'call.outcome')
		expect(outcome.kind).toBe('tool_error')
		expect(outcome.summary).toBe('no space')
	})

	test('a tool result whose call is not rendered renders standalone with its own parsed outcome', () => {
		const events = [callEvent(0, 'coder', {
			roleId: 'coder-1',
			sent: [{ role: 'tool', content: '{"path":"written"}' }],
			received: { content: 'done', reasoning: '', toolCalls: [] },
			finishReason: 'stop',
		})]
		const message = defined(defined(transcriptOf(sessionFor(events, { scopedRoleId: 'coder-1' }))[0], 'turn').messages[0], 'messages[0]')
		expect(message.role).toBe('tool')
		const outcome = present(message.outcome, 'message.outcome')
		expect(outcome.kind).toBe('success')
		expect(outcome.summary).toBe('{"path":"written"}')
	})

	test('an unanswered newest call carries no invented outcome', () => {
		const withTailCall = [...stitchEvents, callEvent(3, 'coder', {
			roleId: 'coder-1',
			messageCount: 5,
			sentFrom: 4,
			sent: [{ role: 'assistant', content: 'turn two reply', tool_calls: [wireToolCall('c2', 'read_file', '{}')] }],
			received: { content: 'final', reasoning: '', toolCalls: [wireToolCall('c2', 'read_file', '{}')] },
		})]
		const last = defined(transcriptOf(sessionFor(withTailCall, { scopedRoleId: 'coder-1' }))[2], 'last')
		expect(defined(present(last.received, 'last.received').toolCalls[0], 'toolCalls[0]').outcome).toBeNull()
	})

	test('a mid-conversation window renders the first turn from what is loaded: the echo is skipped and its tool result renders standalone', () => {
		const turns = transcriptOf(sessionFor([defined(stitchEvents[2], 'stitchEvents[2]')], { scopedRoleId: 'coder-1' }))
		expect(turns).toHaveLength(1)
		const first = defined(turns[0], 'turns[0]')
		expect(first.opening).toHaveLength(0)
		expect(first.messages).toHaveLength(1)
		expect(defined(first.messages[0], 'messages[0]').role).toBe('tool')
		expect(present(defined(first.messages[0], 'messages[0]').outcome, 'outcome').summary).toBe('no space')
		expect(present(first.received, 'received').content).toBe('turn two reply')
		expect(JSON.stringify(turns).split('turn one reply').length - 1).toBe(0)
	})

	test('turn headers carry instance-renumbered numbers, usage, and finish reasons', () => {
		const turns = transcriptOf(sessionFor(stitchEvents, { scopedRoleId: 'coder-1' }))
		expect(defined(turns[0], 'turns[0]').turnNumber).toBe(1)
		expect(defined(turns[0], 'turns[0]').finishReason).toBe('tool_calls')
		expect(defined(turns[1], 'turns[1]').turnNumber).toBe(2)
		expect(defined(turns[1], 'turns[1]').finishReason).toBe('stop')
	})
})

describe('log paging', () => {
	test('a start probes one event; a probe for a non-empty log asks for the most recent window', () => {
		const session = createInspectorSession()
		const probe = present(session.start('run-1'), 'probe')
		expect(probe.url).toBe('api/runs/run-1/log?offset=0&limit=1')
		const result = session.receive(probe, windowBody([], 1000, 0), null)
		expect(result.status).toBe('accepted')
		expect(present(result.followUp, 'followUp').url).toBe('api/runs/run-1/log?offset=800&limit=200')
	})

	test('an empty log probe lands ready with no transcript', () => {
		const session = createInspectorSession()
		const probe = present(session.start('run-1'), 'probe')
		expect(session.receive(probe, windowBody([], 0, 0), null).followUp).toBeNull()
		const view = session.view()
		expect(view.loadState).toBe('ready')
		expect(view.hasOlder).toBe(false)
		expect(view.transcript).toEqual([])
	})

	test('older pages splice exactly in front and page within the active window; a mismatched page clears the flag without splicing', () => {
		const events = [callEvent(2, 'coder', { roleId: 'coder-1' })]
		const session = sessionFor(events, { scopedRoleId: 'coder-1', total: 3, offset: 2 })
		expect(session.view().hasOlder).toBe(true)
		const older = present(session.olderRequest(), 'older')
		expect(older.url).toBe('api/runs/run-1/log?offset=0&limit=2&instance=coder-1')
		expect(session.view().olderLoading).toBe(true)
		const page = windowBody([callEvent(0, 'coder', { roleId: 'coder-1' }), callEvent(1, 'coder', { roleId: 'coder-1' })], 3, 0)
		expect(session.receive(older, page, null).status).toBe('accepted')
		expect(session.view().olderLoading).toBe(false)
		expect(session.view().transcript.map((turn) => turn.eventIndex)).toEqual([0, 1, 2])
		expect(session.view().hasOlder).toBe(false)
	})

	test('a stale older page does not splice and merely clears the loading flag', () => {
		const events = [callEvent(2, 'coder', { roleId: 'coder-1' })]
		const session = sessionFor(events, { scopedRoleId: 'coder-1', total: 3, offset: 2 })
		const older = present(session.olderRequest(), 'older')
		const stale = windowBody([callEvent(0, 'coder', { roleId: 'coder-1' })], 3, 0)
		expect(session.receive(older, stale, null).status).toBe('failed')
		expect(session.view().olderLoading).toBe(false)
		expect(session.view().transcript.map((turn) => turn.eventIndex)).toEqual([2])
	})

	test('a tail refresh appends a bridging page and a gapped page asks for a resync instead', () => {
		const events = [callEvent(95, 'coder', { roleId: 'coder-1' })]
		const session = sessionFor(events, { scopedRoleId: 'coder-1', total: 96, offset: 95 })
		const tail = present(session.tailRequest(), 'tail')
		expect(tail.url).toBe('api/runs/run-1/log?offset=96&limit=500&instance=coder-1')
		const appended = session.receive(tail, windowBody([callEvent(96, 'coder', { roleId: 'coder-1' })], 97, 96), null)
		expect(appended.status).toBe('accepted')
		expect(session.view().transcript.map((turn) => turn.eventIndex)).toEqual([95, 96])

		const gapped = session.receive(tail, windowBody([callEvent(200, 'coder', { roleId: 'coder-1' })], 300, 200), null)
		expect(gapped.status).toBe('ignored')
		expect(present(gapped.followUp, 'resync').url).toBe('api/runs/run-1/log?offset=100&limit=200&instance=coder-1')
	})

	test('a loaded range at the retention cap resyncs the tail window instead of appending', () => {
		const events = Array.from({ length: 4000 }, (_unused, index) => callEvent(index, 'coder', { roleId: 'coder-1' }))
		const session = sessionFor(events, { scopedRoleId: 'coder-1', total: 4000, offset: 0 })
		const tail = present(session.tailRequest(), 'tail')
		const result = session.receive(tail, windowBody([callEvent(4000, 'coder', { roleId: 'coder-1' })], 4001, 4000), null)
		expect(result.status).toBe('ignored')
		expect(present(result.followUp, 'resync').url).toBe('api/runs/run-1/log?offset=3801&limit=200&instance=coder-1')
	})

	test('an unscoped tail refresh appends a bridging page to the loaded tail', () => {
		const session = sessionFor([callEvent(95, 'coder', { roleId: 'coder-1' })], { total: 96, offset: 95 })
		const tail = present(session.tailRequest(), 'tail')
		expect(tail.scopeRoleId).toBeNull()
		expect(tail.url).toBe('api/runs/run-1/log?offset=96&limit=500')
		const appended = session.receive(tail, windowBody([callEvent(96, 'coder', { roleId: 'coder-1' })], 97, 96), null)
		expect(appended.status).toBe('accepted')
		expect(session.view().transcript.map((turn) => turn.eventIndex)).toEqual([95, 96])
	})

	test('endpoint sizes show up in requests: probe one, window 200, older 200, tail 500', () => {
		const session = createInspectorSession()
		const probe = present(session.start('run-1'), 'probe')
		expect(probe.kind).toBe('probe')
		expect(probe.url).toBe('api/runs/run-1/log?offset=0&limit=1')
		const windowRequest = present(session.receive(probe, windowBody([], 1000, 0), null).followUp, 'window')
		expect(windowRequest.kind).toBe('window')
		expect(windowRequest.url).toBe('api/runs/run-1/log?offset=800&limit=200')
		expect(session.receive(windowRequest, windowBody([], 1000, 800), null).status).toBe('accepted')
		const older = present(session.olderRequest(), 'older')
		expect(older.kind).toBe('older')
		expect(older.url).toBe('api/runs/run-1/log?offset=600&limit=200')
		const tail = present(session.tailRequest(), 'tail')
		expect(tail.kind).toBe('tail')
		expect(tail.url).toBe('api/runs/run-1/log?offset=1000&limit=500')
	})

	test('a request carries its response kind, and a forged kind is rejected', () => {
		const session = createInspectorSession()
		const probe = present(session.start('run-1'), 'probe')
		const forged = { ...probe, kind: 'window' as const }
		expect(session.receive(forged, windowBody([], 0, 0), null).status).toBe('ignored')
		session.fail(forged)
		expect(session.view().loadState).toBe('loading')
		expect(session.receive(probe, windowBody([], 0, 0), null).status).toBe('accepted')
		expect(session.view().loadState).toBe('ready')
	})

	test('a close and reopen invalidates responses from the older generation even for the same run', () => {
		const session = createInspectorSession()
		const first = present(session.start('run-1'), 'first probe')
		session.close()
		const second = present(session.start('run-1'), 'second probe')
		expect(session.receive(first, windowBody([], 0, 0), null).status).toBe('ignored')
		session.fail(first)
		expect(session.view().loadState).toBe('loading')
		expect(session.receive(second, windowBody([], 0, 0), null).status).toBe('accepted')
		expect(session.view().loadState).toBe('ready')
	})

	test('start rejects an empty run id instead of silently closing', () => {
		const session = createInspectorSession()
		expect(() => session.start('')).toThrow(/non-empty/)
	})

	test('a body for another run is ignored rather than landing in the current session', () => {
		const { session, request } = startedSession()
		expect(session.receive(request, windowBody([callEvent(0, 'coder')], 1, 0, 'run-2'), null).status).toBe('ignored')
		expect(session.view().loadState).toBe('loading')
	})

	test('a malformed first load marks the window failed; a network failure does the same', () => {
		const { session, request } = startedSession()
		expect(session.receive(request, 'broken', null).status).toBe('failed')
		expect(session.view().loadState).toBe('failed')
		const second = startedSession()
		second.session.fail(second.request)
		expect(second.session.view().loadState).toBe('failed')
	})
})

describe('scoping and per-scope windows', () => {
	const tailWindow = [
		roleStartEvent(90, 'coder-2', 'coder'),
		callEvent(91, 'coder', { roleId: 'coder-2' }),
		roleStartEvent(92, 'coder-1-2', 'coder', { depth: 2, parent: 'coder', parentRoleId: 'coder-1' }),
	]
	const coderGrandchildWindow = [
		roleStartEvent(0, 'orchestrator-0', 'orchestrator'),
		roleStartEvent(3, 'coder-1', 'coder', { depth: 1, parent: 'orchestrator', parentRoleId: 'orchestrator-0' }),
		roleStartEvent(6, 'coder-1-2', 'coder', { depth: 2, parent: 'coder', parentRoleId: 'coder-1' }),
		startEvent(7, 'coder', 'coder-1-2'),
		callEvent(8, 'coder', { roleId: 'coder-1-2' }),
		roleFinishedEvent(9, 'coder-1-2', 'coder'),
		roleFinishedEvent(11, 'coder-1', 'coder'),
		roleFinishedEvent(16, 'orchestrator-0', 'orchestrator'),
	]

	test('a first scope probes its filtered total; an existing or loading scope is reused; a failed one retries after leaving and returning', () => {
		const session = sessionFor(tailWindow)
		const fresh = session.scope('coder-1-2')
		expect(fresh.changed).toBe(true)
		expect(present(fresh.request, 'request').url).toBe('api/runs/run-1/log?offset=0&limit=1&instance=coder-1-2')
		expect(session.scope('coder-1-2').changed).toBe(false)
		session.fail(present(fresh.request, 'request'))
		session.scope(null)
		const retry = session.scope('coder-1-2')
		expect(retry.changed).toBe(true)
		expect(retry.request).not.toBeNull()
	})

	test('a scoped view merges the filtered window with the unscoped tail for wayfinding', () => {
		const session = sessionFor(tailWindow)
		const scoped = session.scope('coder-1-2')
		const request = present(scoped.request, 'request')
		landWindow(session, request, windowBody(coderGrandchildWindow, 8, 0))
		const view = session.view()
		expect(view.scopedRoleId).toBe('coder-1-2')
		expect(view.chain).toEqual([
			{ roleId: 'orchestrator-0', role: 'orchestrator' },
			{ roleId: 'coder-1', role: 'coder' },
			{ roleId: 'coder-1-2', role: 'coder' },
		])
		expect(view.instances.map((instance) => instance.roleId)).toEqual(['orchestrator-0', 'coder-1', 'coder-1-2', 'coder-2'])
		expect(view.transcript.map((turn) => turn.eventIndex)).toEqual([8])
	})

	test('overlapping indices in the scoped and unscoped windows dedupe to one event and keep the scoped copy', () => {
		const session = createInspectorSession()
		const probe = present(session.start('run-1'), 'probe')
		const unscopedEvents = [
			callEvent(5, 'coder', { roleId: 'coder-1', received: { content: 'unscoped copy', reasoning: '', toolCalls: [] } }),
			callEvent(7, 'planner', { roleId: 'planner-0' }),
		]
		landWindow(session, probe, windowBody(unscopedEvents, 8, 0))
		const scopedProbe = session.scope('coder-1')
		const scopedEvents = [
			roleStartEvent(0, 'coder-1', 'coder'),
			callEvent(5, 'coder', { roleId: 'coder-1', received: { content: 'scoped copy', reasoning: '', toolCalls: [] } }),
			callEvent(6, 'coder', { roleId: 'coder-1' }),
		]
		landWindow(session, present(scopedProbe.request, 'scope probe'), windowBody(scopedEvents, 3, 0))
		const view = session.view()
		expect(view.transcript.map((turn) => turn.eventIndex)).toEqual([5, 6])
		const first = defined(view.transcript[0], 'turn[0]')
		expect(present(first.received, 'received').content).toBe('scoped copy')
		expect(view.instances.filter((instance) => instance.roleId === 'coder-1')).toHaveLength(1)
	})

	test('the active scoped window carries its own older flag and offsets, so a re-scope mid-fetch starts clean', () => {
		const session = sessionFor(tailWindow, { total: 100, offset: 50 })
		const scoped = session.scope('coder-1-2')
		landWindow(session, present(scoped.request, 'request'), windowBody(coderGrandchildWindow, 400, 200))
		const older = present(session.olderRequest(), 'older')
		expect(older.url).toBe('api/runs/run-1/log?offset=0&limit=200&instance=coder-1-2')
		expect(session.view().olderLoading).toBe(true)
		session.scope(null)
		expect(session.view().olderLoading).toBe(false)
		const unscopedOlder = present(session.olderRequest(), 'unscoped older')
		expect(unscopedOlder.url).toBe('api/runs/run-1/log?offset=0&limit=50')
	})

	test('scope(null) returns to the auto scope', () => {
		const session = sessionFor([callEvent(1, 'planner', { roleId: 'planner-0-1' })])
		session.scope('planner-0-1')
		expect(session.view().scopedRoleId).toBe('planner-0-1')
		expect(session.scope(null).changed).toBe(true)
		expect(session.view().scopedRoleId).toBe('planner-0-1')
	})
})

describe('wire-detail cache', () => {
	test('a miss reads idle; a request marks loading; a ready body caches verbatim', () => {
		const session = sessionFor([])
		expect(session.view().wireDetail(3)).toEqual({ status: 'idle' })
		const request = present(session.wireRequest(3), 'wire request')
		expect(request.url).toBe('api/runs/run-1/log?detail=3')
		expect(session.view().wireDetail(3)).toEqual({ status: 'loading' })
		expect(session.wireRequest(3)).toBeNull()
		const sections = [{ label: 'sent', content: [{ role: 'user', content: 'the task' }] }, { label: 'finish reason', content: 'stop' }]
		session.receiveWire(request, true, { index: 3, detailSections: sections })
		expect(session.view().wireDetail(3)).toEqual({ status: 'ready', sections })
		expect(session.wireRequest(3)).toBeNull()
	})

	test('an explicit null detailSections caches as ready-null', () => {
		const session = sessionFor([])
		const request = present(session.wireRequest(3), 'wire request')
		session.receiveWire(request, true, { index: 3, detailSections: null })
		expect(session.view().wireDetail(3)).toEqual({ status: 'ready', sections: null })
	})

	test('a failed landing evicts so reopening retries', () => {
		const session = sessionFor([])
		const request = present(session.wireRequest(3), 'wire request')
		session.receiveWire(request, false, { detailSections: [] })
		expect(session.view().wireDetail(3)).toEqual({ status: 'idle' })
		expect(session.wireRequest(3)).not.toBeNull()
		const malformed = present(session.wireRequest(4), 'wire request')
		session.receiveWire(malformed, true, { detailSections: 'broken' })
		expect(session.view().wireDetail(4)).toEqual({ status: 'idle' })
	})

	test('a fetch that never produced a response evicts, and the cache evicts its oldest entry past the cap', () => {
		const session = sessionFor([], { wireDetailCacheLimit: 2 })
		const first = present(session.wireRequest(1), 'first')
		session.receiveWire(first, true, { detailSections: [] })
		const second = present(session.wireRequest(2), 'second')
		session.receiveWire(second, true, { detailSections: [] })
		expect(session.view().wireDetail(1).status).toBe('ready')
		expect(session.view().wireDetail(2).status).toBe('ready')
		const third = present(session.wireRequest(3), 'third')
		expect(session.view().wireDetail(1)).toEqual({ status: 'idle' })
		expect(session.view().wireDetail(3).status).toBe('loading')
		session.failWire(third)
		expect(session.view().wireDetail(3)).toEqual({ status: 'idle' })
	})

	test('the cache is keyed by run, and survives starting a new inspection session', () => {
		const session = sessionFor([])
		const request = present(session.wireRequest(3), 'wire request')
		session.receiveWire(request, true, { detailSections: [{ label: 'sent', content: [] }] })
		session.start('run-2')
		expect(session.view().wireDetail(3)).toEqual({ status: 'idle' })
		session.start('run-1')
		expect(session.view().wireDetail(3).status).toBe('ready')
	})

	test('the public default bounds the cache at 100 entries, evicting the oldest first', () => {
		const session = sessionFor([])
		for (let eventIndex = 0; eventIndex <= 100; eventIndex++) {
			const request = present(session.wireRequest(eventIndex), `wire request ${eventIndex}`)
			session.receiveWire(request, true, { detailSections: [] })
		}
		expect(session.view().wireDetail(0)).toEqual({ status: 'idle' })
		expect(session.view().wireDetail(1).status).toBe('ready')
		expect(session.view().wireDetail(100).status).toBe('ready')
	})

	test('a non-integer or sub-1 cache cap fails fast instead of bounding nothing', () => {
		expect(() => createInspectorSession({ wireDetailCacheLimit: 0 })).toThrow(/maxEntries/)
		expect(() => createInspectorSession({ wireDetailCacheLimit: 2.5 })).toThrow(/maxEntries/)
	})
})
