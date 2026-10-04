import { describe, expect, test } from 'bun:test'

import { applyLogLevel, DEFAULT_LOG_LEVEL, isLogLevel } from './log-level.ts'
import { isObject } from './validation.ts'
import type { LogEvent } from './types.ts'

function event(type: string, payload: unknown): LogEvent {
	return { timestamp: '2026-01-01T00:00:00.000Z', type, payload }
}

const fullLlmCallPayload = {
	role: 'planner',
	roleId: 'planner-0-1',
	messageCount: 3,
	sent: [{ role: 'system', content: 'prompt text' }, { role: 'user', content: 'task text' }],
	received: { content: 'working on it', toolCalls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"x"}' } }] },
	usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 40 },
	finishReason: 'tool_calls',
}

const fullToolResultPayload = {
	role: 'coder',
	tool: 'write_file',
	kind: 'success',
	result: { kind: 'success', data: { path: 'x', bytes: 4 } },
}

describe('isLogLevel', () => {
	test('accepts the two wire strings and rejects everything else', () => {
		expect(isLogLevel('full')).toBe(true)
		expect(isLogLevel('standard')).toBe(true)
		expect(isLogLevel('Full')).toBe(false)
		expect(isLogLevel('')).toBe(false)
		expect(isLogLevel('quick')).toBe(false)
		expect(isLogLevel(3)).toBe(false)
		expect(isLogLevel(null)).toBe(false)
		expect(isLogLevel(undefined)).toBe(false)
	})

	test('defaults to full', () => {
		expect(DEFAULT_LOG_LEVEL).toBe('full')
	})
})

describe('applyLogLevel under full', () => {
	test('returns the same event reference for the affected event types', () => {
		const llmCall = event('llm_call', fullLlmCallPayload)
		const toolResult = event('tool_result', fullToolResultPayload)
		expect(applyLogLevel(llmCall, 'full')).toBe(llmCall)
		expect(applyLogLevel(toolResult, 'full')).toBe(toolResult)
	})

	test('returns the same event reference for every other event type', () => {
		const roleStart = event('role_start', { role: 'planner', roleId: 'planner-0-1', depth: 0, task: 't' })
		const effortSet = event('effort_set', { effort: 'thorough' })
		expect(applyLogLevel(roleStart, 'full')).toBe(roleStart)
		expect(applyLogLevel(effortSet, 'full')).toBe(effortSet)
	})
})

describe('applyLogLevel under standard: llm_call slimming', () => {
	test('drops the sent and received bodies and keeps role, roleId, messageCount, usage, and finishReason', () => {
		const slimmed = applyLogLevel(event('llm_call', fullLlmCallPayload), 'standard')
		expect(slimmed).toEqual({
			timestamp: '2026-01-01T00:00:00.000Z',
			type: 'llm_call',
			payload: {
				role: 'planner',
				roleId: 'planner-0-1',
				messageCount: 3,
				usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 40 },
				finishReason: 'tool_calls',
			},
		})
	})

	test('the roleId identity field survives standard filtering, matching llm_call_start and role_start which always carry it', () => {
		const slimmed = applyLogLevel(event('llm_call', { role: 'coder', roleId: 'coder-1-2', messageCount: 2, sent: [{ role: 'user', content: 'x' }], received: { content: 'y' } }), 'standard')
		expect(slimmed.payload).toEqual({ role: 'coder', roleId: 'coder-1-2', messageCount: 2 })
	})

	test('keeps absent optional fields absent (no finishReason key appears)', () => {
		const payload = { role: 'planner', messageCount: 1, sent: [{ role: 'user', content: 'x' }], received: { content: 'y' }, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
		const slimmed = applyLogLevel(event('llm_call', payload), 'standard')
		expect(slimmed.payload).toEqual({ role: 'planner', messageCount: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
	})

	test('passes the minimal role/messageCount shape through intact', () => {
		const slimmed = applyLogLevel(event('llm_call', { role: 'planner', messageCount: 2 }), 'standard')
		expect(slimmed.payload).toEqual({ role: 'planner', messageCount: 2 })
	})

	test('keeps the usage object the flow view and budget derivations read', () => {
		const slimmed = applyLogLevel(event('llm_call', fullLlmCallPayload), 'standard')
		expect(isObject(slimmed.payload)).toBe(true)
		if (!isObject(slimmed.payload)) throw new Error('expected a record payload')
		expect(slimmed.payload['usage']).toEqual(fullLlmCallPayload.usage)
	})
})

describe('applyLogLevel under standard: tool_result slimming', () => {
	test('drops the full result body and keeps role, tool, and kind', () => {
		const slimmed = applyLogLevel(event('tool_result', fullToolResultPayload), 'standard')
		expect(slimmed).toEqual({
			timestamp: '2026-01-01T00:00:00.000Z',
			type: 'tool_result',
			payload: { role: 'coder', tool: 'write_file', kind: 'success' },
		})
	})

	test('keeps error results identified while dropping their bodies', () => {
		const payload = { role: 'coder', tool: 'run_shell', kind: 'timeout', result: { kind: 'timeout', message: '30s elapsed' } }
		const slimmed = applyLogLevel(event('tool_result', payload), 'standard')
		expect(slimmed.payload).toEqual({ role: 'coder', tool: 'run_shell', kind: 'timeout' })
	})
})

describe('applyLogLevel under standard: pass-through', () => {
	test('every unaffected event type is returned with its payload untouched', () => {
		const unaffected: LogEvent[] = [
			event('role_start', { role: 'planner', roleId: 'planner-0-1', depth: 0, task: 't' }),
			event('role_finished', { role: 'planner', roleId: 'planner-0-1', depth: 0, status: 'success', summary: 'done' }),
			event('tool_call', { role: 'coder', tool: 'read_file', arguments: '{"path":"x"}' }),
			event('effort_set', { effort: 'quick' }),
			event('run_resumed', { runId: 'run-20260101-000000', resumedFrames: 2 }),
			event('interrupt', { trigger: 'inquiry', handler: 'inquiry_responder', target: 'coder-1-2', message: 'status?' }),
			event('llm_call_start', { role: 'coder' }),
			event('agent_call', { parent: 'planner', child: 'coder', depth: 1 }),
		]
		for (const original of unaffected) {
			expect(applyLogLevel(original, 'standard')).toBe(original)
		}
	})

	test('a slimmed-type event with a non-record payload passes through untouched', () => {
		const broken = event('llm_call', 'not-a-record')
		expect(applyLogLevel(broken, 'standard')).toBe(broken)
		const alsoBroken = event('tool_result', null)
		expect(applyLogLevel(alsoBroken, 'standard')).toBe(alsoBroken)
	})
})

describe('applyLogLevel never mutates its input', () => {
	test('the input event keeps its full payload after a standard slimming', () => {
		const original = event('llm_call', fullLlmCallPayload)
		const frozen: LogEvent = JSON.parse(JSON.stringify(original))
		Object.freeze(frozen.payload)
		Object.freeze(frozen)

		const slimmed = applyLogLevel(frozen, 'standard')

		expect(frozen.payload).toEqual(fullLlmCallPayload)
		expect(slimmed).not.toBe(frozen)
		expect(slimmed.payload).not.toEqual(fullLlmCallPayload)
	})

	test('the input event keeps its full payload after a tool_result slimming', () => {
		const frozen: LogEvent = JSON.parse(JSON.stringify(event('tool_result', fullToolResultPayload)))
		Object.freeze(frozen.payload)
		Object.freeze(frozen)

		const slimmed = applyLogLevel(frozen, 'standard')

		expect(frozen.payload).toEqual(fullToolResultPayload)
		expect(slimmed.payload).toEqual({ role: 'coder', tool: 'write_file', kind: 'success' })
	})
})
