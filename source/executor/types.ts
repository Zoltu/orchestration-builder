
export interface GuildConfig {
	schemaVersion: number
	model: ModelConfig
	executor: ExecutorConfig
	contextPolicy: ContextPolicy
	entryRole: string
	roles: Record<string, RoleDefinition>
	tools: string[]
	visualization?: VisualizationConfig
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
	defaultToolTimeoutSeconds: number
	maxCompactionAttempts: number
}

export interface ContextPolicy {
	maxToolOutputChars: number
}

export interface HumanFacingText {
	detailed: string[]
	whimsical?: string[]
	friendly?: string[]
}

export interface RoleDefinition {
	systemPrompt: string
	tools: string[]
	includeReasoning?: boolean
	label?: HumanFacingText
	description?: HumanFacingText
	workingLabel?: HumanFacingText
}

export interface ToolManifest {
	name: string
	description: string
	parameters: ToolParameter
	humanLabel?: HumanFacingText
	humanDescription?: HumanFacingText
	humanCallLabel?: HumanFacingText
	humanWorkingLabel?: HumanFacingText
}

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
	| 'loop_detected'
	| 'compaction_failed'

export type ToolResult =
	| { kind: 'success'; data?: unknown }
	| { kind: ErrorKind; message?: string; details?: unknown }

export type OperationKind = 'call' | 'return' | 'observe' | 'terminate'

export type ParticipantKind = 'human' | 'interrupt' | 'role' | 'tool'

export interface VisualizationConfig {
	pseudoRoleLabels: Record<string, HumanFacingText>
	operationTemplates: Record<OperationKind, Record<string, HumanFacingText>>
	genericOperationTemplates: Record<OperationKind, HumanFacingText>
	workingTemplates?: Record<string, HumanFacingText>
}

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
	effort: EffortLevel
}

export interface RunMeta {
	runId: string
	guildPath: string
	benchmarkPath: string
	task: string
	// Absent on runs written before the effort channel existed; present on every run started since. Optional so a torn or legacy meta read still parses.
	effort?: EffortLevel
	status: 'running' | 'success' | 'error' | 'needs_clarification'
	startTime: string
	endTime?: string
	result?: ResultCard
	error?: { kind: ErrorKind; message: string }
}

// Per-run speed-vs-quality setting. The integer is the contract; the executor carries and logs it but makes no decision about what each level means — that mapping is Guild-defined.
export type EffortLevel = 0 | 1 | 2 | 3 | 4 | 5

export interface LogEvent {
	timestamp: string
	type: string
	payload: unknown
}
