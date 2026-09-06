
export interface GuildConfig {
	entryRole: string
	roles: Record<string, RoleDefinition>
	tools: string[]
	visualization?: VisualizationConfig
}

// The deployment knobs the executor reads at startup, kept apart from the Guild so a swapped Guild (the Foundry's artifact) never carries the model endpoint, budgets, or context policy. The API key is deliberately absent: it is a runtime credential supplied via the ORCHESTRATOR_API_KEY environment variable, never stored in a file or type.
export interface DeploymentConfig {
	model: ModelConfig
	executor: ExecutorConfig
	contextPolicy: ContextPolicy
}

export interface ModelConfig {
	name: string
	apiBase: string
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
	// Fraction of the effective context budget (see context-pressure.ts) at which a role receives the one-shot pressure notice asking it to write a handoff brief and finish with context_handoff. Optional; the engine applies a default when unset.
	contextPressureThreshold?: number
	// The guild role the engine invokes to compact a suspended role's conversation: at depth 0 when the entry role crosses the pressure threshold (it has no parent to hand off to), and at any depth when a request is rejected for context size. Optional; when unset, depth-0 pressure falls back to the handoff notice and rejections fall back to the naive in-place backstop.
	contextHandlerRole?: string
	// The guild role the engine invokes to answer an operator inquiry: the run suspends at the safe point and a fresh instance of this role investigates with its tools; its finish-card summary is the answer. Optional; when unset, an inquiry is dropped (logged) rather than answered — a question never kills a run.
	inquiryHandlerRole?: string
	interruptTriggers?: InterruptTriggersConfig
}

// The interrupt platform's cadence configuration. everyToolCalls/everyTokens are the base thresholds; the engine scales them by the run's effort tier (threshold × the tier's factor), so higher-effort runs are checked less often. handlerRole is the guild role the engine invokes on a cadence trigger; planOwnerRole names the role that receives plan modifications (the active chain's rootmost instance of it), falling back to the chain root when absent or not in the chain.
export interface InterruptTriggersConfig {
	handlerRole: string
	everyToolCalls: number
	everyTokens: number
	planOwnerRole?: string
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
	| 'unavailable'
	| 'context_budget_exceeded'
	| 'context_handoff'
	| 'tool_budget_exceeded'
	| 'loop_detected'
	| 'interrupted'
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
	benchmarkPath?: string
	task: string
	effort: EffortLevel
	// The run's log.jsonl as a workspace-relative path, interpolated into the inquiry handler's briefing so finished roles remain researchable from the log and the workspace.
	runLogPath: string
}

export interface RunMeta {
	runId: string
	guildPath: string
	benchmarkPath?: string
	task: string
	// Absent on runs written before the effort channel existed; present on every run started since. Optional so a torn or legacy meta read still parses.
	effort?: EffortLevel
	// 'interrupted' is terminal: the service stopped mid-run and the run could not (or was not chosen to) resume on restart — written by startup reconciliation so the UI stops showing the run as "in progress".
	status: 'running' | 'success' | 'error' | 'needs_clarification' | 'interrupted'
	startTime: string
	endTime?: string
	result?: ResultCard
	error?: { kind: ErrorKind; message: string }
}

// Per-run speed-vs-quality setting. The three tier names are the contract on every wire (API bodies, settings.json, meta.json, checkpoints, the effort_set event); the executor carries and logs the tier but makes no decision about what each tier means — that mapping is Guild-defined.
export type EffortLevel = 'quick' | 'standard' | 'thorough'

export interface LogEvent {
	timestamp: string
	type: string
	payload: unknown
}
