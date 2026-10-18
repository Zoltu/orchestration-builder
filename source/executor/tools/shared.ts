import { createToolError } from '../errors.js'
import type { ToolResult } from '../types.js'

export function wrapIoError(error: unknown, fallbackMessage: string): ToolResult {
	const message = error instanceof Error ? error.message : fallbackMessage
	return createToolError('invalid_arguments', message)
}

// Optional integer tool arguments share one contract: absent falls back to the default, and anything that is not an integer in range reports null so the handler can return an invalid_arguments error naming the parameter.
export function optionalNonNegativeInt(value: unknown, fallback: number): number | null {
	if (value === undefined) return fallback
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null
	return value
}

export function optionalPositiveInt(value: unknown, fallback: number): number | null {
	if (value === undefined) return fallback
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
	return value
}
