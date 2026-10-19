import type { CheckpointRecorder } from './checkpoint.js'
import type { ContextPressureTracker } from './context/index.js'
import type { HumanBackend } from './human-backend.js'
import type { InterruptQueue } from './interrupts.js'
import type { LoadedGuild } from './loader.js'
import type { LlmCaller } from './llm.js'
import type { AppendLog } from './persistence.js'
import type { ReadProjectDoc } from './project-docs.js'
import type { RunBaseTracker } from './base-state.js'
import type { ParkedAnswer, RunParkTracker } from './park-state.js'
import type { RoleRegistry } from './role-registry.js'
import type { RoleSnapshotStore } from './role-snapshot.js'
import type { RoleState } from './state.js'
import type { RoleDelta } from './stream-channel.js'
import type { ToolPlatform } from './tool-platform-port.js'
import type { EffortLevel, InvolvementLevel, LogLevel, LogEvent, Message, ResultCard, RunContinuation, ToolCall } from './types.js'

export type { RoleState } from './state.js'

export interface EngineContext {
	loadedGuild: LoadedGuild
	depth: number
	roleName: string
	task: string
	// The run's effort, set only on the entry-role context by runExecutor. The agent spawn spreads the context to children, but the directive is gated on depth 0 below, so children never receive a global effort directive — the parent decides how to translate effort into delegation instructions.
	effort?: EffortLevel
	// The run's human-involvement level (docs/reference.md "Involvement channel"), set only on the entry-role context by runExecutor. Like effort it rides the context spread to children, but the directive is gated on depth 0 below, so children never receive a global involvement directive — the parent restates the policy in the tasks it delegates.
	involvement?: InvolvementLevel
	// The run's logging level (docs/reference.md "Logging level"), set on the entry-role context by runExecutor and inherited by children through the context spread. The engine reads it (the inquiry briefing's run-log note qualifies what the log carries); roles never see it. A context without the level reads as full detail.
	logLevel?: LogLevel
	// The prior run this run continues, set only on the entry-role context by runExecutor. Like effort, it rides the context spread to children but the briefing is gated on depth 0 in buildInitialHistory, so the continuation block appears only in the entry role's initial history — exactly once per run. Never set on resume: the composed history is already checkpointed, so re-deriving the briefing would duplicate it.
	continuation?: RunContinuation
	// The one-line git notice describing the workspace's starting state (git-state.ts), set only on the entry-role context by runExecutor. Like effort and continuation it rides the context spread to children, but buildInitialHistory gates its injection on depth 0, so it appears once in the entry role's initial history and is never re-derived on resume. Undefined when there is nothing to say (no repository, or the read failed).
	workspaceGitNotice?: string
	// The calling role's name, omitted for the entry role at depth 0 so a reviewer can distinguish a root role from a child and source/run-log can build the parent→child tree.
	parent?: string
	// The calling role's instance id, omitted for the entry role. Lets the interrupt platform walk the live delegation chain (plan-modification routing).
	parentRoleId?: string
	// Set when this invocation is an interrupt handler serving the named target instance, by the shared handler interlude (runHandlerInterlude in handler-interlude.ts): the drain point skips the handler so a handler can never interrupt itself or consume operator requests meant for real work roles.
	handlerOf?: string
}

export interface EngineDependencies {
	llmCaller: LlmCaller
	appendLog: AppendLog
	toolPlatform: ToolPlatform
	humanBackend: HumanBackend
	roleRegistry: RoleRegistry
	interruptQueue: InterruptQueue
	// The run's learned context ceiling, shared across roles so one role's wall-hit tightens every role's pressure threshold. Created per run by runExecutor.
	contextPressureTracker: ContextPressureTracker
	// The run's checkpoint recorder, created per run by runExecutor; every frame registers on start and the leaf writes the role stack at each safe point so a service restart can resume the run.
	checkpointRecorder: CheckpointRecorder
	// The run-scoped park state (docs/queueing.md "Parking: the pre-write rule"), created per run by runExecutor: the ask handler parks pre-write asks into it and the engine checks the mark at every safe point.
	parkTracker: RunParkTracker
	// The run-scoped base commit state, created per run by runExecutor: git_set_base moves it and the diff tools read it, and it rides the checkpoint so a restart keeps diffing against the same change set.
	baseTracker: RunBaseTracker
	// The run-scoped delta publisher: a leaf bound to the active run by the service (serve.ts's withRunBindings), so every streamed turn text carries the run's identity.
	publishDelta: (delta: RoleDelta) => void
	// The per-run store of finished child conversations, so a parent can continue a finished child as a new seeded instance across a restart (the live registry does not survive one).
	roleSnapshots: RoleSnapshotStore
	// The leaf that reads a role's declared projectDocs from the workspace at run start (project-docs.ts); buildInitialHistory injects the bounded block into the entry role's depth-0 initial user message, so it is read once and rides the checkpoint thereafter.
	readProjectDoc: ReadProjectDoc
}

// The turn a resumed role was suspended in: the full tool-call list, the index of the child-spawning call it was waiting on, and a resolver for the child card. The resolver either returns the checkpoint's recorded card or re-enters the child frame's own resume — invoked from inside the parent's suspended turn so parents register root-first exactly as in live execution.
export interface SuspendedTurn {
	toolCalls: ToolCall[]
	childIndex: number
	resolveChildCard: () => Promise<ResultCard>
}

// The seed for a role instance continued from a finished child: the conversation it starts from and the id of the instance it continues. The new instance gets a fresh roleId and normal role_start/role_finished events; only its initial history is inherited.
export interface SeededRole {
	history: Message[]
	continuedFrom: string
}

// The checkpoint-preserved identity and state of a role being resumed. The role keeps its pre-restart instance id (and does not re-emit role_start), so the log's role_start/role_finished pairing and every id reference inside persisted histories survive the restart.
export interface ResumedRole {
	roleId: string
	roleState: RoleState
	planAbort?: boolean
	planInjection?: string
	// A framed operator note carried on an explicit resume of an errored run, set only on the re-entered leaf frame. The engine appends it to the restored history at the loop entry — after a suspended turn's tool result has been recorded — so the note rides the same persisted history every message uses and is part of the first LLM request without landing between an assistant tool_calls message and its tool result (a malformed request on strict endpoints).
	resumeNote?: string
	// The operator's answer to the parked ask this leaf resume re-enters: delivered as the existing ask_human tool result before the parked turn continues, so the conversation prefix stays byte-identical.
	parkedAnswer?: ParkedAnswer
	suspendedTurn?: SuspendedTurn
}

// The engine's runRole turn loop, threaded in by the engine so the interrupt and resume modules can drive role turns without importing the turn loop at runtime (the engine imports these modules).
export type RunRole = (deps: EngineDependencies, context: EngineContext, resumed?: ResumedRole, seeded?: SeededRole) => Promise<ResultCard>

export function logEvent(appendLog: AppendLog, type: string, payload: unknown): void {
	const event: LogEvent = {
		timestamp: new Date().toISOString(),
		type,
		payload,
	}
	appendLog(event)
}
