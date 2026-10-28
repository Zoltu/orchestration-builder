import { describe, expect, test } from 'bun:test'
import type { LogEvent, Message, RoleDefinition, ToolCall, ToolResult } from '../types.js'
import type { RunToolScope } from './index.js'
import { createInvocationJournal, type ToolInvocation } from '../invocation.js'
import { createRunParkTracker } from '../park-state.js'
import { createEmptyRoleState, createFixtureRunScope, createFixtureToolPlatform, defined, recordingHumanBackend } from '../test-fixtures.js'

const platform = createFixtureToolPlatform()

function roleWith(tools: string[]): RoleDefinition {
	return { systemPrompt: 'sys', tools }
}

function historyWith(assistantReasoning?: string): Message[] {
	return [
		{ role: 'system', content: 'you are the coder' },
		{ role: 'user', content: 'build the thing' },
		{ role: 'assistant', content: 'working on it', ...(assistantReasoning !== undefined ? { reasoning: assistantReasoning } : {}) },
		{ role: 'tool', content: '{"kind":"success"}', tool_call_id: 't1' },
	]
}

function continuationHistory(): Message[] {
	return [
		{ role: 'system', content: 'you are the coder' },
		{ role: 'user', content: 'prior task' },
		{ role: 'assistant', content: 'prior result' },
		{ role: 'user', content: 'build the thing again' },
		{ role: 'assistant', content: 'working on it', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
		{ role: 'tool', content: '{"kind":"success"}', tool_call_id: 't1' },
	]
}

function scopeWith(overrides: Partial<RunToolScope> = {}): RunToolScope {
	return createFixtureRunScope({
		manifestNames: new Set(['context_info', 'edit_context', 'ask_human', 'finish']),
		contextWindow: 32000,
		...overrides,
	})
}

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
	return { id: `call_${name}_1`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function invocationFor(call: ToolCall): ToolInvocation {
	return { toolCall: call, questionId: call.id, callId: `tool:${call.id}`, parentCallId: 'role:fixture-0-0' }
}

async function dispatch(scope: RunToolScope, tools: string[], name: string, args: Record<string, unknown>): Promise<ToolResult> {
	const call = makeCall(name, args)
	const outcome = await platform.dispatch(roleWith(tools), scope, call, invocationFor(call))
	if (outcome.kind === 'suspended') throw new Error('unexpected suspension in a non-spawning tool test')
	return outcome.result
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('context_info tool', () => {
	test('returns contextWindow, currentPromptTokens, and message snapshot', async () => {
		const roleState = createEmptyRoleState({ history: historyWith(), lastPromptTokens: 500 })
		const result = await dispatch(scopeWith({ roleState }), ['context_info', 'finish'], 'context_info', {})
		expect(result.kind).toBe('success')
		if (result.kind !== 'success' || !isRecord(result.data)) throw new Error('expected context_info data')
		expect(result.data['contextWindow']).toBe(32000)
		expect(typeof result.data['currentPromptTokens']).toBe('number')
		expect(result.data['lastReportedPromptTokens']).toBe(500)
		expect(result.data['budgetRemaining']).toBeGreaterThan(0)
		const messages = result.data['messages']
		expect(Array.isArray(messages)).toBe(true)
		if (Array.isArray(messages)) {
			const first = messages[0]
			const second = messages[1]
			expect(isRecord(first) && first['role'] === 'system' && first['index'] === 0).toBe(true)
			expect(isRecord(second) && second['role'] === 'user' && second['index'] === 1).toBe(true)
		}
	})
})

describe('edit_context tool', () => {
	test('drop operation removes history messages in the range', async () => {
		const roleState = createEmptyRoleState({ history: historyWith() })
		const result = await dispatch(scopeWith({ roleState }), ['edit_context', 'finish'], 'edit_context', { operations: [{ op: 'drop', range: [2, 4] }] })
		expect(result.kind).toBe('success')
		if (result.kind !== 'success' || !isRecord(result.data)) throw new Error('expected edit_context data')
		expect(result.data['messageCount']).toBe(2)
	})

	test('replace operation updates content at the given index', async () => {
		const roleState = createEmptyRoleState({ history: historyWith() })
		const result = await dispatch(scopeWith({ roleState }), ['edit_context', 'finish'], 'edit_context', { operations: [{ op: 'replace', index: 2, content: 'new assistant text' }] })
		expect(result.kind).toBe('success')
		expect(roleState.history[2]?.content).toBe('new assistant text')
	})

	test('strip_reasoning operation clears reasoning on a range', async () => {
		const roleState = createEmptyRoleState({ history: historyWith('thinking hard') })
		const result = await dispatch(scopeWith({ roleState }), ['edit_context', 'finish'], 'edit_context', { operations: [{ op: 'strip_reasoning', range: [2, 3] }] })
		expect(result.kind).toBe('success')
		expect(roleState.history[2]?.reasoning).toBeNull()
		expect(roleState.history[2]?.content).toBe('working on it')
	})

	test('rejects an unknown operation with invalid_arguments', async () => {
		const result = await dispatch(scopeWith(), ['edit_context', 'finish'], 'edit_context', { operations: [{ op: 'magic' }] })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('rejects a drop.range that is not an array', async () => {
		const result = await dispatch(scopeWith(), ['edit_context', 'finish'], 'edit_context', { operations: [{ op: 'drop', range: 'oops' }] })
		expect(result.kind).toBe('invalid_arguments')
	})

	test('a continuation-shaped history reported as prefix four protects indices 0-3 and rejects a mixed batch atomically', async () => {
		const roleState = createEmptyRoleState({ history: continuationHistory(), protectedPrefixLength: 4 })
		const edit = (operations: unknown[]) => dispatch(scopeWith({ roleState }), ['edit_context', 'finish'], 'edit_context', { operations })
		expect((await edit([{ op: 'drop', range: [0, 2] }])).kind).toBe('invalid_arguments')
		expect((await edit([{ op: 'drop', range: [3, 5] }])).kind).toBe('invalid_arguments')
		expect((await edit([{ op: 'replace', index: 1, content: 'x' }])).kind).toBe('invalid_arguments')
		expect((await edit([{ op: 'replace', index: 3, content: 'x' }])).kind).toBe('invalid_arguments')
		expect((await edit([{ op: 'strip_reasoning', range: [0, 4] }])).kind).toBe('invalid_arguments')
		expect((await edit([{ op: 'drop', range: [4, 6] }, { op: 'replace', index: 2, content: 'x' }])).kind).toBe('invalid_arguments')
		expect(roleState.history.length).toBe(6)
		expect(roleState.history[2]?.content).toBe('prior result')
	})

	test('an operation starting at index 4 succeeds on a continuation-shaped history', async () => {
		const roleState = createEmptyRoleState({ history: continuationHistory(), protectedPrefixLength: 4 })
		const result = await dispatch(scopeWith({ roleState }), ['edit_context', 'finish'], 'edit_context', { operations: [{ op: 'drop', range: [4, 6] }] })
		expect(result.kind).toBe('success')
		expect(roleState.history.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user'])
	})

	test('the same role shape without the explicit continuation prefix may be edited', async () => {
		const roleState = createEmptyRoleState({ history: continuationHistory() })
		const result = await dispatch(scopeWith({ roleState }), ['edit_context', 'finish'], 'edit_context', { operations: [{ op: 'drop', range: [2, 4] }] })
		expect(result.kind).toBe('success')
		expect(roleState.history.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool'])
	})

	test('tracks recentCompactionPromptTokens after each edit', async () => {
		const roleState = createEmptyRoleState({ history: historyWith() })
		const result = await dispatch(scopeWith({ roleState }), ['edit_context', 'finish'], 'edit_context', { operations: [{ op: 'drop', range: [2, 3] }] })
		expect(result.kind).toBe('success')
		expect(roleState.recentCompactionPromptTokens.length).toBe(1)
		if (result.kind !== 'success' || !isRecord(result.data)) throw new Error('expected edit_context data')
		expect(result.data['messageCount']).toBe(3)
	})
})

describe('ask_human tool', () => {
	test('returns the human backend answer wrapped as a tool result', async () => {
		const human = recordingHumanBackend()
		const result = await dispatch(scopeWith({ humanBackend: human }), ['ask_human', 'finish'], 'ask_human', { question: 'What language?' })
		expect(result).toEqual({ kind: 'success', data: { question: 'What language?', answer: 'use your best judgement' } })
		expect(human.questions).toEqual([{ question: 'What language?', context: undefined }])
	})

	test('passes context to the human backend when provided', async () => {
		const human = recordingHumanBackend()
		const result = await dispatch(scopeWith({ humanBackend: human }), ['ask_human', 'finish'], 'ask_human', { question: 'q', context: 'c' })
		expect(result.kind).toBe('success')
		expect(human.questions).toEqual([{ question: 'q', context: 'c' }])
	})

	test('rejects a missing question with invalid_arguments', async () => {
		const result = await dispatch(scopeWith(), ['ask_human', 'finish'], 'ask_human', {})
		expect(result.kind).toBe('invalid_arguments')
	})

	test('a queue-tracked pre-write ask records the parked call and logs the call id', async () => {
		const parkTracker = createRunParkTracker(undefined, true)
		const events: LogEvent[] = []
		const scope = scopeWith({ parkTracker, appendLog: (event) => events.push(event) })

		const result = await dispatch(scope, ['ask_human', 'finish'], 'ask_human', { question: 'Which database?' })

		expect(result).toEqual({ kind: 'success', data: { question: 'Which database?', parked: true } })
		expect(parkTracker.parkedQuestion).toBe('Which database?')
		expect(parkTracker.parkedAsk).toMatchObject({ roleId: 'fixture-0-0', toolCallId: 'call_ask_human_1', callId: 'tool:call_ask_human_1', questionId: 'call_ask_human_1', question: 'Which database?' })
		const askEvent = events.find((event) => event.type === 'ask_human')
		expect(askEvent).toBeDefined()
		if (askEvent === undefined) return
		if (!isRecord(askEvent.payload)) throw new Error('expected an ask_human payload object')
		expect(askEvent.payload['id']).toBe('call_ask_human_1')
		expect(askEvent.payload['parked']).toBe(true)
	})

	test('a post-write, untracked, or handler-frame ask never records a parked call', async () => {
		const cases = [
			{ label: 'post-write', parkTracker: createRunParkTracker(true, true), handlerOf: undefined },
			{ label: 'untracked', parkTracker: createRunParkTracker(), handlerOf: undefined },
			{ label: 'handler', parkTracker: createRunParkTracker(undefined, true), handlerOf: 'target-0-1' },
		]
		for (const testCase of cases) {
			const human = recordingHumanBackend()
			const scope = scopeWith({
				parkTracker: testCase.parkTracker,
				humanBackend: human,
				...(testCase.handlerOf !== undefined ? { handlerOf: testCase.handlerOf } : {}),
			})

			const result = await dispatch(scope, ['ask_human', 'finish'], 'ask_human', { question: 'Which database?' })

			expect(result).toEqual({ kind: 'success', data: { question: 'Which database?', answer: 'use your best judgement' } })
			expect(testCase.parkTracker.parkedQuestion).toBeUndefined()
			expect(testCase.parkTracker.parkedAsk).toBeUndefined()
			expect(human.questions.length).toBe(1)
		}
	})

	test('a parked ask with an empty model id records the allocated invocation identity', async () => {
		const parkTracker = createRunParkTracker(undefined, true)
		const events: LogEvent[] = []
		const scope = scopeWith({ parkTracker, appendLog: (event) => events.push(event) })
		const call: ToolCall = { id: '', type: 'function', function: { name: 'ask_human', arguments: JSON.stringify({ question: 'Which database?' }) } }
		const journal = createInvocationJournal((event) => events.push(event))
		const invocation = journal.allocateToolCall(call, 'fixture-0-0')
		expect(invocation.questionId).not.toBe('')

		const outcome = await platform.dispatch(roleWith(['ask_human', 'finish']), scope, call, invocation)
		if (outcome.kind === 'suspended') throw new Error('unexpected suspension')
		const result = outcome.result

		expect(result).toEqual({ kind: 'success', data: { question: 'Which database?', parked: true } })
		expect(parkTracker.parkedAsk).toMatchObject({ roleId: 'fixture-0-0', toolCallId: '', callId: invocation.callId, questionId: invocation.questionId, question: 'Which database?' })
		const askEvent = defined(events.find((event) => event.type === 'ask_human'), 'ask_human event')
		expect(askEvent.payload).toMatchObject({ id: invocation.questionId, callId: invocation.callId, parentCallId: 'role:fixture-0-0', parked: true })
	})
})

describe('finish tool', () => {
	test('rejects an empty summary with invalid_arguments naming summary', async () => {
		const result = await dispatch(scopeWith(), ['finish'], 'finish', { status: 'success', summary: '' })
		expect(result).toEqual({ kind: 'invalid_arguments', message: 'summary must be a non-empty string' })
	})

	test('rejects a whitespace-only summary with invalid_arguments naming summary', async () => {
		const result = await dispatch(scopeWith(), ['finish'], 'finish', { status: 'success', summary: '   ' })
		expect(result).toEqual({ kind: 'invalid_arguments', message: 'summary must be a non-empty string' })
	})

	test('a valid summary returns its result card', async () => {
		const result = await dispatch(scopeWith(), ['finish'], 'finish', { status: 'success', summary: 'all done' })
		expect(result).toEqual({ kind: 'success', data: { status: 'success', summary: 'all done' } })
	})
})
