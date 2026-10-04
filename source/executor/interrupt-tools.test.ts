import { describe, expect, test } from 'bun:test'
import { createBuiltInToolHandlers, type BuiltInToolContext } from './builtin-tools.ts'
import { createRoleRegistry, type RoleRegistry } from './role-registry.ts'
import type { RoleState } from './engine-state.ts'
import { createRunParkTracker } from './park-state.ts'
import type { LoadedGuild } from './loader.ts'
import { stubHumanBackend, toolData } from './test-fixtures.ts'
import type { ToolHandler } from './tool-dispatch.ts'
import type { LogEvent, Message, ToolResult } from './types.js'
import { isObject } from './validation.ts'

function makeFakeAppendLog(): { appendLog: (event: LogEvent) => void } {
	return { appendLog: () => undefined }
}

function fixtureHistory(): Message[] {
	return [
		{ role: 'system', content: 'you are the coder' },
		{ role: 'user', content: 'build the thing' },
		{ role: 'assistant', content: 'working on it', reasoning: 'same thought same thought' },
		{ role: 'tool', content: '{"kind":"success"}', tool_call_id: 't1' },
	]
}

function fixtureRoleState(): RoleState {
	return {
		history: fixtureHistory(),
		lastPromptTokens: 0,
		recentCompactionPromptTokens: [],
		recentToolCalls: [
			{ tool: 'read_file', argsHash: 'aaaaaaaa', resultKind: 'success' },
			{ tool: 'run_shell', argsHash: 'bbbbbbbb', resultKind: 'success' },
			{ tool: 'run_shell', argsHash: 'bbbbbbbb', resultKind: 'success' },
		],
		toolCallCount: 3,
		generatedTokens: 100,
		contextExceededAttempts: 0,
		loopCheckToolCallWatermark: 0,
		loopCheckTokenWatermark: 0,
	}
}

// The handlers under test never invoke context_info, so the guild is a shape-only stub; the window value matches the one the previous extracted-field fixture carried.
const stubGuild: LoadedGuild = {
	config: { entryRole: 'main', roles: {}, tools: [] },
	deployment: {
		model: { name: 'm', apiBase: 'http://x', contextWindow: 1000, generation: {} },
		executor: { maxAgentDepth: 8, defaultToolTimeoutSeconds: 30, maxCompactionAttempts: 5 },
		contextPolicy: { maxToolOutputChars: 4000 },
	},
	prompts: {},
	tools: {},
}

function makeContext(): { context: BuiltInToolContext; registry: RoleRegistry; target: RoleState; callerState: RoleState } {
	const registry = createRoleRegistry()
	const target = fixtureRoleState()
	registry.register('coder', 1, undefined, target)
	const callerState = fixtureRoleState()
	registry.register('context_manager', 2, undefined, callerState)
	const { appendLog } = makeFakeAppendLog()
	const context: BuiltInToolContext = {
		spawnAgent: async () => ({ status: 'success', summary: '' }),
		roleState: callerState,
		humanBackend: stubHumanBackend,
		loadedGuild: stubGuild,
		roleRegistry: registry,
		ownRoleId: 'context_manager-2-2',
		appendLog,
		parkTracker: createRunParkTracker(),
		// The caller stands in for a loop-check handler serving the coder instance: trigger_interrupt must accept that instance and no other.
		handlerOf: 'coder-1-1',
	}
	return { context, registry, target, callerState }
}

function handlerFor(handlers: Record<string, ToolHandler>, name: string): ToolHandler {
	const handler = handlers[name]
	if (handler === undefined) throw new Error(`missing built-in handler: ${name}`)
	return handler
}

function isMessageIndexData(value: unknown): value is { messages: unknown[] } {
	return isObject(value) && Array.isArray(value['messages'])
}

function isMessageWindowData(value: unknown): value is { targetRole: string; text: string; totalChars: number } {
	return isObject(value) && typeof value['targetRole'] === 'string' && typeof value['text'] === 'string' && typeof value['totalChars'] === 'number'
}

function isSearchMatchData(value: unknown): value is { matches: Array<{ field: string }> } {
	if (!isObject(value) || !Array.isArray(value['matches'])) return false
	return value['matches'].every((match) => isObject(match) && typeof match['field'] === 'string')
}

function isToolCallTraceData(value: unknown): value is { toolCalls: unknown[]; totalToolCalls: number } {
	return isObject(value) && Array.isArray(value['toolCalls']) && typeof value['totalToolCalls'] === 'number'
}

describe('trigger_interrupt', () => {
	test('records a continue action on the target registry entry', async () => {
		const { context, registry } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlerFor(handlers, 'trigger_interrupt')({ targetRole: 'coder-1-1', action: 'continue', reason: '' })
		expect(result.kind).toBe('success')
		expect(registry.lookup('coder-1-1')?.interruptAction).toEqual({ action: 'continue', reason: '' })
	})

	test('redirect injects the reason as a user message into the target history and records the action', async () => {
		const { context, registry, target } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlerFor(handlers, 'trigger_interrupt')({ targetRole: 'coder-1-1', action: 'redirect', reason: 'stop; finish now' })
		expect(result.kind).toBe('success')
		expect(registry.lookup('coder-1-1')?.interruptAction).toEqual({ action: 'redirect', reason: 'stop; finish now' })
		const last = target.history[target.history.length - 1]
		expect(last).toEqual({ role: 'user', content: 'stop; finish now' })
	})

	test('abort records the action without touching the target history', async () => {
		const { context, registry, target } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const before = target.history.length
		const result = await handlerFor(handlers, 'trigger_interrupt')({ targetRole: 'coder-1-1', action: 'abort', reason: 'stuck' })
		expect(result.kind).toBe('success')
		expect(registry.lookup('coder-1-1')?.interruptAction).toEqual({ action: 'abort', reason: 'stuck' })
		expect(target.history.length).toBe(before)
	})

	test('rejects an unknown instance, a bad action, and a non-string reason', async () => {
		const { context, registry } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		expect((await handlerFor(handlers, 'trigger_interrupt')({ targetRole: 'nope-9-9', action: 'continue', reason: '' })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'trigger_interrupt')({ targetRole: 'coder-1-1', action: 'explode', reason: '' })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'trigger_interrupt')({ targetRole: 'coder-1-1', action: 'abort', reason: 42 })).kind).toBe('invalid_arguments')
		expect(registry.lookup('coder-1-1')?.interruptAction).toBeUndefined()
	})

	test('rejects a live instance other than the flagged one and leaves the registry unchanged', async () => {
		const { context, registry, target } = makeContext()
		const other = fixtureRoleState()
		registry.register('coder', 1, undefined, other)
		const handlers = createBuiltInToolHandlers(context)
		expect((await handlerFor(handlers, 'trigger_interrupt')({ targetRole: 'context_manager-2-2', action: 'abort', reason: 'stuck' })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'trigger_interrupt')({ targetRole: 'coder-1-2', action: 'redirect', reason: 'stop' })).kind).toBe('invalid_arguments')
		expect(registry.lookup('coder-1-1')?.interruptAction).toBeUndefined()
		expect(registry.lookup('coder-1-2')?.interruptAction).toBeUndefined()
		expect(registry.lookup('context_manager-2-2')?.interruptAction).toBeUndefined()
		expect(target.history.length).toBe(4)
		expect(other.history.length).toBe(4)
	})

	test('rejects every target when the invocation flags no instance', async () => {
		const { context, registry } = makeContext()
		const handlers = createBuiltInToolHandlers({ ...context, handlerOf: undefined })
		const result = await handlerFor(handlers, 'trigger_interrupt')({ targetRole: 'coder-1-1', action: 'abort', reason: 'stuck' })
		expect(result.kind).toBe('invalid_arguments')
		expect(registry.lookup('coder-1-1')?.interruptAction).toBeUndefined()
	})
})

describe('inspection tools', () => {
	test('list_role_messages returns the compact index of the target history', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlerFor(handlers, 'list_role_messages')({ targetRole: 'coder-1-1' })
		expect(result.kind).toBe('success')
		const data = toolData(result, isMessageIndexData)
		expect(data.messages.length).toBe(4)
		expect(data.messages[2]).toEqual({ index: 2, role: 'assistant', contentChars: 13, reasoningChars: 25, toolCallCount: 0 })
	})

	test('read_message_window returns a bounded slice with the target instance id and rejects bad arguments', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlerFor(handlers, 'read_message_window')({ targetRole: 'coder-1-1', index: 1, field: 'content', start: 0, end: 5 })
		expect(result.kind).toBe('success')
		const data = toolData(result, isMessageWindowData)
		expect(data.targetRole).toBe('coder-1-1')
		expect(data.text).toBe('build')
		expect(data.totalChars).toBe(15)
		expect((await handlerFor(handlers, 'read_message_window')({ targetRole: 'coder-1-1', index: 99, field: 'content', start: 0, end: 5 })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'read_message_window')({ targetRole: 'coder-1-1', index: 1, field: 'secrets', start: 0, end: 5 })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'read_message_window')({ targetRole: 'coder-1-1', index: 1, field: 'content', start: -1, end: 5 })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'read_message_window')({ targetRole: 'coder-1-1', index: 1, field: 'content', start: 5, end: 5 })).kind).toBe('invalid_arguments')
	})

	test('search_role_blocks finds matches across content and reasoning and rejects a bad regex', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlerFor(handlers, 'search_role_blocks')({ targetRole: 'coder-1-1', pattern: 'same thought', kind: 'substring' })
		expect(result.kind).toBe('success')
		const data = toolData(result, isSearchMatchData)
		expect(data.matches.length).toBe(2)
		expect(data.matches[0]?.field).toBe('reasoning')
		expect((await handlerFor(handlers, 'search_role_blocks')({ targetRole: 'coder-1-1', pattern: '([', kind: 'regex' })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'search_role_blocks')({ targetRole: 'coder-1-1', pattern: '', kind: 'substring' })).kind).toBe('invalid_arguments')
	})

	test('recent_role_tool_calls returns the bounded trace with the total count', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlerFor(handlers, 'recent_role_tool_calls')({ targetRole: 'coder-1-1', limit: 2 })
		expect(result.kind).toBe('success')
		const data = toolData(result, isToolCallTraceData)
		expect(data.totalToolCalls).toBe(3)
		expect(data.toolCalls).toEqual([
			{ tool: 'run_shell', argsHash: 'bbbbbbbb', resultKind: 'success' },
			{ tool: 'run_shell', argsHash: 'bbbbbbbb', resultKind: 'success' },
		])
	})

	test('inspection tools reject an unknown target instance', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		expect((await handlerFor(handlers, 'list_role_messages')({ targetRole: 'ghost-0-7' })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'read_message_window')({ targetRole: 'ghost-0-7', index: 0, field: 'content', start: 0, end: 1 })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'search_role_blocks')({ targetRole: 'ghost-0-7', pattern: 'x' })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'recent_role_tool_calls')({ targetRole: 'ghost-0-7' })).kind).toBe('invalid_arguments')
	})
})

function dataRecord(result: ToolResult): Record<string, unknown> {
	if (result.kind !== 'success') throw new Error(`expected a success result, got ${result.kind}`)
	if (!isObject(result.data)) throw new Error('expected the result data to be an object')
	return result.data
}

describe('cross-role context tools', () => {
	test('edit_context with targetRole applies the operations to the target history and accounts the guard on the caller', async () => {
		const { context, target, callerState } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlerFor(handlers, 'edit_context')({ targetRole: 'coder-1-1', operations: [{ op: 'drop', range: [2, 4] }] })
		const data = dataRecord(result)
		expect(data['targetRole']).toBe('coder-1-1')
		expect(data['messageCount']).toBe(2)
		expect(target.history.length).toBe(2)
		expect(target.history[0]?.role).toBe('system')
		expect(target.history[1]?.role).toBe('user')
		// The edited size lands on the caller's compaction-guard list, not the target's.
		expect(callerState.recentCompactionPromptTokens.length).toBe(1)
		expect(target.recentCompactionPromptTokens.length).toBe(0)
	})

	test('context_info with targetRole returns the target conversation; without it returns the caller\u2019s own', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const cross = dataRecord(await handlerFor(handlers, 'context_info')({ targetRole: 'coder-1-1' }))
		expect(cross['targetRole']).toBe('coder-1-1')
		const crossMessages = cross['messages']
		expect(Array.isArray(crossMessages) && crossMessages.length === 4).toBe(true)
		const self = dataRecord(await handlerFor(handlers, 'context_info')({}))
		expect('targetRole' in self).toBe(false)
	})

	test('edit_context and context_info reject an unknown target instance and a self target', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		expect((await handlerFor(handlers, 'edit_context')({ targetRole: 'ghost-0-7', operations: [] })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'context_info')({ targetRole: 'ghost-0-7' })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'edit_context')({ targetRole: 'context_manager-2-2', operations: [] })).kind).toBe('invalid_arguments')
		expect((await handlerFor(handlers, 'context_info')({ targetRole: 'context_manager-2-2' })).kind).toBe('invalid_arguments')
	})

	test('every edit operation invalidates the target llm_call delta baseline so its next emission is a full snapshot', async () => {
		for (const operations of [
			[{ op: 'drop', range: [2, 4] }],
			[{ op: 'strip_reasoning', range: [2, 3] }],
			[{ op: 'replace', index: 2, content: 'rewritten' }],
		]) {
			const { context, target } = makeContext()
			target.logSentBaseline = 4
			const result = await handlerFor(createBuiltInToolHandlers(context), 'edit_context')({ targetRole: 'coder-1-1', operations })
			expect(result.kind).toBe('success')
			expect(target.logSentBaseline).toBeUndefined()
		}
	})

	test('a self edit invalidates the caller\u2019s own llm_call delta baseline', async () => {
		const { context, callerState } = makeContext()
		callerState.logSentBaseline = 4
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlerFor(handlers, 'edit_context')({ operations: [{ op: 'replace', index: 2, content: 'rewritten' }] })
		expect(result.kind).toBe('success')
		expect(callerState.logSentBaseline).toBeUndefined()
	})

	test('a rejected edit batch leaves the target history and llm_call delta baseline intact', async () => {
		const { context, target } = makeContext()
		target.logSentBaseline = 4
		const handlers = createBuiltInToolHandlers(context)
		// A batch that fails partway (the replace index is out of range) is rejected without applying anything: the history keeps all four messages and the baseline still reads 4, so the target's next emission remains a delta off its last logged request.
		const result = await handlerFor(handlers, 'edit_context')({ targetRole: 'coder-1-1', operations: [{ op: 'drop', range: [2, 4] }, { op: 'replace', index: 99, content: 'nope' }] })
		expect(result.kind).toBe('invalid_arguments')
		expect(target.history.length).toBe(4)
		expect(target.logSentBaseline).toBe(4)
	})

	test('edit operations must not touch message indices 0 and 1, and a mixed batch rejects atomically', async () => {
		const { context, target, callerState } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const edit = handlerFor(handlers, 'edit_context')
		expect((await edit({ targetRole: 'coder-1-1', operations: [{ op: 'drop', range: [0, 2] }] })).kind).toBe('invalid_arguments')
		expect((await edit({ targetRole: 'coder-1-1', operations: [{ op: 'drop', range: [1, 3] }] })).kind).toBe('invalid_arguments')
		expect((await edit({ targetRole: 'coder-1-1', operations: [{ op: 'replace', index: 0, content: 'x' }] })).kind).toBe('invalid_arguments')
		expect((await edit({ targetRole: 'coder-1-1', operations: [{ op: 'replace', index: 1, content: 'x' }] })).kind).toBe('invalid_arguments')
		expect((await edit({ targetRole: 'coder-1-1', operations: [{ op: 'strip_reasoning', range: [0, 3] }] })).kind).toBe('invalid_arguments')
		// The self path is protected the same way.
		expect((await edit({ operations: [{ op: 'drop', range: [0, 2] }] })).kind).toBe('invalid_arguments')
		// A batch that mixes a valid operation with a protected one rejects entirely: nothing is applied on either history.
		expect((await edit({ targetRole: 'coder-1-1', operations: [{ op: 'drop', range: [2, 3] }, { op: 'replace', index: 1, content: 'x' }] })).kind).toBe('invalid_arguments')
		expect(target.history.length).toBe(4)
		expect(callerState.history.length).toBe(4)
	})

	test('edit_context without targetRole edits the caller\u2019s own conversation and carries no targetRole field', async () => {
		const { context, callerState } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlerFor(handlers, 'edit_context')({ operations: [{ op: 'drop', range: [2, 4] }] })
		const data = dataRecord(result)
		expect('targetRole' in data).toBe(false)
		expect(data['messageCount']).toBe(2)
		expect(callerState.history.length).toBe(2)
	})
})
