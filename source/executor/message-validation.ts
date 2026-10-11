import type { Message, ToolCall } from './types.js'
import { isObject, isString } from './validation.js'

const messageRoles: readonly Message['role'][] = ['system', 'user', 'assistant', 'tool']

export function isToolCall(value: unknown): value is ToolCall {
	if (!isObject(value)) return false
	if (!isString(value.id)) return false
	if (value.type !== 'function') return false
	if (!isObject(value.function)) return false
	if (!isString(value.function.name)) return false
	if (!isString(value.function.arguments)) return false
	return true
}

export function isMessage(value: unknown): value is Message {
	if (!isObject(value)) return false
	if (!isString(value.role) || !messageRoles.some((role) => role === value.role)) return false
	if (!isString(value.content)) return false
	if (value.reasoning !== undefined && value.reasoning !== null && !isString(value.reasoning)) return false
	if (value.tool_call_id !== undefined && !isString(value.tool_call_id)) return false
	if (value.tool_calls !== undefined && (!Array.isArray(value.tool_calls) || !value.tool_calls.every(isToolCall))) return false
	return true
}
