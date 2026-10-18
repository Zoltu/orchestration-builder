import { describe, expect, test } from 'bun:test'
import type { RoleDefinition, ToolCall } from '../types.js'
import { createFixtureRunScope, createFixtureToolPlatform } from '../test-fixtures.js'

const role: RoleDefinition = { systemPrompt: '', tools: ['ask_human'] }

function makeCall(name: string, args: string): ToolCall {
	return { id: '1', type: 'function', function: { name, arguments: args } }
}

describe('tool platform dispatch', () => {
	test('dispatches to a registered handler with parsed args', async () => {
		const platform = createFixtureToolPlatform()
		const scope = createFixtureRunScope({ manifestNames: new Set(['ask_human']) })
		const result = await platform.dispatch(role, scope, makeCall('ask_human', '{"question":"why?"}'))
		expect(result).toEqual({ kind: 'success', data: { question: 'why?', answer: 'use your best judgement' } })
	})

	test('returns unknown_tool for a tool not registered in the Guild', async () => {
		const platform = createFixtureToolPlatform()
		const scope = createFixtureRunScope({ manifestNames: new Set() })
		const result = await platform.dispatch(role, scope, makeCall('ask_human', '{}'))
		expect(result.kind).toBe('unknown_tool')
	})

	test('returns invalid_tool_call for a registered tool the role may not use', async () => {
		const platform = createFixtureToolPlatform()
		const scope = createFixtureRunScope({ manifestNames: new Set(['ask_human']) })
		const result = await platform.dispatch({ systemPrompt: '', tools: [] }, scope, makeCall('ask_human', '{}'))
		expect(result.kind).toBe('invalid_tool_call')
	})

	test('returns invalid_arguments when arguments are not valid JSON', async () => {
		const platform = createFixtureToolPlatform()
		const scope = createFixtureRunScope({ manifestNames: new Set(['ask_human']) })
		const result = await platform.dispatch(role, scope, makeCall('ask_human', 'not json'))
		expect(result.kind).toBe('invalid_arguments')
	})

	for (const encoded of ['"string"', '[1,2]', 'null']) {
		test(`returns invalid_arguments when arguments are ${encoded}, not an object`, async () => {
			const platform = createFixtureToolPlatform()
			const scope = createFixtureRunScope({ manifestNames: new Set(['ask_human']) })
			const result = await platform.dispatch(role, scope, makeCall('ask_human', encoded))
			expect(result.kind).toBe('invalid_arguments')
		})
	}

	test('an empty argument object reaches the handler, which validates it', async () => {
		const platform = createFixtureToolPlatform()
		const scope = createFixtureRunScope({ manifestNames: new Set(['ask_human']) })
		const result = await platform.dispatch(role, scope, makeCall('ask_human', '{}'))
		expect(result.kind).toBe('invalid_arguments')
	})

	test('supports async handlers', async () => {
		const platform = createFixtureToolPlatform()
		const scope = createFixtureRunScope({ manifestNames: new Set(['ask_human']) })
		const result = await platform.dispatch(role, scope, makeCall('ask_human', '{"question":"async?"}'))
		expect(result.kind).toBe('success')
	})

	test('reports the suspension and observation capabilities without exposing the underlying sets', () => {
		const platform = createFixtureToolPlatform()
		expect(platform.suspendsChild('agent')).toBe(true)
		expect(platform.suspendsChild('continue_agent')).toBe(true)
		expect(platform.suspendsChild('finish')).toBe(false)
		expect(platform.observesRole('context_info')).toBe(true)
		expect(platform.observesRole('finish')).toBe(false)
	})
})
