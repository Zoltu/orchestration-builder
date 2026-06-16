// Shared TypeScript contracts for the Adaptive Orchestrator.
// These types describe external JSON objects loaded at runtime.

export interface GuildConfig {
	schemaVersion: number
	model: ModelConfig
	executor: ExecutorConfig
	contextPolicy: ContextPolicy
	entryRole: string
	roles: Record<string, RoleDefinition>
	tools: string[]
}

export interface ModelConfig {
	name: string
	apiBase: string
	apiKey?: string
	contextWindow: number
	reasoningField?: string
	generation: GenerationConfig
}

export interface GenerationConfig {
	temperature?: number
	maxTokens?: number
}

export interface ExecutorConfig {
	maxAgentDepth: number
	maxToolCallsPerRole: number
	maxTokensPerRole: number
	maxRunTimeSeconds: number
	defaultToolTimeoutSeconds: number
	maxRepeatedToolCalls: number
	maxCompactionAttempts: number
}

export interface ContextPolicy {
	maxToolOutputChars: number
}

export interface RoleDefinition {
	systemPrompt: string
	tools: string[]
	generation?: GenerationConfig
	includeReasoning?: boolean
	budget?: RoleBudget
}

export interface RoleBudget {
	maxToolCalls?: number
	maxTokens?: number
}

export interface ToolManifest {
	name: string
	description: string
	parameters: ToolParameter
}

// JSON-Schema-like parameter object for a tool manifest.
export interface ToolParameter {
	type: string
	required?: string[]
	properties?: Record<string, ToolParameter>
	additionalProperties?: boolean
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface Message {
	role: MessageRole
	content: string
	reasoning?: string | null
	tool_call_id?: string
	tool_calls?: ToolCall[]
}

export interface AssistantResponse {
	content?: string
	reasoning?: string | null
	tool_calls?: ToolCall[]
}

export interface ToolCall {
	id: string
	type: 'function'
	function: {
		name: string
		arguments: string
	}
}

export type ErrorKind =
	| 'invalid_tool_call'
	| 'unknown_tool'
	| 'invalid_arguments'
	| 'timeout'
	| 'llm_unavailable'
	| 'context_budget_exceeded'
	| 'tool_budget_exceeded'
	| 'token_budget_exceeded'
	| 'loop_detected'
	| 'compaction_failed'

export type ToolResult =
	| { kind: 'success'; data?: unknown }
	| { kind: ErrorKind; message?: string; details?: unknown }

export interface ResultCard {
	status: 'success' | 'error' | 'needs_clarification'
	summary: string
	artifacts?: string[]
	error?: { kind: ErrorKind; message?: string; details?: unknown }
}

export interface RunOptions {
	runId: string
	guildPath: string
	benchmarkPath: string
	task: string
}

export interface RunMeta {
	runId: string
	guildPath: string
	benchmarkPath: string
	task: string
	status: 'running' | 'success' | 'error' | 'needs_clarification'
	startTime: string
	endTime?: string
	result?: ResultCard
	error?: { kind: ErrorKind; message: string }
}

export interface LogEvent {
	timestamp: string
	type: string
	payload: unknown
}
