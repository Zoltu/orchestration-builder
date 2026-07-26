import { describe, expect, test } from 'bun:test'
import { createBuiltInToolHandlers, type BuiltInToolContext } from './builtin-tools.ts'
import { createRoleRegistry, type RoleRegistry } from './role-registry.ts'
import type { RoleState } from './engine.ts'
import { stubHumanBackend } from './test-fixtures.ts'
import type { Message } from './types.js'

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

function makeContext(): { context: BuiltInToolContext; registry: RoleRegistry; target: RoleState } {
	const registry = createRoleRegistry()
	const target = fixtureRoleState()
	registry.register('coder', 1, undefined, target)
	const context: BuiltInToolContext = {
		spawnAgent: async () => ({ status: 'success', summary: '' }),
		roleState: fixtureRoleState(),
		humanBackend: stubHumanBackend,
		contextWindow: 1000,
		roleRegistry: registry,
	}
	return { context, registry, target }
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

	test('read_message_window returns a bounded slice and rejects bad arguments', async () => {
		const { context } = makeContext()
		const handlers = createBuiltInToolHandlers(context)
		const result = await handlers.read_message_window!({ targetRole: 'coder-1-1', index: 1, field: 'content', start: 0, end: 5 })
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			const data = result.data as { text: string; totalChars: number }
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
