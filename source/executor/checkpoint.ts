import { isErrorKind } from './errors.js'
import type { ContextPressureTracker } from './context-pressure.js'
import type { EngineContext, RoleState } from './engine-state.js'
import type { WriteCheckpoint } from './persistence.js'
import type { RoleRegistry, RoleRegistryEntry } from './role-registry.js'
import type { EffortLevel, Message, MessageRole, ResultCard, ToolCall } from './types.js'
import { isRunIdShape } from './run-id.js'
import { isEffortLevel, isNonNegativeInteger, isNonNegativeNumber, isObject, isResultCard, isString } from './validation.js'

// The suspension point of a role paused mid-turn inside its `agent` tool dispatch: the turn's full tool-call list and the index of the agent call it is waiting on. Once the child returns, its card is recorded here so a resume delivers the recorded card instead of re-running the child. Tool calls before agentIndex are already recorded in the role's persisted history; calls after it are dispatched on resume.
export interface PendingAgentSuspension {
	toolCalls: ToolCall[]
	agentIndex: number
	childCard?: ResultCard
}

// One live role invocation on the depth-first stack. Frames serialize root-first; a non-leaf frame is always suspended on an agent call whose child still runs below it, and the leaf is either the active role (no pending) or a parent whose child just returned (pending carrying the recorded child card). Handler invocations (loop-check and context handlers) never appear: writes are suppressed while a handler runs, so a handler interlude is atomic with respect to the checkpoint — either it completes and the post-drain write captures its effects, or the resume re-runs the drain from the pre-interlude checkpoint.
export interface CheckpointFrame {
	roleId: string
	roleName: string
	depth: number
	task: string
	parent?: string
	parentRoleId?: string
	effort?: EffortLevel
	// Set only on the entry frame: the prior run this run continues. The lineage id rides the checkpoint so a restart-resumed run still writes continuesFrom into its metas; the briefing itself is not carried because it is already baked into the frame's persisted history.
	continuesFrom?: string
	planAbort?: boolean
	planInjection?: string
	roleState: RoleState
	pending?: PendingAgentSuspension
}

// The runnable state of a run, persisted so a service restart can resume it. Written atomically (temp file + rename) at every leaf safe point and on every role_finished, so the on-disk checkpoint is never torn and never more than one turn stale. `registryCounter` lets the resumed run mint fresh role-instance ids without colliding with the preserved ones; `learnedContextCeiling` carries the run's context-wall knowledge so resumed roles keep the tightened pressure threshold.
export interface RunCheckpoint {
	version: 1
	runId: string
	startTime: string
	registryCounter: number
	learnedContextCeiling?: number
	frames: CheckpointFrame[]
}

const messageRoles: readonly MessageRole[] = ['system', 'user', 'assistant', 'tool']

function isToolCall(value: unknown): value is ToolCall {
	if (!isObject(value)) return false
	if (!isString(value.id)) return false
	if (value.type !== 'function') return false
	if (!isObject(value.function)) return false
	if (!isString(value.function.name)) return false
	if (!isString(value.function.arguments)) return false
	return true
}

function isMessage(value: unknown): value is Message {
	if (!isObject(value)) return false
	if (!isString(value.role) || !messageRoles.some((role) => role === value.role)) return false
	if (!isString(value.content)) return false
	if (value.reasoning !== undefined && value.reasoning !== null && !isString(value.reasoning)) return false
	if (value.tool_call_id !== undefined && !isString(value.tool_call_id)) return false
	if (value.tool_calls !== undefined && (!Array.isArray(value.tool_calls) || !value.tool_calls.every(isToolCall))) return false
	return true
}

function isRecentToolCall(value: unknown): boolean {
	if (!isObject(value)) return false
	if (!isString(value.tool)) return false
	if (!isString(value.argsHash)) return false
	if (value.resultKind !== 'success' && !isErrorKind(value.resultKind)) return false
	return true
}

function isRoleState(value: unknown): value is RoleState {
	if (!isObject(value)) return false
	if (!Array.isArray(value.history) || !value.history.every(isMessage)) return false
	if (!isNonNegativeNumber(value.lastPromptTokens)) return false
	if (!Array.isArray(value.recentCompactionPromptTokens) || !value.recentCompactionPromptTokens.every(isNonNegativeNumber)) return false
	if (!Array.isArray(value.recentToolCalls) || !value.recentToolCalls.every(isRecentToolCall)) return false
	if (!isNonNegativeNumber(value.toolCallCount)) return false
	if (!isNonNegativeNumber(value.generatedTokens)) return false
	if (!isNonNegativeNumber(value.contextExceededAttempts)) return false
	if (!isNonNegativeNumber(value.loopCheckToolCallWatermark)) return false
	if (!isNonNegativeNumber(value.loopCheckTokenWatermark)) return false
	if (value.contextPressureNotice !== undefined && value.contextPressureNotice !== 'pending' && value.contextPressureNotice !== 'sent') return false
	if (value.contextCompactionPending !== undefined) {
		if (!isObject(value.contextCompactionPending)) return false
		if (!isNonNegativeNumber(value.contextCompactionPending.promptTokens)) return false
		if (!isNonNegativeNumber(value.contextCompactionPending.contextWindow)) return false
	}
	return true
}

function isPendingAgentSuspension(value: unknown): value is PendingAgentSuspension {
	if (!isObject(value)) return false
	if (!Array.isArray(value.toolCalls) || value.toolCalls.length === 0 || !value.toolCalls.every(isToolCall)) return false
	if (!isNonNegativeInteger(value.agentIndex) || value.agentIndex >= value.toolCalls.length) return false
	if (value.toolCalls[value.agentIndex]?.function.name !== 'agent') return false
	if (value.childCard !== undefined && !isResultCard(value.childCard)) return false
	return true
}

function isCheckpointFrame(value: unknown): value is CheckpointFrame {
	if (!isObject(value)) return false
	if (!isString(value.roleId)) return false
	if (!isString(value.roleName)) return false
	if (!isNonNegativeInteger(value.depth)) return false
	if (!isString(value.task)) return false
	if (value.parent !== undefined && !isString(value.parent)) return false
	if (value.parentRoleId !== undefined && !isString(value.parentRoleId)) return false
	if (value.effort !== undefined && !isEffortLevel(value.effort)) return false
	if (value.continuesFrom !== undefined && !isRunIdShape(value.continuesFrom)) return false
	if (value.planAbort !== undefined && value.planAbort !== true) return false
	if (value.planInjection !== undefined && !isString(value.planInjection)) return false
	if (!isRoleState(value.roleState)) return false
	if (value.pending !== undefined && !isPendingAgentSuspension(value.pending)) return false
	return true
}

// Validates a checkpoint read from disk before any of it is trusted. Beyond the per-field shape, the structural invariants the recorder writes by construction are checked: a non-empty stack rooted at depth 0, each frame exactly one deeper than its parent with the parent's instance id as its own, and the suspension invariant — a non-leaf frame is suspended on a child still running below it (pending without a recorded card), while the leaf is either active (no pending) or a parent whose child just returned (pending with the recorded card, written on role_finished). A file failing these is treated as corrupt and the run reconciles to interrupted rather than resuming into a broken stack.
export function isRunCheckpoint(value: unknown): value is RunCheckpoint {
	if (!isObject(value)) return false
	if (value.version !== 1) return false
	if (!isString(value.runId)) return false
	if (!isString(value.startTime)) return false
	if (!isNonNegativeInteger(value.registryCounter)) return false
	if (value.learnedContextCeiling !== undefined && !isNonNegativeNumber(value.learnedContextCeiling)) return false
	if (!Array.isArray(value.frames) || value.frames.length === 0) return false
	if (!value.frames.every(isCheckpointFrame)) return false
	const frames: CheckpointFrame[] = value.frames
	const root = frames[0]
	if (root === undefined || root.depth !== 0) return false
	for (let index = 0; index < frames.length; index++) {
		const frame = frames[index]
		if (frame === undefined) return false
		const isLeaf = index === frames.length - 1
		if (isLeaf) {
			if (frame.pending !== undefined && frame.pending.childCard === undefined) return false
		} else {
			if (frame.pending === undefined) return false
			if (frame.pending.childCard !== undefined) return false
		}
		if (index > 0) {
			const parent = frames[index - 1]
			if (parent === undefined) return false
			if (frame.depth !== parent.depth + 1) return false
			if (frame.parentRoleId !== parent.roleId) return false
		}
	}
	return true
}

export interface CheckpointRecorder {
	registerFrame(context: EngineContext, entry: RoleRegistryEntry): void
	unregisterFrame(roleId: string): void
	setPending(roleId: string, pending: PendingAgentSuspension | undefined): void
	setPendingChildCard(roleId: string, card: ResultCard): void
	write(): void
}

interface RecorderFrame {
	context: EngineContext
	entry: RoleRegistryEntry
	pending?: PendingAgentSuspension
}

export interface CheckpointRecorderDependencies {
	writeCheckpoint: WriteCheckpoint
	runId: string
	startTime: string
	// The prior-run lineage of the run being checkpointed, read from the entry frame when the run is resumed: post-resume contexts carry no live continuation (the briefing is already in the checkpointed history), so the recorder stamps the lineage onto depth-0 frames itself and a second restart still finds it.
	continuesFrom?: string
	roleRegistry: RoleRegistry
	contextPressureTracker: ContextPressureTracker
}

// The optional per-frame lineage source: a live context continuation on a fresh run, or the recorder's resume stamp when the context carries none.
function frameContinuesFrom(context: EngineContext, resumeStamp: string | undefined): string | undefined {
	if (context.depth !== 0) return undefined
	if (context.continuation !== undefined) return context.continuation.runId
	return resumeStamp
}

function serializeFrame(frame: RecorderFrame, resumeStamp: string | undefined): CheckpointFrame {
	const context = frame.context
	const entry = frame.entry
	// Only the entry frame carries the lineage: child and handler contexts inherit continuation through the context spread, but the resume path reads it from frames[0] alone, so writing it deeper would be noise.
	const continuesFrom = frameContinuesFrom(context, resumeStamp)
	return {
		roleId: entry.roleId,
		roleName: context.roleName,
		depth: context.depth,
		task: context.task,
		...(context.parent !== undefined ? { parent: context.parent } : {}),
		...(context.parentRoleId !== undefined ? { parentRoleId: context.parentRoleId } : {}),
		...(context.effort !== undefined ? { effort: context.effort } : {}),
		...(continuesFrom !== undefined ? { continuesFrom } : {}),
		...(entry.planAbort === true ? { planAbort: true } : {}),
		...(entry.planInjection !== undefined ? { planInjection: entry.planInjection } : {}),
		roleState: entry.roleState,
		...(frame.pending !== undefined ? { pending: frame.pending } : {}),
	}
}

// The per-run recorder every engine frame reports into. Frames hold live references (the registry entry's roleState), so a write reads the current state — including compaction edits a context handler made to a suspended role — and the synchronous serialize+write leaves no mutation window. While a handler invocation is on the stack writes are suppressed (see CheckpointFrame), which also means a handler's own frames and pendings are never serialized. Frames are re-ordered by depth at write time because resume registers leaf-first.
export function createCheckpointRecorder(dependencies: CheckpointRecorderDependencies): CheckpointRecorder {
	const frames = new Map<string, RecorderFrame>()
	let suspendedHandlerCount = 0

	function requireFrame(roleId: string): RecorderFrame {
		const frame = frames.get(roleId)
		if (frame === undefined) throw new Error(`checkpoint recorder: unknown role instance "${roleId}"`)
		return frame
	}

	return {
		registerFrame(context, entry) {
			frames.set(entry.roleId, { context, entry })
			if (context.handlerOf !== undefined) suspendedHandlerCount += 1
		},
		unregisterFrame(roleId) {
			const frame = requireFrame(roleId)
			if (frame.context.handlerOf !== undefined) suspendedHandlerCount -= 1
			frames.delete(roleId)
		},
		setPending(roleId, pending) {
			requireFrame(roleId).pending = pending
		},
		setPendingChildCard(roleId, card) {
			const frame = requireFrame(roleId)
			if (frame.pending === undefined) throw new Error(`checkpoint recorder: role instance "${roleId}" recorded a child card with no pending agent suspension`)
			frame.pending = { ...frame.pending, childCard: card }
		},
		write() {
			if (suspendedHandlerCount > 0) return
			const ordered = [...frames.values()].sort((a, b) => a.context.depth - b.context.depth)
			const checkpoint: RunCheckpoint = {
				version: 1,
				runId: dependencies.runId,
				startTime: dependencies.startTime,
				registryCounter: dependencies.roleRegistry.counter(),
				...(dependencies.contextPressureTracker.learnedCeiling !== undefined ? { learnedContextCeiling: dependencies.contextPressureTracker.learnedCeiling } : {}),
				frames: ordered.map((frame) => serializeFrame(frame, dependencies.continuesFrom)),
			}
			dependencies.writeCheckpoint(checkpoint)
		},
	}
}
