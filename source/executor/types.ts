
import type { LogLevel } from './log-level.js'

// The logging level is defined in log-level.ts (with its guard and the event filter); re-exported here so types.ts stays the one import home for the wire types.
export type { LogLevel }

export interface GuildConfig {
	entryRole: string
	roles: Record<string, RoleDefinition>
	tools: string[]
	visualization?: VisualizationConfig
}

// The deployment file's schema, what deployment/deployment.json (plus the ORCHESTRATOR_* overrides merged on top) is validated against. The API key is deliberately absent: it is a runtime credential supplied via the ORCHESTRATOR_API_KEY environment variable, never stored in a file or type.
export interface DeploymentFileConfig {
	model: ModelConfig
	executor: ExecutorConfig
	contextPolicy: ContextPolicy
	// Optional deployment-wide default for the run logs' payload detail (docs/reference.md "Logging level"); absent means the built-in default applies.
	logging?: LoggingConfig
}

// The deployment file's optional logging section: the deployment-wide default of the log-level resolution chain, below the per-run choice and the project setting.
export interface LoggingConfig {
	level?: LogLevel
}

// The deployment knobs the executor reads at startup, kept apart from the Guild so a swapped Guild (the Foundry's artifact) never carries the model endpoint, budgets, or context policy. This is the resolved shape LoadedGuild carries: the model is completed at startup (see model-resolution.ts), so engine and web consumers read every model field as a required value.
export interface DeploymentConfig {
	model: ResolvedModelConfig
	executor: ExecutorConfig
	contextPolicy: ContextPolicy
}

// The model section of the deployment file. name and contextWindow are optional here because the model API can also report them; the deployed value is completed at startup from configuration or the model API into ResolvedModelConfig.
export interface ModelConfig {
	name?: string
	apiBase: string
	contextWindow?: number
	generation: GenerationConfig
}

// The complete model the executor consumes: every deployment-sourced field is guaranteed present, so a missing value fails at startup instead of surfacing as undefined deep in a run.
export interface ResolvedModelConfig {
	name: string
	apiBase: string
	contextWindow: number
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

export interface ToolCall {
	id: string
	type: 'function'
	function: {
		name: string
		arguments: string
	}
}

// The LLM caller's request and result types, homed here with the other shared wire types so llm-sse.ts (which produces the results) imports them from here rather than back out of llm.ts.
export interface LlmRequest {
	messages: Message[]
	tools?: ToolManifest[]
	// Streaming tap for turn text: invoked with each recognized payload-text delta as it arrives, and with a `reset` delta immediately before the first delta of every attempt — the first turn and every retry — because a retried stream re-emits its text from zero and a client accumulation must clear. Optional and additive — a caller that omits it simply streams nowhere.
	onDelta?: (delta: LlmStreamDelta) => void
}

// One streamed turn-text delta. `reset` is set only on the synthetic empty-content delta that precedes an attempt's first delta, marking that the client's whole accumulation — reasoning and content, not just the named field — must be cleared before appending.
export interface LlmStreamDelta {
	field: 'reasoning' | 'content'
	text: string
	reset?: boolean
}

export interface LlmUsage {
	promptTokens: number
	completionTokens: number
	// Cached prompt tokens reported by the endpoint via usage.prompt_tokens_details.cached_tokens, when present. Already included in promptTokens; split out because cached tokens are billed at a different (usually much lower) rate than uncached prompt tokens.
	cachedPromptTokens?: number
}

export type LlmCallResult =
	| {
		kind: 'success'
		content?: string
		reasoning?: string | null
		toolCalls: ToolCall[]
		usage: LlmUsage
		// The endpoint's finish reason (e.g. "stop", "length", "tool_calls"), so a reviewer can tell why the model stopped emitting. Absent when the endpoint omits the field, so "absent" is distinguishable from a default like "".
		finishReason?: string
	}
	| { kind: 'context_budget_exceeded'; promptTokens: number; contextWindow: number }
	| { kind: 'llm_unavailable'; message: string }

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
	| 'permission_denied'

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

// The resolved prior-run lineage and briefing channel for a queue-dispatched run: a genuine continuation carries the prior run's id, operator task, and result summary (empty when the prior run finished without a result card); a first queue dispatch carries only the interim briefing, with runId omitted so meta.continuesFrom stays honest. The executor treats it as an opaque channel — it validates, persists the lineage in meta, and injects the briefing into the entry context; the Guild decides what the continuation means.
export interface RunContinuation {
	// Present only when the run genuinely continues a prior run; absent for a first queue dispatch.
	runId?: string
	task: string
	summary: string
	// The interim briefing lines about what happened while the task waited in the queue (docs/queueing.md "The interim briefing"), composed by the scheduler and rendered under the same depth-0 gate as the prior-run lines.
	briefing?: string[]
}

export interface RunOptions {
	runId: string
	guildPath: string
	benchmarkPath?: string
	task: string
	effort: EffortLevel
	// The run's logging level (see docs/reference.md "Logging level"), resolved at submission; the run's appendLog writes are filtered at this level.
	logLevel?: LogLevel
	continuation?: RunContinuation
}

export interface RunMeta {
	runId: string
	// Optional so an interrupted meta composed from lost run data (the prior meta never landed) omits the field instead of pinning an empty-string sentinel; every other writer carries it from the run's options.
	guildPath?: string
	benchmarkPath?: string
	task: string
	// Optional so a meta missing the field, or a torn meta read, still parses.
	effort?: EffortLevel
	// The run's logging level (see docs/reference.md "Logging level"). Optional so a torn meta read still parses.
	logLevel?: LogLevel
	// Set when this run continues a prior finished run: the prior run's id. The lineage is what a follow-on run uses to find the prior run's artifacts.
	continuesFrom?: string
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
