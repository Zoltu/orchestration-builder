import type { CheckpointRecorder } from './checkpoint.js'
import type { ContextPressureTracker } from './context-pressure.js'
import type { HumanBackend } from './human-backend.js'
import type { InterruptQueue } from './interrupts.js'
import type { LoadedGuild } from './loader.js'
import type { LlmCaller } from './llm.js'
import type { AppendLog } from './persistence.js'
import type { RecentToolCall } from './role-inspection.js'
import type { RoleRegistry } from './role-registry.js'
import type { ToolHandler } from './tool-dispatch.js'
import type { EffortLevel, LogLevel, LogEvent, Message, RunContinuation } from './types.js'

export interface RoleState {
	history: Message[]
	lastPromptTokens: number
	recentCompactionPromptTokens: Array<number>
	recentToolCalls: RecentToolCall[]
	toolCallCount: number
	generatedTokens: number
	// Consecutive endpoint rejections for context size, reset on the first successful call. Bounds the compact-and-retry loop so a role whose request cannot be made to fit finishes with an error instead of retrying forever.
	contextExceededAttempts: number
	// The counts at which the last loop check fired; the next check fires when a count passes its watermark plus the (effort-scaled) threshold.
	loopCheckToolCallWatermark: number
	loopCheckTokenWatermark: number
	// The request message count of the role's last logged llm_call: the conversation index the next llm_call's sent list starts from, so each event carries only the messages added since the previous one instead of the whole conversation (the delta protocol in docs/reference.md "Log events"). Undefined when there is no valid baseline — no llm_call logged yet, or a context edit or compaction rewrote the history out from under it — which makes the next emission a full snapshot.
	logSentBaseline?: number
	// Context-pressure handoff state, one-shot per role instance: set to 'pending' when reported usage crosses the threshold, flipped to 'sent' when the notice is appended at the next turn boundary, and never re-armed after that — the notice asks the role to write its handoff brief and finish.
	contextPressureNotice?: 'pending' | 'sent'
	// Set when a context-window rejection must be answered by the context handler: the rejection is detected mid-turn (in handleLlmResult), but a handler can only run at the safe point, so the rejection details park here until the next loop top. Cleared once the handler (or the naive fallback) has run.
	contextCompactionPending?: { promptTokens: number; contextWindow: number }
}

export interface EngineContext {
	loadedGuild: LoadedGuild
	depth: number
	roleName: string
	task: string
	// The run's effort, set only on the entry-role context by runExecutor. The agent spawn spreads the context to children, but the directive is gated on depth 0 below, so children never receive a global effort directive — the parent decides how to translate effort into delegation instructions.
	effort?: EffortLevel
	// The run's logging level (docs/reference.md "Logging level"), set on the entry-role context by runExecutor and inherited by children through the context spread. The engine reads it (the inquiry briefing's run-log note qualifies what the log carries); roles never see it. Absent on runs that predate the channel, which read as full detail — the only mode those runs ever logged at.
	logLevel?: LogLevel
	// The prior run this run continues, set only on the entry-role context by runExecutor. Like effort, it rides the context spread to children but the briefing is gated on depth 0 in buildInitialHistory, so the continuation block appears only in the entry role's initial history — exactly once per run. Never set on resume: the composed history is already checkpointed, so re-deriving the briefing would duplicate it.
	continuation?: RunContinuation
	// The calling role's name, omitted for the entry role at depth 0 so a reviewer can distinguish a root role from a child and render.ts can build the parent→child tree.
	parent?: string
	// The calling role's instance id, omitted for the entry role. Lets the interrupt platform walk the live delegation chain (plan-modification routing).
	parentRoleId?: string
	// Set when this invocation is an interrupt handler serving the named target instance: the drain point skips the handler so a handler can never interrupt itself or consume operator requests meant for real work roles.
	handlerOf?: string
}

export interface EngineDependencies {
	llmCaller: LlmCaller
	appendLog: AppendLog
	additionalToolHandlers: Record<string, ToolHandler>
	humanBackend: HumanBackend
	roleRegistry: RoleRegistry
	interruptQueue: InterruptQueue
	// The run's learned context ceiling, shared across roles so one role's wall-hit tightens every role's pressure threshold. Created per run by runExecutor.
	contextPressureTracker: ContextPressureTracker
	// The run's checkpoint recorder, created per run by runExecutor; every frame registers on start and the leaf writes the role stack at each safe point so a service restart can resume the run.
	checkpointRecorder: CheckpointRecorder
}

export function logEvent(appendLog: AppendLog, type: string, payload: unknown): void {
	const event: LogEvent = {
		timestamp: new Date().toISOString(),
		type,
		payload,
	}
	appendLog(event)
}
