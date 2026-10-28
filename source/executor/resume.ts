import type { PendingInvocation, RunCheckpoint } from './checkpoint.js'
import { logEvent, type EngineContext, type EngineDependencies, type RunRole, type SuspendedTurn } from './engine-state.js'
import type { RoleOutcome } from './types.js'
import { roleCallId } from './invocation.js'
import type { LoadedGuild } from './loader.js'
import type { ParkedAnswer } from './park-state.js'
import { planStaleInvocationTerminals } from './stale-invocations.js'
import { suspendsChild } from './suspending-tools.js'

// What a resume injects into the re-entered leaf: the framed note of an error-or-suspended resume and/or the queue's answer to a parked ask.
export interface ResumeRoleStackOptions {
	resumeNote?: string
	parkedAnswer?: ParkedAnswer
	explicitResume?: boolean
}

interface RestoredPending {
	suspendedTurn?: SuspendedTurn
	pendingInvocation?: PendingInvocation
}

// A pending record whose child is still below it (or whose child card was already recorded) is a child suspension; everything else on the leaf is an ordinary invocation to reconcile. A leaf record with no child below it covers the crash after the pending checkpoint but before the child registered, so it is replayed like any other pending invocation.
function restorePending(frame: PendingInvocation, index: number, frameCount: number, resolveChildCard: () => Promise<RoleOutcome>): RestoredPending {
	const call = frame.toolCalls[frame.index]
	const childCall = call !== undefined && suspendsChild(call.function.name)
	const childStillBelow = index < frameCount - 1
	const recordedCard = frame.childCard
	if (recordedCard !== undefined || (childCall && childStillBelow)) {
		return {
			suspendedTurn: {
				toolCalls: frame.toolCalls,
				childIndex: frame.index,
				callId: frame.callId,
				parentCallId: frame.parentCallId,
				resolveChildCard: recordedCard !== undefined ? () => Promise.resolve({ kind: 'card', card: recordedCard }) : resolveChildCard,
			},
		}
	}
	return { pendingInvocation: frame }
}

// The resume driver: re-enters the checkpoint's role stack, letting the depth-first traversal continue. A frame with a pending child suspension resolves its child card lazily from inside the suspended turn — either the recorded card, or the next frame's own resume — so the stack re-forms in the same root-first order the live recursion produces. A leaf with an ordinary pending invocation re-enters at its loop top and reconciles it there, where the dispatch context exists.
// runRole is threaded in by the engine so this module can drive role turns without importing the turn loop at runtime (the executor composes the two).
// resumeNote rides an explicit resume of an errored or suspended run and is carried only by the leaf frame — the role whose loop entry precedes the run's first post-resume LLM call. parkedAnswer likewise rides only the leaf, the role that parked. Both are undefined for boot reconciliation.
export async function resumeRoleStack(runRole: RunRole, deps: EngineDependencies, loadedGuild: LoadedGuild, checkpoint: RunCheckpoint, options?: ResumeRoleStackOptions): Promise<RoleOutcome> {
	const resumeNote = options?.resumeNote
	const parkedAnswer = options?.parkedAnswer
	const explicitResume = options?.explicitResume
	// Seed the journal before any role terminal is written: resumed roles do not re-emit role_start, and their starts and any already-written tool terminals live in the existing log.
	const existingEvents = deps.readRunLogEvents(deps.runId)
	deps.invocationJournal.seedEvents(existingEvents)
	deps.invocationJournal.seedStartedCallIds(checkpoint.frames.map((frame) => roleCallId(frame.roleId)))
	const liveRoleCallIds = new Set(checkpoint.frames.map((frame) => roleCallId(frame.roleId)))
	const pendingCallIds = new Set<string>()
	for (const frame of checkpoint.frames) {
		if (frame.pending === undefined) continue
		pendingCallIds.add(frame.pending.callId)
	}
	// A parked ask is intentionally open until the queue answer arrives; it is not a stale crash remnant.
	if (checkpoint.parkedAsk !== undefined) pendingCallIds.add(checkpoint.parkedAsk.callId)
	// Handler and interrupt invocations are not checkpointed (handler writes are suppressed), so a crash inside one leaves only its starts in the log. Close those before any role re-enters; the role loop never sees them as live work.
	for (const terminal of planStaleInvocationTerminals(existingEvents, liveRoleCallIds, pendingCallIds)) {
		logEvent(deps.appendLog, terminal.type, terminal.payload)
		const callId = terminal.payload['callId']
		if (typeof callId === 'string') {
			deps.invocationJournal.markStarted(callId)
			deps.invocationJournal.markTerminal(callId)
		}
	}
	// The run's logging level is run-scoped and rides the entry frame alone (see checkpoint.ts serializeFrame); every resumed context re-threads it so engine-side readers — the inquiry briefing's run-log note — see the level no matter which frame re-enters.
	const runLogLevel = checkpoint.frames[0]?.logLevel
	const resumeAt = async (index: number): Promise<RoleOutcome> => {
		const frame = checkpoint.frames[index]
		if (frame === undefined) throw new Error(`resumeRoleStack: frame ${index} missing from a checkpoint with ${checkpoint.frames.length} frames`)
		const restored = frame.pending !== undefined
			? restorePending(frame.pending, index, checkpoint.frames.length, () => resumeAt(index + 1))
			: {}
		const context: EngineContext = {
			loadedGuild,
			depth: frame.depth,
			roleName: frame.roleName,
			task: frame.task,
			...(frame.parent !== undefined ? { parent: frame.parent } : {}),
			...(frame.parentRoleId !== undefined ? { parentRoleId: frame.parentRoleId } : {}),
			...(frame.effort !== undefined ? { effort: frame.effort } : {}),
			...(frame.involvement !== undefined ? { involvement: frame.involvement } : {}),
			...(runLogLevel !== undefined ? { logLevel: runLogLevel } : {}),
		}
		return await runRole(deps, context, {
			roleId: frame.roleId,
			roleState: frame.roleState,
			...(frame.planAbort === true ? { planAbort: true } : {}),
			...(frame.planInjection !== undefined ? { planInjection: frame.planInjection } : {}),
			...(index === checkpoint.frames.length - 1 && resumeNote !== undefined ? { resumeNote } : {}),
			...(index === checkpoint.frames.length - 1 && parkedAnswer !== undefined ? { parkedAnswer } : {}),
			...(explicitResume === true ? { explicitResume: true } : {}),
			...(restored.suspendedTurn !== undefined ? { suspendedTurn: restored.suspendedTurn } : {}),
			...(restored.pendingInvocation !== undefined ? { pendingInvocation: restored.pendingInvocation } : {}),
			...(index === checkpoint.frames.length - 1 && checkpoint.pendingInterlude !== undefined ? { pendingInterlude: checkpoint.pendingInterlude } : {}),
		})
	}
	return resumeAt(0)
}
