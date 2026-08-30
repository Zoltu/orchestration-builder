import { describe, expect, test } from 'bun:test'
import { createBuiltInToolHandlers, type BuiltInToolContext } from './builtin-tools.ts'
import { createRoleRegistry, type RoleRegistry } from './role-registry.ts'
import type { RoleState } from './engine-state.ts'
import { stubHumanBackend } from './test-fixtures.ts'
import type { ToolHandler } from './tool-dispatch.ts'
import type { Message, ToolResult } from './types.js'
import { isObject } from './validation.ts'

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

function makeContext(): { context: BuiltInToolContext; registry: RoleRegistry; target: RoleState; callerState: RoleState } {
	const registry = createRoleRegistry()
	const target = fixtureRoleState()
	registry.register('coder', 1, undefined, target)
	const callerState = fixtureRoleState()
	registry.register('context_manager', 2, undefined, callerState)
	const context: BuiltInToolContext = {
		spawnAgent: async () => ({ status: 'success', summary: '' }),
		roleState: callerState,
		humanBackend: stubHumanBackend,
		contextWindow: 1000,
		roleRegistry: registry,
		ownRoleId: 'context_manager-2-2',
	}
	return { context, registry, target, callerState }
}

function handlerFor(handlers: Record<string, ToolHandler>, name: string): ToolHandler {
	const handler = handlers[name]
	if (handler === undefined) throw new Error(`missing built-in handler: ${name}`)
	return handler
}

describe('trigger_interrupt', () => {
	test('records a continue action on the target registry entry', async () => {
		const { context, registry } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlers.trigger_interrupt!({ targetRole: 'coder-1-1', action: 'continue', reason: '' })
		expect(result.kind).toBe('success')
		expect(registry.lookup('coder-1-1')?.interruptAction).toEqual({ action: 'continue', reason: '' })
	})

	test('redirect injects the reason as a user message into the target history and records the action', async () => {
		const { context, registry, target } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlers.trigger_interrupt!({ targetRole: 'coder-1-1', action: 'redirect', reason: 'stop; finish now' })
		expect(result.kind).toBe('success')
		expect(registry.lookup('coder-1-1')?.interruptAction).toEqual({ action: 'redirect', reason: 'stop; finish now' })
		const last = target.history[target.history.length - 1]
		expect(last).toEqual({ role: 'user', content: 'stop; finish now' })
	})

	test('abort records the action without touching the target history', async () => {
		const { context, registry, target } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const before = target.history.length
		const result = await handlers.trigger_interrupt!({ targetRole: 'coder-1-1', action: 'abort', reason: 'stuck' })
		expect(result.kind).toBe('success')
		expect(registry.lookup('coder-1-1')?.interruptAction).toEqual({ action: 'abort', reason: 'stuck' })
		expect(target.history.length).toBe(before)
	})

	test('rejects an unknown instance, a bad action, and a non-string reason', async () => {
		const { context, registry } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		expect((await handlers.trigger_interrupt!({ targetRole: 'nope-9-9', action: 'continue', reason: '' })).kind).toBe('invalid_arguments')
		expect((await handlers.trigger_interrupt!({ targetRole: 'coder-1-1', action: 'explode', reason: '' })).kind).toBe('invalid_arguments')
		expect((await handlers.trigger_interrupt!({ targetRole: 'coder-1-1', action: 'abort', reason: 42 })).kind).toBe('invalid_arguments')
		expect(registry.lookup('coder-1-1')?.interruptAction).toBeUndefined()
	})
})

describe('inspection tools', () => {
	test('list_role_messages returns the compact index of the target history', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlers.list_role_messages!({ targetRole: 'coder-1-1' })
		expect(result.kind).toBe('success')
		if (result.kind !== 'success') return
		const data = result.data as { messages: Array<{ index: number; role: string; contentChars: number; reasoningChars: number; toolCallCount: number }> }
		expect(data.messages.length).toBe(4)
		expect(data.messages[2]).toEqual({ index: 2, role: 'assistant', contentChars: 13, reasoningChars: 25, toolCallCount: 0 })
	})

	test('read_message_window returns a bounded slice with the target instance id and rejects bad arguments', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlers.read_message_window!({ targetRole: 'coder-1-1', index: 1, field: 'content', start: 0, end: 5 })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			const data = result.data as { targetRole: string; text: string; totalChars: number }
			expect(data.targetRole).toBe('coder-1-1')
			expect(data.text).toBe('build')
			expect(data.totalChars).toBe(15)
		}
		expect((await handlers.read_message_window!({ targetRole: 'coder-1-1', index: 99, field: 'content', start: 0, end: 5 })).kind).toBe('invalid_arguments')
		expect((await handlers.read_message_window!({ targetRole: 'coder-1-1', index: 1, field: 'secrets', start: 0, end: 5 })).kind).toBe('invalid_arguments')
		expect((await handlers.read_message_window!({ targetRole: 'coder-1-1', index: 1, field: 'content', start: -1, end: 5 })).kind).toBe('invalid_arguments')
		expect((await handlers.read_message_window!({ targetRole: 'coder-1-1', index: 1, field: 'content', start: 5, end: 5 })).kind).toBe('invalid_arguments')
	})

	test('search_role_blocks finds matches across content and reasoning and rejects a bad regex', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlers.search_role_blocks!({ targetRole: 'coder-1-1', pattern: 'same thought', kind: 'substring' })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			const data = result.data as { matches: Array<{ messageIndex: number; field: string }> }
			expect(data.matches.length).toBe(2)
			expect(data.matches[0]?.field).toBe('reasoning')
		}
		expect((await handlers.search_role_blocks!({ targetRole: 'coder-1-1', pattern: '([', kind: 'regex' })).kind).toBe('invalid_arguments')
		expect((await handlers.search_role_blocks!({ targetRole: 'coder-1-1', pattern: '', kind: 'substring' })).kind).toBe('invalid_arguments')
	})

	test('recent_role_tool_calls returns the bounded trace with the total count', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlers.recent_role_tool_calls!({ targetRole: 'coder-1-1', limit: 2 })
		expect(result.kind).toBe('success')
		if (result.kind !== 'success') return
		const data = result.data as { toolCalls: Array<{ tool: string; argsHash: string; resultKind: string }>; totalToolCalls: number }
		expect(data.totalToolCalls).toBe(3)
		expect(data.toolCalls).toEqual([
			{ tool: 'run_shell', argsHash: 'bbbbbbbb', resultKind: 'success' },
			{ tool: 'run_shell', argsHash: 'bbbbbbbb', resultKind: 'success' },
		])
	})

	test('inspection tools reject an unknown target instance', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		expect((await handlers.list_role_messages!({ targetRole: 'ghost-0-7' })).kind).toBe('invalid_arguments')
		expect((await handlers.read_message_window!({ targetRole: 'ghost-0-7', index: 0, field: 'content', start: 0, end: 1 })).kind).toBe('invalid_arguments')
		expect((await handlers.search_role_blocks!({ targetRole: 'ghost-0-7', pattern: 'x' })).kind).toBe('invalid_arguments')
		expect((await handlers.recent_role_tool_calls!({ targetRole: 'ghost-0-7' })).kind).toBe('invalid_arguments')
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
