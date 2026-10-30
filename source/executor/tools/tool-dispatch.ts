import { createToolError } from '../errors.js'
import { isObject, safeJsonParse } from '../validation.js'
import type { ToolCall, ToolExecutionOutcome, ToolResult } from '../types.js'

// call is the originating tool call; dispatch always supplies it, and an optional parameter keeps direct one-argument handler invocations (and one-parameter handler implementations) assignable.
export type ToolHandler = (args: Record<string, unknown>, call?: ToolCall) => ToolResult | Promise<ToolResult>

// Only the child-spawning built-ins can suspend the run; every other handler keeps the ordinary ToolResult contract, so direct handler tests never see a suspension variant.
type SuspendingToolHandler = (args: Record<string, unknown>, call?: ToolCall) => ToolExecutionOutcome | Promise<ToolExecutionOutcome>

export type AnyToolHandler = ToolHandler | SuspendingToolHandler

export interface ToolDispatch {
	dispatch(call: ToolCall): Promise<ToolExecutionOutcome>
}

export interface DispatchToolCallConfig {
	allowedTools: string[]
	manifestNames: string[]
	dispatch: ToolDispatch
}

export function createToolDispatch(handlers: Record<string, AnyToolHandler>): ToolDispatch {
	async function dispatch(call: ToolCall): Promise<ToolExecutionOutcome> {
		const handler = handlers[call.function.name]
		if (!handler) {
			return { kind: 'result', result: createToolError('unknown_tool', `unknown tool: ${call.function.name}`) }
		}
		const parsed = safeJsonParse(call.function.arguments)
		if (!parsed.ok) {
			return { kind: 'result', result: createToolError('invalid_arguments', 'arguments must be valid JSON') }
		}
		if (!isObject(parsed.value)) {
			return { kind: 'result', result: createToolError('invalid_arguments', 'arguments must be a JSON object') }
		}
		const outcome = await handler(parsed.value, call)
		if (outcome.kind === 'suspended' || outcome.kind === 'operator_paused' || outcome.kind === 'result') return outcome
		return { kind: 'result', result: outcome }
	}
	return { dispatch }
}

export function validateToolCall(config: Pick<DispatchToolCallConfig, 'allowedTools' | 'manifestNames'>, call: ToolCall): ToolResult | null {
	if (!config.manifestNames.includes(call.function.name)) {
		return createToolError('unknown_tool', `Tool ${call.function.name} is not registered in the Guild`)
	}
	if (!config.allowedTools.includes(call.function.name)) {
		return createToolError('invalid_tool_call', `Tool ${call.function.name} not allowed for this role`)
	}
	return null
}

export async function dispatchToolCall(config: DispatchToolCallConfig, call: ToolCall): Promise<ToolExecutionOutcome> {
	const invalid = validateToolCall(config, call)
	if (invalid !== null) return { kind: 'result', result: invalid }
	return await config.dispatch.dispatch(call)
}
