import { isErrorKind } from './errors.js'
import { suspendsChild } from './suspending-tools.js'
import { DEFAULT_LOG_LEVEL } from './log-level.js'
import { hasContinuationPrefixShape } from './context/context-policy.js'
import type { ContextPressureTracker } from './context/index.js'
import type { EngineContext, RoleState } from './engine-state.js'
import { isMessage, isToolCall } from './message-validation.js'
import type { RunBaseTracker } from './base-state.js'
import type { ParkedAsk, RunParkTracker } from './park-state.js'
import type { InterruptRequest } from './interrupts.js'
import type { WriteCheckpoint } from './persistence.js'
import type { RoleRegistry, RoleRegistryEntry } from './role-registry.js'
import type { EffortLevel, InvolvementLevel, LogLevel, OperatorPauseRecord, ResultCard, SuspensionRecord, ToolCall } from './types.js'
import { isRunIdShape } from './run-id.js'
import { classifyVersion, CHECKPOINT_FORMAT_VERSION } from './orchestration-version.js'
import { isEffortLevel, isInvolvementLevel, isLogLevel, isNonNegativeInteger, isNonNegativeNumber, isObject, isOperatorPauseRecord, isResultCard, isString, isSuspensionRecord, safeJsonParse } from './validation.js'

// The invocation a role is paused on mid-turn: its stable call id and parent, the turn's full tool-call list, and the index of the call being dispatched. The record covers ordinary tools and child-spawning tools alike; child-spawning calls additionally record the child's card once it returns so a resume delivers the recorded card instead of re-running the child. Calls before index are already in the persisted history; calls after it dispatch on resume.
export interface PendingInvocation {
	toolCalls: ToolCall[]
	index: number
	callId: string
	parentCallId: string
	childCard?: ResultCard
}

const INTERLUDE_TRIGGERS = ['loop_check', 'inquiry', 'context_pressure', 'context_budget_exceeded'] as const

export type InterludeTrigger = (typeof INTERLUDE_TRIGGERS)[number]

// The handler interlude a suspension interrupted. It is written before the handler runs, so the on-disk checkpoint plus this intent is enough to re-run the interlude from the target's pre-interlude state. Replay uses the trigger, target role, inquiry message, and queued operator requests; handler role and task are re-derived by the normal trigger path.
export interface PendingInterlude {
	targetRoleId: string
	trigger: InterludeTrigger
	details: Record<string, unknown>
	// Operator requests still queued when the handler started; they ride the pending interlude so a provider suspension cannot lose them.
	pendingOperatorRequests: InterruptRequest[]
}

// One live role invocation on the depth-first stack. Frames serialize root-first; a non-leaf frame is always suspended on a child-spawning call whose child still runs below it, and the leaf is active (no pending), dispatching an invocation (pending without a card), or a parent whose child just returned (pending carrying the recorded child card). Handler frames never appear: writes are suppressed while a handler runs. A suspension inside one is represented by pendingInterlude on the pre-interlude frame stack; the suspension checkpoint advances the registry counter past the failed handler subtree so its replay receives fresh ids.
export interface CheckpointFrame {
	roleId: string
	roleName: string
	depth: number
	task: string
	parent?: string
	parentRoleId?: string
	effort?: EffortLevel
	// Carried by frames whose context holds it — the entry context gets the run's involvement level from runExecutor and children inherit it through the context spread, so the resume path can restore it per frame (docs/reference.md "Involvement channel").
	involvement?: InvolvementLevel
	// Carried by frames whose context holds it — the entry context gets the run's logging level from runExecutor and children inherit it through the context spread, so the resume path can restore it per frame (docs/reference.md "Logging level").
	logLevel?: LogLevel
	// Set only on the entry frame: the prior run this run continues. The lineage id rides the checkpoint so a restart-resumed run still writes continuesFrom into its metas; the briefing itself is not carried because it is already baked into the frame's persisted history.
	continuesFrom?: string
	planAbort?: boolean
	planInjection?: string
	roleState: RoleState
	pending?: PendingInvocation
}

// The logging level a resumed run runs at: the entry frame carries the run's resolved level (docs/reference.md "Logging level"), and a checkpoint whose entry frame carries no logLevel falls back to full detail. Both the resume executor (which writes the metas) and the serve-side resume wrapper (which filters the run's log) derive the level here, so the metas a run records and the log filtering around it cannot disagree.
export function entryFrameLogLevel(entryFrame: CheckpointFrame | undefined): LogLevel {
	return entryFrame?.logLevel ?? DEFAULT_LOG_LEVEL
}

// The runnable state of a run, persisted so a service restart can resume it, so the queue answer can re-enter a parked run, and so the operator can explicitly resume an errored one. Written atomically (temp file + rename) at every leaf safe point, when a child card returns, before each dispatch (the pending invocation), and at a completed batch, then frozen once at a park, so the on-disk checkpoint is never torn and never leaves an in-flight invocation unnamed. `registryCounter` lets the resumed run mint fresh role-instance ids without colliding with the preserved ones; `learnedContextCeiling` carries the run's context-wall knowledge so resumed roles keep the tightened pressure threshold; `writeCapableStarted` carries the pre-write park rule's flag so a restart cannot reset it and park a run whose writes happened before the restart (docs/queueing.md "Parking: the pre-write rule"); `baseHash` carries the run's base commit so a restart keeps diffing against the same change set; `parkedAsk` identifies the parked turn the queue answer resumes; `pendingInterlude` marks a handler interlude whose replay is still owed.
export interface RunCheckpoint {
	version: typeof CHECKPOINT_FORMAT_VERSION
	runId: string
	startTime: string
	registryCounter: number
	learnedContextCeiling?: number
	writeCapableStarted?: boolean
	baseHash?: string
	// The parked ask this checkpoint was frozen for: the leaf role and the ask_human call whose result the queue answer will replace on resume (docs/queueing.md "Parking: the pre-write rule").
	parkedAsk?: ParkedAsk
	// The clarification answer already appended to the leaf history. The id makes delivery idempotent across a crash: a retry with the same id does not append the note again, and the queue compares it with the item's answer id to tell an undelivered answer from a re-pause. consumed is set once the resume wrote its running meta, so an answer that never started is retried.
	clarificationAnswer?: ClarificationAnswerDelivery
	// Present while a handler interlude is in flight. Its presence means a suspension or crash inside the handler; resume re-runs the interlude from the pre-interlude frame state.
	pendingInterlude?: PendingInterlude
	// The suspension the run has already decided to enter. Written with the suspension checkpoint before the suspended meta lands, so a crash in that window is still recognized as a suspension by startup reconciliation.
	suspension?: SuspensionRecord
	// The operator pause the run has already decided to enter, mutually exclusive with suspension. Written before the suspended meta lands so boot materializes the pause rather than resuming.
	pause?: OperatorPauseRecord
	frames: CheckpointFrame[]
}

export interface ClarificationAnswerDelivery {
	id: string
	question: string
	answer: string
	consumed?: true
}

function isParkedAsk(value: unknown): value is ParkedAsk {
	if (!isObject(value)) return false
	if (!isString(value.roleId) || value.roleId === '') return false
	// An empty model tool-call id is possible; the ask identity then lives in questionId/callId.
	if (!isString(value.toolCallId)) return false
	if (!isString(value.callId) || value.callId === '') return false
	if (!isString(value.questionId) || value.questionId === '') return false
	if (!isString(value.question) || value.question === '') return false
	return true
}

function isClarificationAnswerDelivery(value: unknown): value is ClarificationAnswerDelivery {
	if (!isObject(value)) return false
	if (!isString(value.id) || value.id === '') return false
	if (!isString(value.question) || value.question === '') return false
	if (!isString(value.answer)) return false
	if (value.consumed !== undefined && value.consumed !== true) return false
	return true
}

function isInterludeTrigger(value: unknown): value is InterludeTrigger {
	return typeof value === 'string' && INTERLUDE_TRIGGERS.some((trigger) => trigger === value)
}

function isInterruptRequest(value: unknown): value is InterruptRequest {
	if (!isObject(value)) return false
	if (value.kind !== 'inquiry' && value.kind !== 'plan_modification' && value.kind !== 'notice') return false
	return isString(value.message) && value.message !== ''
}

function isPendingInterlude(value: unknown): value is PendingInterlude {
	if (!isObject(value)) return false
	if (!isString(value.targetRoleId) || value.targetRoleId === '') return false
	if (!isInterludeTrigger(value.trigger)) return false
	if (!isObject(value.details)) return false
	if (!Array.isArray(value.pendingOperatorRequests) || !value.pendingOperatorRequests.every(isInterruptRequest)) return false
	if (value.trigger === 'inquiry') {
		const message = value.details['message']
		if (!isString(message) || message === '') return false
	}
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
	if (value.protectedPrefixLength !== 2 && value.protectedPrefixLength !== 4) return false
	if (value.history.length < 2) return false
	if (value.history[0]?.role !== 'system' || value.history[1]?.role !== 'user') return false
	if (value.protectedPrefixLength === 4 && !hasContinuationPrefixShape(value.history)) return false
	if (!isNonNegativeNumber(value.lastPromptTokens)) return false
	if (!Array.isArray(value.recentCompactionPromptTokens) || !value.recentCompactionPromptTokens.every(isNonNegativeNumber)) return false
	if (!Array.isArray(value.recentToolCalls) || !value.recentToolCalls.every(isRecentToolCall)) return false
	if (!isNonNegativeNumber(value.toolCallCount)) return false
	if (!isNonNegativeNumber(value.generatedTokens)) return false
	if (!isNonNegativeNumber(value.contextExceededAttempts)) return false
	if (!isNonNegativeNumber(value.loopCheckToolCallWatermark)) return false
	if (!isNonNegativeNumber(value.loopCheckTokenWatermark)) return false
	if (value.logSentBaseline !== undefined && !isNonNegativeInteger(value.logSentBaseline)) return false
	if (value.contextPressureNotice !== undefined && value.contextPressureNotice !== 'pending' && value.contextPressureNotice !== 'sent') return false
	if (value.contextCompactionPending !== undefined) {
		if (!isObject(value.contextCompactionPending)) return false
		if (!isNonNegativeNumber(value.contextCompactionPending.promptTokens)) return false
		if (!isNonNegativeNumber(value.contextCompactionPending.contextWindow)) return false
	}
	return true
}

function isPendingInvocation(value: unknown): value is PendingInvocation {
	if (!isObject(value)) return false
	if (!Array.isArray(value.toolCalls) || value.toolCalls.length === 0 || !value.toolCalls.every(isToolCall)) return false
	if (!isNonNegativeInteger(value.index) || value.index >= value.toolCalls.length) return false
	if (!isString(value.callId) || value.callId === '') return false
	if (!isString(value.parentCallId) || value.parentCallId === '') return false
	if (value.childCard !== undefined && !isResultCard(value.childCard)) return false
	const indexedCall = value.toolCalls[value.index]
	if (indexedCall === undefined) return false
	if (value.childCard !== undefined && !suspendsChild(indexedCall.function.name)) return false
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
	if (value.involvement !== undefined && !isInvolvementLevel(value.involvement)) return false
	if (value.logLevel !== undefined && !isLogLevel(value.logLevel)) return false
	if (value.continuesFrom !== undefined && !isRunIdShape(value.continuesFrom)) return false
	if (value.planAbort !== undefined && value.planAbort !== true) return false
	if (value.planInjection !== undefined && !isString(value.planInjection)) return false
	if (!isRoleState(value.roleState)) return false
	if (value.pending !== undefined && !isPendingInvocation(value.pending)) return false
	return true
}

// Validates a checkpoint read from disk before any of it is trusted. Beyond the per-field shape, the structural invariants the recorder writes by construction are checked: a non-empty stack rooted at depth 0, each frame exactly one deeper than its parent with the parent's instance id as its own, and the pending invariant — a non-leaf frame is suspended on a child-spawning call still running below it (pending without a recorded card); the leaf may be active (no pending), dispatching any invocation (pending without a card), or a parent whose child just returned (pending with the recorded card). A file failing these is treated as corrupt and the run reconciles to interrupted rather than resuming into a broken stack.
export function isRunCheckpoint(value: unknown): value is RunCheckpoint {
	if (!isObject(value)) return false
	if (classifyVersion(value, CHECKPOINT_FORMAT_VERSION) !== 'current') return false
	if (!isString(value.runId)) return false
	if (!isString(value.startTime)) return false
	if (!isNonNegativeInteger(value.registryCounter)) return false
	if (value.learnedContextCeiling !== undefined && !isNonNegativeNumber(value.learnedContextCeiling)) return false
	if (value.writeCapableStarted !== undefined && value.writeCapableStarted !== true) return false
	if (value.baseHash !== undefined && (!isString(value.baseHash) || value.baseHash === '')) return false
	if (value.parkedAsk !== undefined && !isParkedAsk(value.parkedAsk)) return false
	if (value.clarificationAnswer !== undefined && !isClarificationAnswerDelivery(value.clarificationAnswer)) return false
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
			// A leaf may be suspended on any invocation while its tool runs (the checkpoint is written before dispatch), or carry the recorded card of a child that just returned.
			if (frame.pending !== undefined && frame.pending.childCard !== undefined) {
				const indexedCall = frame.pending.toolCalls[frame.pending.index]
				if (indexedCall === undefined || !suspendsChild(indexedCall.function.name)) return false
			}
		} else {
			if (frame.pending === undefined) return false
			if (frame.pending.childCard !== undefined) return false
			const indexedCall = frame.pending.toolCalls[frame.pending.index]
			if (indexedCall === undefined || !suspendsChild(indexedCall.function.name)) return false
		}
		if (index > 0) {
			const parent = frames[index - 1]
			if (parent === undefined) return false
			if (frame.depth !== parent.depth + 1) return false
			if (frame.parentRoleId !== parent.roleId) return false
		}
	}
	const leaf = frames[frames.length - 1]
	if (leaf === undefined) return false
	if (value.pendingInterlude !== undefined) {
		if (!isPendingInterlude(value.pendingInterlude)) return false
		if (value.parkedAsk !== undefined) return false
		if (value.pendingInterlude.targetRoleId !== leaf.roleId) return false
		if (leaf.pending !== undefined) return false
	}
	if (value.suspension !== undefined && !isSuspensionRecord(value.suspension)) return false
	if (value.pause !== undefined && !isOperatorPauseRecord(value.pause)) return false
	if (value.pause !== undefined && value.suspension !== undefined) return false
	if (value.pause !== undefined && value.parkedAsk !== undefined) return false
	if (value.pause !== undefined && value.pendingInterlude !== undefined) return false
	if (value.pause !== undefined && leaf.pending !== undefined) return false
	const parkedAsk = value.parkedAsk
	if (parkedAsk === undefined) return true
	if (parkedAsk.roleId !== leaf.roleId) return false
	if (leaf.pending !== undefined) return false
	const history = leaf.roleState.history
	const last = history[history.length - 1]
	if (last === undefined) return false
	if (last.role !== 'tool' || last.tool_call_id !== parkedAsk.toolCallId) return false
	let foundAskCall = false
	for (const message of history) {
		if (message.role !== 'assistant' || message.tool_calls === undefined) continue
		for (const call of message.tool_calls) {
			if (call.id !== parkedAsk.toolCallId) continue
			foundAskCall = true
			if (call.function.name !== 'ask_human') return false
			const parsed = safeJsonParse(call.function.arguments)
			if (!parsed.ok || !isObject(parsed.value)) return false
			if (parsed.value['question'] !== parkedAsk.question) return false
		}
	}
	return foundAskCall
}

export interface CheckpointRecorder {
	registerFrame(context: EngineContext, entry: RoleRegistryEntry): void
	unregisterFrame(roleId: string): void
	setPending(roleId: string, pending: PendingInvocation | undefined): void
	setPendingChildCard(roleId: string, card: ResultCard): void
	setPendingInterlude(interlude: PendingInterlude | undefined): void
	setPendingOperatorRequests(requests: InterruptRequest[]): void
	setSuspension(record: SuspensionRecord | undefined): void
	setOperatorPause(record: OperatorPauseRecord | undefined): void
	hasActiveHandler(): boolean
	pendingInterludeTrigger(): InterludeTrigger | undefined
	// Returns whether a checkpoint was actually written: false when frozen or while a handler frame suppresses writes.
	write(): boolean
	// Persists the current stack and registry counter around a provider suspension, excluding handler frames (which are replayed, not resumed) and ignoring handler write suppression. This is the checkpoint that advances the counter past the failed handler subtree so its replay receives fresh ids.
	writeSuspension(): boolean
	// Persists the current stack and registry counter around an operator pause, with the same handler-exclusion rule as a suspension.
	writePause(): boolean
	// Pins the parked turn's checkpoint: later writes would lose the ask result as ancestors unwind and finish, and the answer resume needs exactly that state. Idempotent.
	freeze(): void
	// Releases the pin when the answer resume replaces the parked turn's result, so the post-answer state can be checkpointed. Idempotent.
	unfreeze(): void
}

interface RecorderFrame {
	context: EngineContext
	entry: RoleRegistryEntry
	pending?: PendingInvocation
}

export interface CheckpointRecorderDependencies {
	writeCheckpoint: WriteCheckpoint
	runId: string
	startTime: string
	// The prior-run lineage of the run being checkpointed, read from the entry frame when the run is resumed: post-resume contexts carry no live continuation (the briefing is already in the checkpointed history), so the recorder stamps the lineage onto depth-0 frames itself and a second restart still finds it.
	continuesFrom?: string
	roleRegistry: RoleRegistry
	contextPressureTracker: ContextPressureTracker
	// The run's park state (docs/queueing.md "Parking: the pre-write rule"): the write-capability flag rides the checkpoint like learnedContextCeiling rides the pressure tracker.
	parkTracker: RunParkTracker
	// The run's base commit state: the hash rides the checkpoint so a restart keeps diffing against the same change set.
	baseTracker: RunBaseTracker
	// The clarification answer already appended on the resume path: later safe-point writes must preserve it so a re-pause still lets the queue recognize a delivered answer.
	clarificationAnswer?: ClarificationAnswerDelivery
}

// The optional per-frame lineage source: a live context continuation on a fresh run, or the recorder's resume stamp when the context carries none. A continuation without a runId carries only the queue briefing — no lineage, so meta stays honest.
function frameContinuesFrom(context: EngineContext, resumeStamp: string | undefined): string | undefined {
	if (context.depth !== 0) return undefined
	if (context.continuation?.runId !== undefined) return context.continuation.runId
	return resumeStamp
}

function serializeFrame(frame: RecorderFrame, resumeStamp: string | undefined): CheckpointFrame {
	const context = frame.context
	const entry = frame.entry
	// Only the entry frame carries the lineage: child and handler contexts inherit continuation through the context spread, but the resume path reads it from frames[0] alone, so writing it deeper would be noise.
	const continuesFrom = frameContinuesFrom(context, resumeStamp)
	// The logging level is stamped from the entry context only: it is run-scoped, the resume path reads it from frames[0] (like the lineage), and the resumed run re-threads it onto every context from there.
	const logLevel = context.depth === 0 ? context.logLevel : undefined
	return {
		roleId: entry.roleId,
		roleName: context.roleName,
		depth: context.depth,
		task: context.task,
		...(context.parent !== undefined ? { parent: context.parent } : {}),
		...(context.parentRoleId !== undefined ? { parentRoleId: context.parentRoleId } : {}),
		...(context.effort !== undefined ? { effort: context.effort } : {}),
		...(context.involvement !== undefined ? { involvement: context.involvement } : {}),
		...(logLevel !== undefined ? { logLevel } : {}),
		...(continuesFrom !== undefined ? { continuesFrom } : {}),
		...(entry.planAbort === true ? { planAbort: true } : {}),
		...(entry.planInjection !== undefined ? { planInjection: entry.planInjection } : {}),
		roleState: entry.roleState,
		...(frame.pending !== undefined ? { pending: frame.pending } : {}),
	}
}

// The per-run recorder every engine frame reports into. Frames hold live references (the registry entry's roleState), so a write reads the current state — including compaction edits a context handler made to a suspended role — and the synchronous serialize+write leaves no mutation window. While a handler invocation is on the stack ordinary writes are suppressed (see CheckpointFrame), so handler frames are never serialized; a suspension write deliberately bypasses suppression to persist the pending interlude and the advanced registry counter, excluding handler frames; a freeze pins the park checkpoint so the unwinding ancestors cannot overwrite it. Frames are re-ordered by depth at write time because resume registers leaf-first.
export function createCheckpointRecorder(dependencies: CheckpointRecorderDependencies): CheckpointRecorder {
	const frames = new Map<string, RecorderFrame>()
	let pendingInterlude: PendingInterlude | undefined
	let suspension: SuspensionRecord | undefined
	let pause: OperatorPauseRecord | undefined
	let preInterludeFrames: CheckpointFrame[] | undefined
	let suspendedHandlerCount = 0
	let frozen = false

	function cloneFrames(frames: CheckpointFrame[]): CheckpointFrame[] {
		const copy: unknown = JSON.parse(JSON.stringify(frames))
		if (!Array.isArray(copy) || !copy.every(isCheckpointFrame)) throw new Error('checkpoint recorder: could not snapshot the pre-interlude frames')
		return copy
	}

	function writeCheckpoint(mode: 'ordinary' | 'suspension' | 'pause'): boolean {
		if (frozen) return false
		if (mode === 'ordinary' && suspendedHandlerCount > 0) return false
		const ordered = [...frames.values()].filter((frame) => mode === 'ordinary' || frame.context.handlerOf === undefined).sort((a, b) => a.context.depth - b.context.depth)
		const checkpoint: RunCheckpoint = {
			version: CHECKPOINT_FORMAT_VERSION,
			runId: dependencies.runId,
			startTime: dependencies.startTime,
			registryCounter: dependencies.roleRegistry.counter(),
			...(dependencies.contextPressureTracker.learnedCeiling !== undefined ? { learnedContextCeiling: dependencies.contextPressureTracker.learnedCeiling } : {}),
			...(dependencies.parkTracker.writeCapableStarted ? { writeCapableStarted: true } : {}),
			...(dependencies.baseTracker.baseHash !== undefined ? { baseHash: dependencies.baseTracker.baseHash } : {}),
			...(dependencies.parkTracker.parkedAsk !== undefined ? { parkedAsk: dependencies.parkTracker.parkedAsk } : {}),
			...(dependencies.clarificationAnswer !== undefined ? { clarificationAnswer: dependencies.clarificationAnswer } : {}),
			...(pendingInterlude !== undefined ? { pendingInterlude } : {}),
			...(suspension !== undefined ? { suspension } : {}),
			...(pause !== undefined ? { pause } : {}),
			frames: (mode === 'suspension' || mode === 'pause') && pendingInterlude !== undefined && preInterludeFrames !== undefined ? preInterludeFrames : ordered.map((frame) => serializeFrame(frame, dependencies.continuesFrom)),
		}
		if (pendingInterlude === undefined) preInterludeFrames = undefined
		else if (mode === 'ordinary') preInterludeFrames = cloneFrames(checkpoint.frames)
		dependencies.writeCheckpoint(checkpoint)
		return true
	}

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
			if (frame.pending === undefined) throw new Error(`checkpoint recorder: role instance "${roleId}" recorded a child card with no pending child suspension`)
			frame.pending = { ...frame.pending, childCard: card }
		},
		setPendingInterlude(interlude) {
			pendingInterlude = interlude
		},
		setPendingOperatorRequests(requests) {
			if (pendingInterlude !== undefined) pendingInterlude = { ...pendingInterlude, pendingOperatorRequests: requests }
		},
		setSuspension(record) {
			suspension = record
		},
		setOperatorPause(record) {
			pause = record
		},
		hasActiveHandler() {
			return suspendedHandlerCount > 0
		},
		pendingInterludeTrigger() {
			return pendingInterlude?.trigger
		},
		write() {
			return writeCheckpoint('ordinary')
		},
		writeSuspension() {
			return writeCheckpoint('suspension')
		},
		writePause() {
			return writeCheckpoint('pause')
		},
		freeze() {
			frozen = true
		},
		unfreeze() {
			frozen = false
		},
	}
}
