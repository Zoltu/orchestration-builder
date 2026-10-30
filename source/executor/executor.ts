import { DEFAULT_EFFORT } from './effort.js'
import { DEFAULT_INVOLVEMENT } from './involvement.js'
import type { OperatorPauseRecord, ResultCard, RunContinuation, RunMeta, RunOptions, SuspensionRecord } from './types.js'
import { createCheckpointRecorder, entryFrameLogLevel, type ClarificationAnswerDelivery, type RunCheckpoint } from './checkpoint.js'
import { createContextPressureTracker } from './context/index.js'
import type { RunBaseTracker } from './base-state.js'
import { clarificationAnswerNote, createRunParkTracker, type ParkedAnswer, type ParkedAsk } from './park-state.js'
import { EMPTY_TREE_HASH } from './git-primitives.js'
import { formatWorkspaceGitNotice, type ReadWorkspaceGitState } from './git-state.js'
import { runRole } from './engine.js'
import { logEvent, type EngineContext, type EngineDependencies } from './engine-state.js'
import { createInvocationJournal, humanAnswerPayload, toolCallId } from './invocation.js'
import type { HumanBackend } from './human-backend.js'
import type { InterruptQueue } from './interrupts.js'
import type { OperatorPauseQueue } from './operator-pause.js'
import type { LlmCaller } from './llm.js'
import type { LoadedGuild } from './loader.js'
import type { AppendLog, DeleteCheckpoint, ReadRunLogEvents, RunDirectory, WriteCheckpoint, WriteMeta } from './persistence.js'
import type { ReadProjectDoc } from './project-docs.js'
import { resumeRoleStack } from './resume.js'
import { createRoleRegistry } from './role-registry.js'
import type { RoleSnapshotStore } from './role-snapshot.js'
import type { ToolPlatform } from './tool-platform-port.js'
import type { RoleDelta } from './stream-channel.js'

export interface ExecutorDependencies {
	llmCaller: LlmCaller
	appendLog: AppendLog
	toolPlatform: ToolPlatform
	humanBackend: HumanBackend
	// The service-bound, resolved guild (the LoadedGuild constructed at startup, deployment included); not the loader's file-shaped LoadGuild, which the startup path completes first. The name deliberately differs from LoadGuild: the loader reads files, this field carries the already-loaded guild.
	loadedGuild: LoadedGuild
	createRunDirectory: RunDirectory
	writeMeta: WriteMeta
	writeCheckpoint: WriteCheckpoint
	deleteCheckpoint: DeleteCheckpoint
	// The run's interrupt queue, created by the caller so the service API can submit operator interrupts while the run is in flight; the engine drains it at turn boundaries. The role registry is run-internal and created here.
	interruptQueue: InterruptQueue
	// The run's operator-pause request channel, created by the caller and bound to the shared pause channel while the run is active.
	operatorPauseQueue: OperatorPauseQueue
	// Best-effort cleanup of the durable pause-request marker after every settlement, so a stale intent cannot pause a later run.
	deletePauseRequest: () => void
	// The run-scoped streaming-delta publisher, provided by the caller (bound to the shared delta channel in serve.ts); the engine stamps every streamed text delta with the publishing role. Required like the rest of the run-scoped leaves.
	publishDelta: (delta: RoleDelta) => void
	// The per-run store of finished child conversations, so a parent can continue a finished child as a new seeded instance.
	roleSnapshots: RoleSnapshotStore
	// The leaf that reads a role's declared projectDocs from the workspace (project-docs.ts), closed over the workspace root by the service. Rides into EngineDependencies so buildInitialHistory can inject the entry role's project-context block at run start.
	readProjectDoc: ReadProjectDoc
	// The run's existing log events, read at resume so a pending invocation whose terminal was already durable is reconciled without re-dispatching or duplicating the terminal.
	readRunLogEvents: ReadRunLogEvents
	// The run-scoped base commit state, created by the caller so the service can share it with the git tool handlers; runExecutor records the starting base and resumeExecutor restores it from the checkpoint.
	baseTracker: RunBaseTracker
	// The leaf that reads the workspace's git state once at run start (git-state.ts), closed over the workspace root by the service. runExecutor uses it to record the base and build the entry role's git notice.
	readWorkspaceGitState: ReadWorkspaceGitState
}

// The per-run identity and restore state buildEngineDependencies threads into the engine. A fresh run supplies only runId/startTime/registryCounter plus its continuation and queue flags; the resume path additionally restores the checkpoint's learned ceiling, write-capability flag, base, and — on the queue's answer resume — the parked ask it is delivering into.
interface EngineDependencyInput {
	runId: string
	startTime: string
	registryCounter: number
	learnedContextCeiling?: number
	writeCapableStarted?: boolean
	continuesFrom?: string
	queueTracked?: boolean
	baseHash?: string
	parkedAsk?: ParkedAsk
	clarificationAnswer?: ClarificationAnswerDelivery
	priorSuspension?: SuspensionRecord
}

function buildEngineDependencies(deps: ExecutorDependencies, input: EngineDependencyInput): EngineDependencies {
	const roleRegistry = createRoleRegistry(input.registryCounter)
	const contextPressureTracker = createContextPressureTracker(input.learnedContextCeiling)
	// The resume path seeds the park tracker from the checkpoint so a restart cannot reset the write-capability flag and park a run whose writes happened before the restart (docs/queueing.md "Parking: the pre-write rule"). The queue-tracking mark is restored only by the queue's answer resume: boot and explicit error-or-suspended resumes stay untracked, so their pre-write asks block on /api/answer instead of parking into a question the queue does not know.
	const parkTracker = createRunParkTracker(input.writeCapableStarted, input.queueTracked)
	if (input.parkedAsk !== undefined) parkTracker.parkedAsk = input.parkedAsk
	// The resume path restores the base from the checkpoint so a restart keeps diffing against the same change set; a fresh run records it after reading the workspace's git state.
	if (deps.baseTracker.baseHash === undefined && input.baseHash !== undefined) deps.baseTracker.baseHash = input.baseHash
	return {
		llmCaller: deps.llmCaller,
		appendLog: deps.appendLog,
		runId: input.runId,
		readRunLogEvents: deps.readRunLogEvents,
		toolPlatform: deps.toolPlatform,
		invocationJournal: createInvocationJournal(deps.appendLog),
		humanBackend: deps.humanBackend,
		roleRegistry,
		interruptQueue: deps.interruptQueue,
		operatorPauseQueue: deps.operatorPauseQueue,
		contextPressureTracker,
		publishDelta: deps.publishDelta,
		roleSnapshots: deps.roleSnapshots,
		readProjectDoc: deps.readProjectDoc,
		parkTracker,
		baseTracker: deps.baseTracker,
		// The run's lineage rides the recorder so checkpoints written after a resume keep stamping continuesFrom onto the entry frame — the live context does not carry it on the resume path. The logging level needs no such stamp: the entry context carries it and the recorder serializes from there.
		...(input.priorSuspension !== undefined ? { priorSuspension: input.priorSuspension } : {}),
		checkpointRecorder: createCheckpointRecorder({ writeCheckpoint: deps.writeCheckpoint, runId: input.runId, startTime: input.startTime, roleRegistry, contextPressureTracker, parkTracker, baseTracker: deps.baseTracker, continuesFrom: input.continuesFrom, ...(input.clarificationAnswer !== undefined ? { clarificationAnswer: input.clarificationAnswer } : {}) }),
	}
}

// The one composer for the executor's meta writes: identity fields map from the run's options (the optional ones spread only when present), the caller pins the status and start time, and a terminal write passes the result card, which fixes the end time at composition. The running writes and the terminal write all compose here so the optional-field mapping is spelled once.
function composeRunMeta(options: RunOptions, startTime: string, status: RunMeta['status'], result?: ResultCard, suspension?: SuspensionRecord, pause?: OperatorPauseRecord): RunMeta {
	return {
		runId: options.runId,
		guildPath: options.guildPath,
		...(options.benchmarkPath !== undefined ? { benchmarkPath: options.benchmarkPath } : {}),
		task: options.task,
		effort: options.effort,
		involvement: options.involvement,
		...(options.logLevel !== undefined ? { logLevel: options.logLevel } : {}),
		// Only a genuine continuation stamps the lineage: a briefing-only continuation (a first queue dispatch) has no prior run, and meta.continuesFrom must stay honest.
		...(options.continuation?.runId !== undefined ? { continuesFrom: options.continuation.runId } : {}),
		status,
		...(suspension !== undefined ? { suspension } : {}),
		...(pause !== undefined ? { pause } : {}),
		startTime,
		...(result === undefined ? {} : { endTime: new Date().toISOString(), result }),
	}
}

// A needs_clarification terminal is always a pause — a parked ask or a direct finish — so its checkpoint is kept for the answer resume; an unwanted checkpoint is deleted only for true completions. An error and a suspension also keep their checkpoints: the former for explicit error-resume, the latter for provider recovery.
function shouldKeepCheckpoint(status: RunMeta['status']): boolean {
	return status === 'error' || status === 'needs_clarification' || status === 'suspended'
}

export async function runExecutor(deps: ExecutorDependencies, options: RunOptions): Promise<RunMeta> {
	deps.createRunDirectory()

	const loadedGuild = deps.loadedGuild

	const startTime = new Date().toISOString()
	// effort_set and involvement_set are logged once at run start so the trace records the chosen levels before the entry role begins.
	logEvent(deps.appendLog, 'effort_set', { effort: options.effort })
	logEvent(deps.appendLog, 'involvement_set', { involvement: options.involvement })
	// Write a running meta before the entry role begins so the UI can show the task, run id, and start time while the run is in progress, rather than only after completion. It is overwritten with the terminal meta below.
	deps.writeMeta(composeRunMeta(options, startTime, 'running'))
	const engineDeps = buildEngineDependencies(deps, { runId: options.runId, startTime, registryCounter: 0, continuesFrom: options.continuation?.runId, queueTracked: options.queueTracked })
	// The workspace's git state is read once, before the entry role's history is built: it records the default base (HEAD, or the empty tree when HEAD is unborn) and supplies the entry role's git notice. A workspace with no repository simply records no base and injects no notice.
	const gitState = await deps.readWorkspaceGitState()
	if (gitState.isRepository) {
		if (deps.baseTracker.baseHash === undefined) {
			const initialBase = gitState.unbornHead ? EMPTY_TREE_HASH : gitState.headHash
			if (initialBase !== undefined) deps.baseTracker.baseHash = initialBase
		}
		if (gitState.uncommittedPaths.length > 0) {
			logEvent(deps.appendLog, 'workspace_dirty_at_start', { count: gitState.uncommittedPaths.length })
		}
	}
	// The notice is undefined when there is no repository, so a non-repository workspace injects nothing rather than a "not a git repository" line.
	const workspaceGitNotice = formatWorkspaceGitNotice(gitState)
	const entryContext: EngineContext = {
		loadedGuild,
		depth: 0,
		roleName: loadedGuild.config.entryRole,
		task: options.task,
		effort: options.effort,
		involvement: options.involvement,
		...(options.logLevel !== undefined ? { logLevel: options.logLevel } : {}),
		...(options.continuation !== undefined ? { continuation: options.continuation } : {}),
		...(workspaceGitNotice !== undefined ? { workspaceGitNotice } : {}),
	}
	const outcome = await runRole(engineDeps, entryContext)

	const meta = outcome.kind === 'suspended'
		? composeRunMeta(options, startTime, 'suspended', undefined, outcome.suspension)
		: outcome.kind === 'operator_paused'
			? composeRunMeta(options, startTime, 'suspended', undefined, undefined, outcome.pause)
			: composeRunMeta(options, startTime, outcome.card.status, outcome.card)

	deps.writeMeta(meta)
	deps.deletePauseRequest()
	// The terminal meta is the authoritative record, and the checkpoint is removed so a restart never considers resuming a finished run — except when the terminal status is 'error' (the operator can explicitly resume it with its full context, docs/queueing.md "Resume of an errored or suspended run"), a needs_clarification pause (a parked ask or a direct finish) that the queue answer re-enters, or a suspension whose checkpoint is kept for provider recovery. Startup reconciliation auto-resumes only running metas and transient checkpoint suspensions; operator-resume suspensions are materialized as suspended.
	if (!shouldKeepCheckpoint(meta.status)) deps.deleteCheckpoint()

	return meta
}

export interface ResumeRunOptions {
	guildPath: string
	benchmarkPath?: string
	// The framed operator note on an explicit resume of an errored or suspended run; the resumed leaf role's loop entry appends it to the restored history (see resumeRoleStack). Absent for boot reconciliation, which injects nothing.
	operatorNote?: string
	// The queue's answer to the parked ask, delivered into the existing ask_human tool result before the parked turn continues.
	parkedAnswer?: ParkedAnswer
	// The queue's answer to a direct-finish needs_clarification (no parkedAsk): delivered as a framed note that names both the question and the answer. The id makes delivery idempotent across a crash.
	clarificationAnswer?: ClarificationAnswerDelivery
	// Restored only by the queue's answer resume: it keeps the resumed run's park behavior live. Boot reconciliation and the explicit error-or-suspended resume stay untracked, so their asks block on /api/answer.
	queueTracked?: boolean
	// The suspension the run is resuming from; carried into the engine so a re-suspension increments its attempt count.
	priorSuspension?: SuspensionRecord
	// Set only by the operator-driven error-or-suspended resume, never by boot reconciliation: an explicit resume must continue to a fresh LLM turn even when the checkpoint already ends with a completed finish.
	explicitResume?: boolean
}

// Resumes a run from its checkpoint after a service restart. The run's identity (run id, task, effort, involvement, log level, start time) comes from the checkpoint — the meta keeps the original startTime so elapsed-time accounting survives the restart. The stack is reconstructed by resumeRoleStack and the run continues from the suspended leaf.
export async function resumeExecutor(deps: ExecutorDependencies, checkpoint: RunCheckpoint, options: ResumeRunOptions): Promise<RunMeta> {
	const entryFrame = checkpoint.frames[0]
	if (entryFrame === undefined) throw new Error(`resumeExecutor: checkpoint for run ${checkpoint.runId} has no frames`)
	const parkedAsk = checkpoint.parkedAsk
	if (options.clarificationAnswer !== undefined) {
		if (parkedAsk !== undefined) throw new Error(`resumeExecutor: run ${checkpoint.runId} has a parked ask and must be resumed through the parked-answer path`)
		if (options.parkedAnswer !== undefined) throw new Error(`resumeExecutor: run ${checkpoint.runId} cannot receive both a parked answer and a clarification answer`)
	}
	if (parkedAsk !== undefined && options.parkedAnswer === undefined) throw new Error(`resumeExecutor: run ${checkpoint.runId} parked on "${parkedAsk.question}" and must be resumed with its answer`)
	if (options.parkedAnswer !== undefined) {
		if (parkedAsk === undefined) throw new Error(`resumeExecutor: run ${checkpoint.runId} has no parked ask for the supplied answer`)
		if (options.parkedAnswer.question !== parkedAsk.question) throw new Error(`resumeExecutor: answer question does not match the parked question for run ${checkpoint.runId}`)
		if (options.parkedAnswer.toolCallId !== parkedAsk.toolCallId) throw new Error(`resumeExecutor: answer tool call does not match the parked call for run ${checkpoint.runId}`)
		const leafFrame = checkpoint.frames[checkpoint.frames.length - 1]
		if (leafFrame === undefined || leafFrame.roleId !== parkedAsk.roleId) throw new Error(`resumeExecutor: parked role ${parkedAsk.roleId} is not the checkpoint leaf for run ${checkpoint.runId}`)
	}
	const task = entryFrame.task
	const effort = entryFrame.effort ?? DEFAULT_EFFORT
	const involvement = entryFrame.involvement ?? DEFAULT_INVOLVEMENT
	const logLevel = entryFrameLogLevel(entryFrame)
	// The checkpoint carries the lineage id only (not the prior task or outcome): on resume the entry role's history — the prior turns and the new user message included — is restored from the checkpoint verbatim, so the full outcome is not recomposed and the empty task/summary here exist only so the metas keep the continuesFrom field.
	const continuation: RunContinuation | undefined = entryFrame.continuesFrom !== undefined ? { runId: entryFrame.continuesFrom, task: '', summary: '' } : undefined
	const runOptions: RunOptions = {
		runId: checkpoint.runId,
		guildPath: options.guildPath,
		...(options.benchmarkPath !== undefined ? { benchmarkPath: options.benchmarkPath } : {}),
		task,
		effort,
		involvement,
		logLevel,
		...(continuation !== undefined ? { continuation } : {}),
	}

	// No createRunDirectory here: a resume re-enters the run directory the checkpoint was read from, which therefore exists — and createRunDirectory refuses existing directories because a fresh run must never share one.

	const loadedGuild = deps.loadedGuild

	const startTime = checkpoint.startTime
	const priorSuspension = options.priorSuspension ?? checkpoint.suspension
	const clarificationAnswer = options.clarificationAnswer
	// The clarification answer is appended durably before the running meta: a crash after the meta would otherwise let reconciliation resume a checkpoint without the answer. The id makes a retry idempotent, and the note is then already in the restored history. A delivery record already on the checkpoint is also carried forward on boot and error-or-suspended resumes, so a consumed answer is not lost on their first safe-point write.
	let deliveredAnswer = checkpoint.clarificationAnswer
	let appendedThisResume = false
	let resumeNote = options.operatorNote
	if (clarificationAnswer !== undefined) {
		if (deliveredAnswer?.id !== clarificationAnswer.id) {
			const leafFrame = checkpoint.frames[checkpoint.frames.length - 1]
			if (leafFrame === undefined) throw new Error(`resumeExecutor: checkpoint for run ${checkpoint.runId} has no leaf frame`)
			leafFrame.roleState.history.push({ role: 'user', content: clarificationAnswerNote(clarificationAnswer.question, clarificationAnswer.answer) })
			deliveredAnswer = { id: clarificationAnswer.id, question: clarificationAnswer.question, answer: clarificationAnswer.answer }
			checkpoint.clarificationAnswer = deliveredAnswer
			deps.writeCheckpoint(checkpoint)
			appendedThisResume = true
		}
		resumeNote = undefined
	}
	// A suspension recorded in the checkpoint but never written into the meta (a crash in that window) is cleared before the running meta lands, while its record is carried forward as the prior suspension for attempt accounting.
	if (checkpoint.suspension !== undefined) {
		checkpoint.suspension = undefined
		deps.writeCheckpoint(checkpoint)
	}
	// The pause copy covers a crash in the meta-write window; clear it before the running meta lands so a resumed run is not mistaken for a still-paused one.
	if (checkpoint.pause !== undefined) {
		checkpoint.pause = undefined
		deps.writeCheckpoint(checkpoint)
	}
	// run_resumed marks the restart boundary in the log: events before it belong to the pre-restart process, events after it to the resumed run. Resumed roles do not re-emit role_start, so a reviewer can tell why. An explicit error-or-suspended resume stamps the operator's note on the boundary so the log shows the human intervention as well.
	logEvent(deps.appendLog, 'run_resumed', { runId: checkpoint.runId, resumedFrames: checkpoint.frames.length, ...(options.operatorNote !== undefined ? { operatorNote: options.operatorNote } : {}) })
	// A clarification answer rides the same human_answer event as a parked answer, with a synthetic id. It is logged after the boundary and the durable write, and only when this resume actually appended the note — an idempotent replay has nothing new to log.
	if (clarificationAnswer !== undefined && appendedThisResume) logEvent(deps.appendLog, 'human_answer', humanAnswerPayload('clarification', toolCallId('clarification'), clarificationAnswer.answer, clarificationAnswer.question))
	// Re-assert the running meta: the pre-restart write may never have landed, and the terminal meta overwrites it below either way. On an explicit error-or-suspended resume this same write flips the run's terminal error card or suspension back to running — the old record belongs to the log, not the live meta.
	deps.writeMeta(composeRunMeta(runOptions, startTime, 'running'))
	// Once the running meta is written the run has started and consumed the note; later recorder writes persist this so the queue can distinguish it from an answer checkpointed just before a crash.
	if (deliveredAnswer !== undefined) deliveredAnswer.consumed = true
	const engineDeps = buildEngineDependencies(deps, { runId: checkpoint.runId, startTime, registryCounter: checkpoint.registryCounter, learnedContextCeiling: checkpoint.learnedContextCeiling, writeCapableStarted: checkpoint.writeCapableStarted, continuesFrom: entryFrame.continuesFrom, baseHash: checkpoint.baseHash, ...(priorSuspension !== undefined ? { priorSuspension } : {}), ...(options.parkedAnswer !== undefined && parkedAsk !== undefined ? { parkedAsk } : {}), ...(deliveredAnswer !== undefined ? { clarificationAnswer: deliveredAnswer } : {}), ...(options.queueTracked === true ? { queueTracked: true } : {}) })
	const result = await resumeRoleStack(
		runRole,
		engineDeps,
		loadedGuild,
		checkpoint,
		{ ...(resumeNote !== undefined ? { resumeNote } : {}), ...(options.parkedAnswer !== undefined ? { parkedAnswer: options.parkedAnswer } : {}), ...(options.explicitResume === true ? { explicitResume: true } : {}) },
	)

	const meta = result.kind === 'suspended'
		? composeRunMeta(runOptions, startTime, 'suspended', undefined, result.suspension)
		: result.kind === 'operator_paused'
			? composeRunMeta(runOptions, startTime, 'suspended', undefined, undefined, result.pause)
			: composeRunMeta(runOptions, startTime, result.card.status, result.card)

	deps.writeMeta(meta)
	deps.deletePauseRequest()
	// Same checkpoint rule as the fresh-run path: an error, a needs_clarification pause, or a suspended outcome stays resumable from its checkpoint; every other terminal status cleans up.
	if (!shouldKeepCheckpoint(meta.status)) deps.deleteCheckpoint()

	return meta
}
