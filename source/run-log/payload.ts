import { isObject } from '../executor/validation.js'

export interface Usage {
	promptTokens: number
	cachedPromptTokens: number
	completionTokens: number
	totalTokens: number
}

export function roleOf(payload: unknown): string | null {
	if (!isObject(payload)) return null
	if (typeof payload.role !== 'string') return null
	return payload.role
}

export function toolOf(payload: unknown): string | null {
	if (!isObject(payload)) return null
	if (typeof payload.tool !== 'string') return null
	return payload.tool
}

export function stringField(payload: unknown, field: string): string | null {
	if (!isObject(payload)) return null
	const value = payload[field]
	return typeof value === 'string' ? value : null
}

export function numberField(payload: unknown, field: string): number | null {
	if (!isObject(payload)) return null
	const value = payload[field]
	return typeof value === 'number' ? value : null
}

export function withRole(role: string | null, action: string): string {
	return role === null ? action : `${role} · ${action}`
}

// The top frame of a stack, or undefined when the stack is empty. Keeps stack-walking code honest about the empty case without a non-null assertion.
export function topOf<T>(stack: T[]): T | undefined {
	return stack.length > 0 ? stack[stack.length - 1] : undefined
}

// A non-empty string field of a log payload, or null.
export function payloadString(payload: Record<string, unknown>, field: string): string | null {
	const value = payload[field]
	return typeof value === 'string' && value !== '' ? value : null
}

export function usageOf(payload: unknown): Usage | null {
	if (!isObject(payload)) return null
	const usage = payload['usage']
	if (!isObject(usage)) return null
	const total = usage['totalTokens']
	const prompt = usage['promptTokens']
	const completion = usage['completionTokens']
	const cached = usage['cachedPromptTokens']

	const hasPromptCompletion = typeof prompt === 'number' && typeof completion === 'number'
	if (typeof total !== 'number' && !hasPromptCompletion) return null

	const promptTokens = typeof prompt === 'number' ? prompt : 0
	const completionTokens = typeof completion === 'number' ? completion : 0
	const cachedPromptTokens = typeof cached === 'number' ? cached : 0
	const totalTokens = typeof total === 'number' ? total : promptTokens + completionTokens
	return { promptTokens, completionTokens, cachedPromptTokens, totalTokens }
}
