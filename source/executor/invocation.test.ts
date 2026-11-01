import { describe, expect, test } from 'bun:test'
import {
	askHumanPayload,
	assistantContentForToolCallBatch,
	createInvocationJournal,
	humanAnswerPayload,
	interruptResolvedPayload,
	roleCallId,
	roleFinishedPayload,
	roleStartPayload,
	toolCallId,
	toolCallPayload,
	toolResultPayload,
	type ToolInvocation,
} from './invocation.ts'
import { defined } from './test-fixtures.ts'
import type { LogEvent, Message, ToolCall } from './types.ts'
import { isObject } from './validation.ts'

function toolCall(id: string, name: string = 'read_file'): ToolCall {
	return { id, type: 'function', function: { name, arguments: '{}' } }
}

function capturingJournal(): { journal: ReturnType<typeof createInvocationJournal>; events: LogEvent[] } {
	const events: LogEvent[] = []
	return { journal: createInvocationJournal((event) => events.push(event)), events }
}

function payloadOf(event: LogEvent): Record<string, unknown> {
	if (!isObject(event.payload)) throw new Error(`expected ${event.type} to carry an object payload`)
	return event.payload
}

describe('invocation id builders and payloads', () => {
	test('namespaces role, tool, and interrupt call ids', () => {
		expect(roleCallId('main-0-1')).toBe('role:main-0-1')
		expect(toolCallId('call-1')).toBe('tool:call-1')
	})

	test('a normal role_start is parented to the caller role and the entry role has no parent', () => {
		const child = roleStartPayload({ roleName: 'coder', roleId: 'coder-1-2', depth: 1, task: 'subtask', parent: 'main', parentRoleId: 'main-0-1' })
		expect(child).toEqual({ role: 'coder', roleId: 'coder-1-2', callId: 'role:coder-1-2', depth: 1, task: 'subtask', parent: 'main', parentRoleId: 'main-0-1', parentCallId: 'role:main-0-1' })
		const root = roleStartPayload({ roleName: 'main', roleId: 'main-0-1', depth: 0, task: 'do it' })
		expect(root).not.toHaveProperty('parentCallId')
	})

	test('an explicit parentCallId overrides the caller-role parent (an interrupt handler)', () => {
		const parentCallId = 'interrupt:abc'
		const payload = roleStartPayload({ roleName: 'loop_detector', roleId: 'loop_detector-1-2', depth: 1, task: 'check', parent: 'main', parentRoleId: 'main-0-1', parentCallId })
		expect(payload['parentCallId']).toBe(parentCallId)
	})

	test('role_finished carries the role call id and keeps the existing result fields', () => {
		expect(roleFinishedPayload({ roleName: 'main', roleId: 'main-0-1', depth: 0, card: { status: 'success', summary: 'done' }, pausesRun: false })).toEqual({
			role: 'main',
			roleId: 'main-0-1',
			callId: 'role:main-0-1',
			depth: 0,
			status: 'success',
			summary: 'done',
		})
	})

	test('tool start/terminal and ask/answer payloads carry consistent ids', () => {
		const invocation: ToolInvocation = { toolCall: toolCall('call-1'), questionId: 'call-1', callId: 'tool:call-1', parentCallId: 'role:main-0-1' }
		expect(toolCallPayload(invocation, 'main')).toEqual({ role: 'main', tool: 'read_file', arguments: '{}', callId: 'tool:call-1', parentCallId: 'role:main-0-1' })
		expect(toolResultPayload(invocation, 'main', { kind: 'success', data: 1 })).toEqual({ role: 'main', tool: 'read_file', kind: 'success', result: { kind: 'success', data: 1 }, callId: 'tool:call-1' })
		expect(askHumanPayload({ questionId: 'ask-1', callId: 'tool:ask-1', parentCallId: 'role:main-0-1', question: 'why?', parked: true })).toEqual({ id: 'ask-1', callId: 'tool:ask-1', parentCallId: 'role:main-0-1', question: 'why?', parked: true })
		expect(humanAnswerPayload('ask-1', 'tool:ask-1', 'because')).toEqual({ id: 'ask-1', callId: 'tool:ask-1', answer: 'because' })
		expect(interruptResolvedPayload('interrupt:abc', { action: 'continue' })).toEqual({ action: 'continue', callId: 'interrupt:abc' })
	})
})

describe('assistantContentForToolCallBatch', () => {
	test('returns the visible assistant content, never reasoning', () => {
		const call = toolCall('ask_1', 'ask_human')
		const history: Message[] = [
			{ role: 'system', content: 'prompt' },
			{ role: 'assistant', content: 'I should ask the operator.', reasoning: 'private chain of thought', tool_calls: [call] },
		]
		expect(assistantContentForToolCallBatch(history, [call])).toBe('I should ask the operator.')
	})

	test('matches the whole batch, not a single reused id', () => {
		const first = toolCall('reused', 'ask_human')
		const second: ToolCall = { id: 'reused', type: 'function', function: { name: 'ask_human', arguments: '{"question":"and the port?"}' } }
		const history: Message[] = [
			{ role: 'assistant', content: 'first turn', tool_calls: [first] },
			{ role: 'tool', content: '{}', tool_call_id: 'reused' },
			{ role: 'assistant', content: 'second turn', tool_calls: [second] },
		]
		expect(assistantContentForToolCallBatch(history, [second])).toBe('second turn')
		expect(assistantContentForToolCallBatch(history, [{ ...second, function: { name: 'ask_human', arguments: '{"question":"different"}' } }])).toBeUndefined()
	})

	test('requires the full ordered tool-call array, including duplicate ids', () => {
		const first = toolCall('dup', 'ask_human')
		const second: ToolCall = { id: 'dup', type: 'function', function: { name: 'ask_human', arguments: '{"question":"second"}' } }
		const history: Message[] = [
			{ role: 'assistant', content: 'batched ask', tool_calls: [first, second] },
		]
		expect(assistantContentForToolCallBatch(history, [first, second])).toBe('batched ask')
		expect(assistantContentForToolCallBatch(history, [second, first])).toBeUndefined()
		expect(assistantContentForToolCallBatch(history, [first])).toBeUndefined()
		expect(assistantContentForToolCallBatch(history, [first, second, toolCall('extra')])).toBeUndefined()
	})

	test('searches assistant messages rather than assuming the last history message', () => {
		const call = toolCall('ask_1', 'ask_human')
		const history: Message[] = [
			{ role: 'assistant', content: 'the turn that asked', tool_calls: [call] },
			{ role: 'tool', content: '{}', tool_call_id: 'ask_1' },
			{ role: 'assistant', content: 'a later turn with another call', tool_calls: [toolCall('other')] },
		]
		expect(assistantContentForToolCallBatch(history, [call])).toBe('the turn that asked')
	})

	test('returns undefined when no assistant message carries the batch', () => {
		expect(assistantContentForToolCallBatch([{ role: 'user', content: 'hello' }], [toolCall('ask_1')])).toBeUndefined()
	})
})

describe('createInvocationJournal', () => {
	test('allocates the model id when it is present and unique', () => {
		const { journal } = capturingJournal()
		const invocation = journal.allocateToolCall(toolCall('call-1'), 'main-0-1')
		expect(invocation.callId).toBe('tool:call-1')
		expect(invocation.parentCallId).toBe('role:main-0-1')
	})

	test('generates a unique id when the model id is empty or reused', () => {
		const { journal } = capturingJournal()
		const empty = journal.allocateToolCall(toolCall(''), 'main-0-1')
		const first = journal.allocateToolCall(toolCall('call-1'), 'main-0-1')
		const repeated = journal.allocateToolCall(toolCall('call-1'), 'main-0-1')
		expect(empty.callId).toMatch(/^tool:generated-/)
		expect(first.callId).toBe('tool:call-1')
		expect(repeated.callId).toMatch(/^tool:generated-/)
		expect(new Set([empty.callId, first.callId, repeated.callId]).size).toBe(3)
	})

	test('ignores a duplicate start and writes the first terminal once', () => {
		const { journal, events } = capturingJournal()
		const invocation = journal.allocateToolCall(toolCall('call-1'), 'main-0-1')
		expect(journal.toolStarted(invocation, 'main')).toBe(true)
		expect(journal.toolStarted(invocation, 'main')).toBe(false)
		expect(journal.toolFinished(invocation, 'main', { kind: 'success' })).toBe(true)
		expect(journal.toolFinished(invocation, 'main', { kind: 'success' })).toBe(false)
		expect(events.map((event) => event.type)).toEqual(['tool_call', 'tool_result'])
	})

	test('fails fast on a terminal for an unstarted invocation', () => {
		const { journal } = capturingJournal()
		const invocation = journal.allocateToolCall(toolCall('call-1'), 'main-0-1')
		expect(() => journal.toolFinished(invocation, 'main', { kind: 'success' })).toThrow('unstarted invocation')
	})

	test('role terminals are allowed for ids seeded from checkpoint frames and are written once', () => {
		const { journal, events } = capturingJournal()
		journal.seedStartedCallIds(['role:main-0-1'])
		expect(journal.roleFinished({ roleName: 'main', roleId: 'main-0-1', depth: 0, card: { status: 'success', summary: 'done' }, pausesRun: false })).toBe(true)
		expect(journal.roleFinished({ roleName: 'main', roleId: 'main-0-1', depth: 0, card: { status: 'success', summary: 'done' }, pausesRun: false })).toBe(false)
		expect(events.map((event) => event.type)).toEqual(['role_finished'])
	})

	test('seeds starts and terminals from an existing log so resume does not duplicate a terminal', () => {
		const { journal, events } = capturingJournal()
		const existing: LogEvent[] = [
			{ timestamp: 't1', type: 'tool_call', payload: { callId: 'tool:call-1', parentCallId: 'role:main-0-1' } },
			{ timestamp: 't2', type: 'tool_result', payload: { callId: 'tool:call-1', kind: 'success' } },
			{ timestamp: 't3', type: 'ask_human', payload: { id: 'ask-1', callId: 'tool:ask-1' } },
			{ timestamp: 't4', type: 'human_answer', payload: { id: 'ask-1', callId: 'tool:ask-1', answer: 'yes' } },
			{ timestamp: 't5', type: 'role_start', payload: { roleId: 'main-0-1', callId: 'role:main-0-1' } },
		]
		journal.seedEvents(existing)
		expect(journal.hasTerminal('tool:call-1')).toBe(true)
		expect(journal.hasTerminal('tool:ask-1')).toBe(true)
		// A model id already used before the restart is regenerated rather than colliding with the existing call id.
		expect(journal.allocateToolCall(toolCall('call-1'), 'main-0-1').callId).toMatch(/^tool:generated-/)
		const invocation = journal.adoptToolCall(toolCall('call-1'), 'tool:call-1', 'role:main-0-1')
		expect(journal.toolStarted(invocation, 'main')).toBe(false)
		expect(journal.toolFinished(invocation, 'main', { kind: 'success' })).toBe(false)
		expect(journal.roleFinished({ roleName: 'main', roleId: 'main-0-1', depth: 0, card: { status: 'success', summary: 'done' }, pausesRun: false })).toBe(true)
		expect(events.map((event) => event.type)).toEqual(['role_finished'])
	})

	test('a paused role_finished is logged but does not close the role invocation', () => {
		const { journal, events } = capturingJournal()
		journal.seedEvents([
			{ timestamp: 't1', type: 'role_start', payload: { role: 'main', roleId: 'main-0-1', callId: 'role:main-0-1', depth: 0 } },
			{ timestamp: 't2', type: 'role_finished', payload: { role: 'main', roleId: 'main-0-1', callId: 'role:main-0-1', depth: 0, status: 'needs_clarification', paused: true } },
		])
		expect(journal.hasTerminal('role:main-0-1')).toBe(false)
		expect(journal.roleFinished({ roleName: 'main', roleId: 'main-0-1', depth: 0, card: { status: 'success', summary: 'done' }, pausesRun: false })).toBe(true)
		expect(journal.hasTerminal('role:main-0-1')).toBe(true)
		expect(events.filter((event) => event.type === 'role_finished').length).toBe(1)
		expect(journal.roleFinished({ roleName: 'main', roleId: 'main-0-1', depth: 0, card: { status: 'success', summary: 'done' }, pausesRun: false })).toBe(false)
	})

	test('roleFinished marks terminal only when the card does not pause the run', () => {
		const { journal, events } = capturingJournal()
		journal.seedStartedCallIds(['role:main-0-1'])
		expect(journal.roleFinished({ roleName: 'main', roleId: 'main-0-1', depth: 0, card: { status: 'needs_clarification', summary: 'need input' }, pausesRun: true })).toBe(true)
		expect(journal.hasTerminal('role:main-0-1')).toBe(false)
		expect(events[0]?.payload).toMatchObject({ paused: true, status: 'needs_clarification' })
		expect(journal.roleFinished({ roleName: 'main', roleId: 'main-0-1', depth: 0, card: { status: 'success', summary: 'done' }, pausesRun: false })).toBe(true)
		expect(journal.hasTerminal('role:main-0-1')).toBe(true)
	})

	test('interrupt start and resolution share one id and resolve once', () => {
		const { journal, events } = capturingJournal()
		const interrupt = journal.interruptStarted('main-0-1', { trigger: 'inquiry', handler: 'responder', target: 'main-0-1' })
		expect(interrupt.parentCallId).toBe('role:main-0-1')
		expect(interrupt.callId).toMatch(/^interrupt:/)
		expect(journal.interruptFinished(interrupt.callId, { trigger: 'inquiry' })).toBe(true)
		expect(journal.interruptFinished(interrupt.callId, { trigger: 'inquiry' })).toBe(false)
		expect(events.map((event) => event.type)).toEqual(['interrupt', 'interrupt_resolved'])
		const start = payloadOf(defined(events[0], 'interrupt event'))
		const end = payloadOf(defined(events[1], 'interrupt_resolved event'))
		expect(start['callId']).toBe(interrupt.callId)
		expect(end['callId']).toBe(interrupt.callId)
	})
})
