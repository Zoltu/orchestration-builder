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

// Startup-configuration failure: the service cannot boot correctly with this guild, deployment file, or ORCHESTRATOR_* override, and the message is fit to show the operator verbatim on the bootstrap error page (see source/web/bootstrap-failure.ts). Port problems are deliberately not this class: with an unusable port there is nothing to serve.
export class ConfigurationError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ConfigurationError'
	}
}

export const ERROR_KINDS: readonly ErrorKind[] = [
	'invalid_tool_call',
	'unknown_tool',
	'invalid_arguments',
	'timeout',
	'llm_unavailable',
	'unavailable',
	'context_budget_exceeded',
	'context_handoff',
	'tool_budget_exceeded',
	'loop_detected',
	'interrupted',
	'compaction_failed',
]

export function isErrorKind(value: unknown): value is ErrorKind {
	return typeof value === 'string' && ERROR_KINDS.some((kind) => kind === value)
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
