// Pure orchestration for dispatching tool calls to registered handlers.
// Phase 2's engine composes the handler map from built-in tools (finish, agent)
// and from native tools (phase 3). This module contains no I/O and is fully
// testable with fake handlers.

import { createToolError } from '../shared/errors.js'
import type { ToolCall, ToolResult } from '../shared/types.js'

export type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>

export interface ToolDispatch {
	dispatch(call: ToolCall): Promise<ToolResult>
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeJsonParse(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) }
	} catch {
		return { ok: false }
	}
}

export function createToolDispatch(handlers: Record<string, ToolHandler>): ToolDispatch {
	async function dispatch(call: ToolCall): Promise<ToolResult> {
		const handler = handlers[call.function.name]
		if (!handler) {
			return createToolError('unknown_tool', `unknown tool: ${call.function.name}`)
		}
		const parsed = safeJsonParse(call.function.arguments)
		if (!parsed.ok) {
			return createToolError('invalid_arguments', 'arguments must be valid JSON')
		}
		if (!isObject(parsed.value)) {
			return createToolError('invalid_arguments', 'arguments must be a JSON object')
		}
		return await handler(parsed.value)
	}
	return { dispatch }
}
