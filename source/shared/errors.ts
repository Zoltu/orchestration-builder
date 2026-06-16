// Shared error kinds, result-card shapes, and constructors.

import type { ErrorKind, ResultCard, ToolResult } from './types.js'

export class ValidationError extends Error {
	constructor(
		public path: string,
		message: string,
	) {
		super(path ? `${path}: ${message}` : message)
		this.name = 'ValidationError'
	}
}

export const ERROR_KINDS: readonly ErrorKind[] = [
	'invalid_tool_call',
	'unknown_tool',
	'invalid_arguments',
	'timeout',
	'llm_unavailable',
	'context_budget_exceeded',
	'tool_budget_exceeded',
	'token_budget_exceeded',
	'loop_detected',
	'compaction_failed',
]

export { ErrorKind, ResultCard, ToolResult }

export function isErrorKind(value: unknown): value is ErrorKind {
	return typeof value === 'string' && ERROR_KINDS.some((kind) => kind === value)
}

export function createSuccessResult(data?: unknown): ToolResult {
	return { kind: 'success', data }
}

export function createToolError(kind: ErrorKind, message?: string, details?: unknown): ToolResult {
	return { kind, message, details }
}

export function createResultCard(status: ResultCard['status'], summary: string, options?: { artifacts?: string[]; error?: ToolResult }): ResultCard {
	const error = options?.error
	if (error && error.kind !== 'success') {
		return {
			status,
			summary,
			artifacts: options.artifacts,
			error: {
				kind: error.kind,
				message: error.message,
				details: error.details,
			},
		}
	}
	return { status, summary, artifacts: options?.artifacts }
}
