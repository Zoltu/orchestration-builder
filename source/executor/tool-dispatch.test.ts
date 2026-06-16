import { describe, expect, test } from 'bun:test'

import { createToolDispatch } from './tool-dispatch.ts'
import type { ToolCall } from '../shared/types.js'

function makeCall(name: string, args: string): ToolCall {
	return { id: '1', type: 'function', function: { name, arguments: args } }
}

describe('tool dispatch', () => {
	test('dispatches to a registered handler with parsed args', async () => {
		const dispatch = createToolDispatch({
			echo: (args) => ({ kind: 'success', data: args }),
		})
		const result = await dispatch.dispatch(makeCall('echo', '{"x":1}'))
		expect(result.kind).toBe('success')
		if (result.kind === 'success') {
			expect(result.data).toEqual({ x: 1 })
		}
	})

	test('returns unknown_tool for an unregistered handler', async () => {
		const dispatch = createToolDispatch({})
		const result = await dispatch.dispatch(makeCall('missing', '{}'))
		expect(result.kind).toBe('unknown_tool')
	})

	test('returns invalid_arguments when arguments are not valid JSON', async () => {
		const dispatch = createToolDispatch({
			x: () => ({ kind: 'success', data: null }),
		})
		const result = await dispatch.dispatch(makeCall('x', 'not json'))
		expect(result.kind).toBe('invalid_arguments')
	})

	test('returns invalid_arguments when arguments are a JSON string, not an object', async () => {
		const dispatch = createToolDispatch({
			x: () => ({ kind: 'success', data: null }),
		})
		const result = await dispatch.dispatch(makeCall('x', '"string"'))
		expect(result.kind).toBe('invalid_arguments')
	})

	test('returns invalid_arguments when arguments are a JSON array, not an object', async () => {
		const dispatch = createToolDispatch({
			x: () => ({ kind: 'success', data: null }),
		})
		const result = await dispatch.dispatch(makeCall('x', '[1,2]'))
		expect(result.kind).toBe('invalid_arguments')
	})

	test('returns invalid_arguments when arguments are JSON null', async () => {
		const dispatch = createToolDispatch({
			x: () => ({ kind: 'success', data: null }),
		})
		const result = await dispatch.dispatch(makeCall('x', 'null'))
		expect(result.kind).toBe('invalid_arguments')
	})

	test('handler receives an empty object when arguments are empty JSON object', async () => {
		const dispatch = createToolDispatch({
			noargs: (args) => ({ kind: 'success', data: Object.keys(args).length }),
		})
		const result = await dispatch.dispatch(makeCall('noargs', '{}'))
		if (result.kind === 'success') {
			expect(result.data).toBe(0)
		}
	})

	test('supports async handlers', async () => {
		const dispatch = createToolDispatch({
			asyncEcho: async (args) => ({ kind: 'success', data: args }),
		})
		const result = await dispatch.dispatch(makeCall('asyncEcho', '{"y":2}'))
		if (result.kind === 'success') {
			expect(result.data).toEqual({ y: 2 })
		}
	})
})
