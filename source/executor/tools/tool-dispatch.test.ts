import { describe, expect, test } from 'bun:test'
import type { RoleDefinition, ToolCall, ToolResult } from '../types.js'
import type { ToolInvocation } from '../invocation.js'
import type { ToolPlatform } from '../tool-platform-port.js'
import { createFixtureRunScope, createFixtureToolPlatform } from '../test-fixtures.js'
import { createToolDispatch } from './tool-dispatch.js'

const role: RoleDefinition = { systemPrompt: '', tools: ['ask_human'] }

function makeCall(name: string, args: string): ToolCall {
	return { id: '1', type: 'function', function: { name, arguments: args } }
}

function invocationFor(call: ToolCall): ToolInvocation {
	return { toolCall: call, questionId: call.id, callId: `tool:${call.id}`, parentCallId: 'role:fixture-0-0' }
}

async function dispatchTo(platform: ToolPlatform, roleDefinition: RoleDefinition, scope: ReturnType<typeof createFixtureRunScope>, call: ToolCall): Promise<ToolResult> {
	const outcome = await platform.dispatch(roleDefinition, scope, call, invocationFor(call))
	if (outcome.kind === 'suspended') throw new Error('unexpected suspension')
	return outcome.result
}

describe('tool platform dispatch', () => {
	test('normalizes an ordinary handler result into the result variant', async () => {
		const dispatch = createToolDispatch({ echo: () => ({ kind: 'success', data: 'ok' }) })
		await expect(dispatch.dispatch(makeCall('echo', '{}'))).resolves.toEqual({ kind: 'result', result: { kind: 'success', data: 'ok' } })
	})

	test('passes a child suspension through without wrapping it', async () => {
		const suspension = { category: 'billing' as const, resumePolicy: 'operator' as const, message: 'Top up.', suspendedAt: '2026-01-01T00:00:00.000Z' }
		const dispatch = createToolDispatch({ agent: () => ({ kind: 'suspended', suspension }) })
		await expect(dispatch.dispatch(makeCall('agent', '{}'))).resolves.toEqual({ kind: 'suspended', suspension })
	})

	test('passes the originating ToolCall as the handler second argument', async () => {
		let observed: ToolCall | undefined
		const dispatch = createToolDispatch({
			echo: (_args, call) => {
				observed = call
				return { kind: 'success', data: null }
			},
		})
		const call = makeCall('echo', '{"value":1}')

		await dispatch.dispatch(call)

		expect(observed).toEqual(call)
	})

	test('dispatches to a registered handler with parsed args', async () => {
		const platform = createFixtureToolPlatform()
		const scope = createFixtureRunScope({ manifestNames: new Set(['ask_human']) })
		const result = await dispatchTo(platform, role, scope, makeCall('ask_human', '{"question":"why?"}'))
		expect(result).toEqual({ kind: 'success', data: { question: 'why?', answer: 'use your best judgement' } })
	})

	test('returns unknown_tool for a tool not registered in the Guild', async () => {
		const platform = createFixtureToolPlatform()
		const scope = createFixtureRunScope({ manifestNames: new Set() })
		const result = await dispatchTo(platform, role, scope, makeCall('ask_human', '{}'))
		expect(result.kind).toBe('unknown_tool')
	})

	test('returns invalid_tool_call for a registered tool the role may not use', async () => {
		const platform = createFixtureToolPlatform()
		const scope = createFixtureRunScope({ manifestNames: new Set(['ask_human']) })
		const result = await dispatchTo(platform, { systemPrompt: '', tools: [] }, scope, makeCall('ask_human', '{}'))
		expect(result.kind).toBe('invalid_tool_call')
	})

	test('returns invalid_arguments when arguments are not valid JSON', async () => {
		const platform = createFixtureToolPlatform()
		const scope = createFixtureRunScope({ manifestNames: new Set(['ask_human']) })
		const result = await dispatchTo(platform, role, scope, makeCall('ask_human', 'not json'))
		expect(result.kind).toBe('invalid_arguments')
	})

	for (const encoded of ['"string"', '[1,2]', 'null']) {
		test(`returns invalid_arguments when arguments are ${encoded}, not an object`, async () => {
			const platform = createFixtureToolPlatform()
			const scope = createFixtureRunScope({ manifestNames: new Set(['ask_human']) })
			const result = await dispatchTo(platform, role, scope, makeCall('ask_human', encoded))
			expect(result.kind).toBe('invalid_arguments')
		})
	}

	test('an empty argument object reaches the handler, which validates it', async () => {
		const platform = createFixtureToolPlatform()
		const scope = createFixtureRunScope({ manifestNames: new Set(['ask_human']) })
		const result = await dispatchTo(platform, role, scope, makeCall('ask_human', '{}'))
		expect(result.kind).toBe('invalid_arguments')
	})

	test('supports async handlers', async () => {
		const platform = createFixtureToolPlatform()
		const scope = createFixtureRunScope({ manifestNames: new Set(['ask_human']) })
		const result = await dispatchTo(platform, role, scope, makeCall('ask_human', '{"question":"async?"}'))
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
