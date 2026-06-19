import { createToolError } from '../shared/errors.js'
import { truncateToolOutput } from './context-policy.js'
import type { ToolCall, ToolResult } from '../shared/types.js'

export type ToolHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>

export interface ToolDispatch {
	dispatch(call: ToolCall): Promise<ToolResult>
}

export interface DispatchToolCallConfig {
	allowedTools: string[]
	manifestNames: string[]
	maxToolOutputChars: number
	dispatch: ToolDispatch
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

export async function dispatchToolCall(config: DispatchToolCallConfig, call: ToolCall): Promise<ToolResult> {
	if (!config.manifestNames.includes(call.function.name)) {
		return createToolError('unknown_tool', `Tool ${call.function.name} is not registered in the Guild`)
	}
	if (!config.allowedTools.includes(call.function.name)) {
		return createToolError('invalid_tool_call', `Tool ${call.function.name} not allowed for this role`)
	}
	const result = await config.dispatch.dispatch(call)
	if (result.kind === 'success') {
		const serialized = JSON.stringify(result.data ?? null)
		const truncated = truncateToolOutput(serialized, config.maxToolOutputChars)
		if (truncated.truncated) {
			return { kind: 'success', data: truncated.text }
		}
		return result
	}
	return result
}