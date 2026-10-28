import { isRunCheckpoint, type RunCheckpoint } from './checkpoint.js'
import { DEFAULT_EFFORT } from './effort.js'
import { DEFAULT_INVOLVEMENT } from './involvement.js'
import { DEFAULT_LOG_LEVEL } from './log-level.js'
import type { ParkedAnswer, PauseState } from './park-state.js'
import { isRunMeta, safeJsonParse } from './validation.js'
import type { EffortLevel, InvolvementLevel, LogEvent, LogLevel, RunContinuation, RunMeta, SuspensionRecord } from './types.js'
import type { SuspendedRunResumeResult } from './suspension.js'
import { planStaleInvocationTerminals } from './stale-invocations.js'
import type { AppendLog, DeleteCheckpoint, ReadProjectSettings, ReadRunCheckpointById, ReadRunLogEvents, ReadRunMetaById, RunDirectoryExists, WriteMeta } from './persistence.js'

// Every fresh run is started through submit, and submit is called only by the scheduler's dispatch path (the queue is universal — docs/queueing.md "Dispatch and the scheduler"), so the submission layer marks every started run queue-tracked: the bit that gates the pre-write park (docs/queueing.md "Parking: the pre-write rule"). The mark does not survive a restart (it does not ride the checkpoint), so a boot-resumed run keeps today's blocking ask behavior.
export type StartRun = (runId: string, task: string, effort: EffortLevel, involvement: InvolvementLevel, logLevel: LogLevel, continuation: RunContinuation | undefined, queueTracked: boolean) => Promise<RunMeta>
export interface ResumeRunInvocation {
	resumeNote?: string
	// Explicit operator-driven error or suspended resume; boot reconciliation leaves this unset.
	explicitResume?: boolean
	parkedAnswer?: ParkedAnswer
	clarificationAnswer?: { id: string; question: string; answer: string }
	queueTracked?: boolean
	// The suspension a suspended run is resuming from, so a re-suspension keeps its attempt accounting.
	priorSuspension?: SuspensionRecord
}
export type ResumeRun = (checkpoint: RunCheckpoint, options?: ResumeRunInvocation) => Promise<RunMeta>

// The provider-recovery owner is the single authority for the suspended run id and its binding: submission reads it before starting work and reports a new suspension before clearing the active slot.
export interface ProviderSuspensionOwner {
	suspendedRunId(): string | undefined
	adoptSuspendedRun(runId: string): void
	noticeSuspension(meta: RunMeta): void
	releaseSuspension(runId: string): void
}

export interface RunSubmissionDependencies {
	providerSuspension: ProviderSuspensionOwner
	startRun: StartRun
	resumeRun: ResumeRun
	generateRunId: () => string
	// Whether a run directory already exists for an id on disk: run ids have one-second resolution, so a fresh id can collide with the directory of a previous run that failed instantly. Submit refuses such ids (a collision would interleave the two runs' logs and metas); resume re-enters an existing directory by design and never consults this.
	runDirectoryExists: RunDirectoryExists
	readProjectSettings: ReadProjectSettings
	// The deployment file's involvement default (deployment.json "executor"."defaultInvolvement"), resolved once at startup: the lowest-priority input of the involvement resolution chain, below the per-run override and the project setting.
	deploymentInvolvement?: InvolvementLevel
	// The deployment file's logging default (deployment.json "logging"."level"), resolved once at startup: the lowest-priority input of the log-level resolution chain, below the per-run override and the project setting.
	deploymentLogLevel?: LogLevel
	// The queue's settlement hook (docs/queueing.md "Dispatch and the scheduler"): awaited once after the active slot clears on a fulfilled run promise, so it maps the settled run's item and ticks the scheduler while the slot is free. Never invoked on the rejection branch — a rejected run promise is the fatal teardown path, not a settlement.
	onRunSettled: (meta: RunMeta) => Promise<void>
}

export type SubmitResult =
	| { ok: true; runId: string }
	| { ok: false; error: 'run_in_progress' | 'run_suspended' }
	| { ok: false; error: 'run_id_collision' }

// resume starts only the suspended run itself while a pause is active: a workspace-sharing second run can never start until that pause is resumed or terminated.
export type ResumeStartResult =
	| { ok: true }
	| { ok: false; error: 'run_suspended' }

export interface RunSubmission {
	submit(task: string, effortOverride?: EffortLevel, involvementOverride?: InvolvementLevel, logLevelOverride?: LogLevel, continuation?: RunContinuation): SubmitResult
	// The startup-reconciliation and explicit-resume path: re-enters a checkpointed run under its original run id. The caller guarantees no run is active; a resume while active is a bug and fails fast. The options carry the framed operator note of an error-resume, the queue's answer to a parked ask, and the queue-tracked mark the answer resume restores.
	resume(checkpoint: RunCheckpoint, options?: ResumeRunInvocation): ResumeStartResult
	activeRunId(): string | undefined
	// The paused run that outranks every waiting item: set synchronously when a suspended meta settles and cleared by resume or termination.
	suspendedRunId(): string | undefined
	// Boot reconciliation preserves the suspended run's record by seeding the slot it would otherwise have no live settlement to fill.
	adoptSuspendedRun(runId: string): void
	clearSuspendedRun(runId: string): void
	lastRunId(): string | undefined
	awaitActive(): Promise<RunMeta | undefined>
	awaitFatalError(): Promise<Error>
}

// The decision "is a run active?" is a pure read of the active-run slot, so the invariant lives here rather than being scattered through the server.
// `lastRunId` is tracked separately so the active-run API alias can keep surfacing the most recent run after it completes.
export function createRunSubmission(dependencies: RunSubmissionDependencies): RunSubmission {
	let activeRunId: string | undefined
	let lastRunId: string | undefined
	let activePromise: Promise<RunMeta | undefined> = Promise.resolve(undefined)
	let fatalErrorResolve: ((error: Error) => void) | undefined
	const fatalErrorPromise = new Promise<Error>((resolve) => {
		fatalErrorResolve = resolve
	})

	function resolveEffort(override: EffortLevel | undefined): EffortLevel {
		if (override !== undefined) return override
		const projectEffort = dependencies.readProjectSettings().effort
		if (projectEffort !== undefined) return projectEffort
		return DEFAULT_EFFORT
	}

	// The involvement chain (docs/reference.md "Involvement channel"): per-run override, then the project default, then the deployment default, then "early-engagement".
	function resolveInvolvement(override: InvolvementLevel | undefined): InvolvementLevel {
		if (override !== undefined) return override
		const projectInvolvement = dependencies.readProjectSettings().involvement
		if (projectInvolvement !== undefined) return projectInvolvement
		if (dependencies.deploymentInvolvement !== undefined) return dependencies.deploymentInvolvement
		return DEFAULT_INVOLVEMENT
	}

	// The log-level chain (docs/reference.md "Logging level"): per-run override, then the project default, then the deployment default, then "full".
	function resolveLogLevel(override: LogLevel | undefined): LogLevel {
		if (override !== undefined) return override
		const projectLogLevel = dependencies.readProjectSettings().logLevel
		if (projectLogLevel !== undefined) return projectLogLevel
		if (dependencies.deploymentLogLevel !== undefined) return dependencies.deploymentLogLevel
		return DEFAULT_LOG_LEVEL
	}

	// Puts a run promise in the active slot: the slot clears on settlement, a rejection clears it and surfaces through awaitFatalError so a failed run tears the service down non-zero instead of becoming an unhandled rejection. On fulfillment the settlement hook is awaited after the slot clears, so its tick can dispatch into the freed slot.
	function track(runId: string, promise: Promise<RunMeta>): void {
		activeRunId = runId
		lastRunId = runId
		activePromise = promise.then(
			async (meta) => {
				// A suspended settlement must claim the priority slot synchronously, before the active slot clears: any tick that interleaves between the two would otherwise dispatch waiting work into a service that still has a paused run.
				if (meta.status === 'suspended') dependencies.providerSuspension.noticeSuspension(meta)
				activeRunId = undefined
				await dependencies.onRunSettled(meta)
				return meta
			},
			(error) => {
				activeRunId = undefined
				const fatal = error instanceof Error ? error : new Error(String(error))
				if (fatalErrorResolve !== undefined) fatalErrorResolve(fatal)
				return undefined
			},
		)
	}

	return {
		submit(task, effortOverride, involvementOverride, logLevelOverride, continuation) {
			if (activeRunId !== undefined) return { ok: false, error: 'run_in_progress' }
			if (dependencies.providerSuspension.suspendedRunId() !== undefined) return { ok: false, error: 'run_suspended' }
			const runId = dependencies.generateRunId()
			// Regeneration cannot produce a different id until the second ticks over (one-second resolution), so a taken id refuses the submission outright; the caller can simply retry. The run-start backstop is createRunDirectory, which fails loudly on an existing directory.
			if (dependencies.runDirectoryExists(runId)) return { ok: false, error: 'run_id_collision' }
			const effort = resolveEffort(effortOverride)
			const involvement = resolveInvolvement(involvementOverride)
			const logLevel = resolveLogLevel(logLevelOverride)
			track(runId, dependencies.startRun(runId, task, effort, involvement, logLevel, continuation, true))
			return { ok: true, runId }
		},
		resume(checkpoint, options) {
			if (activeRunId !== undefined) throw new Error(`resume called while run ${activeRunId} is active`)
			// A pause is released only by resuming the paused run itself; another run must wait for resume or termination.
			const suspendedRunId = dependencies.providerSuspension.suspendedRunId()
			if (suspendedRunId !== undefined && suspendedRunId !== checkpoint.runId) return { ok: false, error: 'run_suspended' }
			if (suspendedRunId === checkpoint.runId) dependencies.providerSuspension.releaseSuspension(checkpoint.runId)
			track(checkpoint.runId, dependencies.resumeRun(checkpoint, options))
			return { ok: true }
		},
		activeRunId() {
			return activeRunId
		},
		suspendedRunId() {
			return dependencies.providerSuspension.suspendedRunId()
		},
		adoptSuspendedRun(runId) {
			dependencies.providerSuspension.adoptSuspendedRun(runId)
			lastRunId = runId
		},
		clearSuspendedRun(runId) {
			dependencies.providerSuspension.releaseSuspension(runId)
		},
		lastRunId() {
			return lastRunId
		},
		awaitActive() {
			return activePromise
		},
		awaitFatalError() {
			return fatalErrorPromise
		},
	}
}

// The framing put around an operator's note when a run is resumed from its error checkpoint (docs/queueing.md "Resume of an errored or suspended run"): the resumed conversation is the failed run's own, so the note says who is speaking and why the run is continuing.
const RESUME_NOTE_PREFIX = 'The operator resumed this run after a failure. Message from the operator: '
// A suspended run's note names the pause rather than a failure: the operator cleared the provider cause (credit, credentials, or health) and the run continues.
const SUSPENDED_RESUME_NOTE_PREFIX = 'The operator resumed this suspended run. Message from the operator: '

export type ResumeErroredOrSuspendedRunRejection = Extract<SuspendedRunResumeResult, { ok: false }>['error']

export type ResumeErroredOrSuspendedRunResult = SuspendedRunResumeResult

export interface ResumeErroredOrSuspendedRunQueue {
	reactivateErrorItem(runId: string): void
	reactivateSuspendedItem(runId: string): void
	discardSuspendedRun(runId: string, reason?: string): void
}

export interface ResumeErroredOrSuspendedRunDependencies {
	// The same single-slot submission layer every other run goes through: the resumed run occupies the slot under its own id, and its settlement ticks the scheduler exactly as a submitted run's would.
	runSubmission: RunSubmission
	readRunMetaById: ReadRunMetaById
	readCheckpointById: ReadRunCheckpointById
	// The queue module's re-activation operation: after the resume fills the active slot under the run id, the settled error item returns to that slot under the same id.
	taskQueue: ResumeErroredOrSuspendedRunQueue
}

export type ResumeErroredOrSuspendedRun = (runId: string, note: string | undefined) => ResumeErroredOrSuspendedRunResult

// The explicit resume from a checkpoint (docs/queueing.md "Resume of an errored or suspended run"): the operator-driven path that re-enters either an error terminal or a suspended pause (the queue answer is the corresponding path for a parked needs_clarification), and startup reconciliation never touches either meta. The run keeps its own run id, start time, effort, involvement, and log level (they live in the checkpoint, and the resume path re-asserts the running meta from them); the optional note rides into the restored conversation; and after the resume fills the active slot, the queue item settled to error or suspended for this run is re-activated so the panel tracks the live run. A suspended resume additionally clears the suspension priority and passes the prior record into the executor for attempt accounting. Every rejection is a value, so the HTTP layer maps codes to statuses. This operation is the one owner of an unresumable suspended run's cleanup: it releases the pause and discards the run and its suspended item so an automatic or explicit resume cannot leave a pause blocking the queue.
const SUSPENDED_CHECKPOINT_MISSING_REASON = 'The suspended run could not be resumed because its checkpoint is missing or corrupt, so it was interrupted.'
const SUSPENDED_UNRESUMABLE_REASON = 'The suspended run is no longer resumable, so it was interrupted.'

export function createResumeErroredOrSuspendedRun(dependencies: ResumeErroredOrSuspendedRunDependencies): ResumeErroredOrSuspendedRun {
	return (runId, note) => {
		const rejectSuspendedRun = (error: 'checkpoint_missing' | 'run_not_resumable' | 'run_not_found'): ResumeErroredOrSuspendedRunResult => {
			dependencies.runSubmission.clearSuspendedRun(runId)
			const reason = error === 'checkpoint_missing' ? SUSPENDED_CHECKPOINT_MISSING_REASON : SUSPENDED_UNRESUMABLE_REASON
			dependencies.taskQueue.discardSuspendedRun(runId, reason)
			return { ok: false, error }
		}
		if (dependencies.runSubmission.activeRunId() !== undefined) return { ok: false, error: 'run_in_progress' }
		const boundSuspendedRun = dependencies.runSubmission.suspendedRunId() === runId
		const metaText = dependencies.readRunMetaById(runId)
		if (metaText === null) return boundSuspendedRun ? rejectSuspendedRun('run_not_found') : { ok: false, error: 'run_not_found' }
		const parsedMeta = safeJsonParse(metaText)
		const meta = parsedMeta.ok && isRunMeta(parsedMeta.value) ? parsedMeta.value : null
		if (meta === null) return boundSuspendedRun ? rejectSuspendedRun('run_not_found') : { ok: false, error: 'run_not_found' }
		if (meta.status !== 'error' && meta.status !== 'suspended') return boundSuspendedRun ? rejectSuspendedRun('run_not_resumable') : { ok: false, error: 'run_not_resumable' }
		const rejectSuspendedCheckpoint = (): ResumeErroredOrSuspendedRunResult => rejectSuspendedRun('checkpoint_missing')
		const checkpointText = dependencies.readCheckpointById(runId)
		if (checkpointText === null) return meta.status === 'suspended' ? rejectSuspendedCheckpoint() : { ok: false, error: 'checkpoint_missing' }
		const parsedCheckpoint = safeJsonParse(checkpointText)
		const checkpoint = parsedCheckpoint.ok && isRunCheckpoint(parsedCheckpoint.value) ? parsedCheckpoint.value : null
		// The directory name is the run's identity; a checkpoint naming a different run id is treated as corrupt, exactly as startup reconciliation treats one (a corrupt checkpoint is no checkpoint — the briefed continuation is the fallback).
		if (checkpoint === null || checkpoint.runId !== runId) return meta.status === 'suspended' ? rejectSuspendedCheckpoint() : { ok: false, error: 'checkpoint_missing' }
		// A parked checkpoint belongs to the queue's answer resume, never the explicit resume: the run did not fail or suspend, and re-entering it without an answer would fail fast in resumeExecutor.
		if (checkpoint.parkedAsk !== undefined) return meta.status === 'suspended' ? rejectSuspendedCheckpoint() : { ok: false, error: 'checkpoint_missing' }
		if (meta.status === 'suspended') {
			// The run meta is the source of truth for the pause cause; the checkpoint copy covers a crash in the meta-write window.
			const priorSuspension = meta.suspension ?? checkpoint.suspension
			const start = dependencies.runSubmission.resume(checkpoint, {
				explicitResume: true,
				...(note !== undefined ? { resumeNote: `${SUSPENDED_RESUME_NOTE_PREFIX}${note}` } : {}),
				...(priorSuspension !== undefined ? { priorSuspension } : {}),
			})
			if (!start.ok) return start
			dependencies.taskQueue.reactivateSuspendedItem(runId)
			return { ok: true, runId: checkpoint.runId }
		}
		// The settled item returns to the active slot after the resume fills the single slot synchronously, so no scheduler tick can observe the item active against a still-error meta. A run with no matching error item (its record was requeued or cancelled) resumes regardless — the queue record does not gate the run.
		const start = dependencies.runSubmission.resume(checkpoint, { explicitResume: true, resumeNote: note === undefined ? undefined : `${RESUME_NOTE_PREFIX}${note}` })
		if (!start.ok) return start
		dependencies.taskQueue.reactivateErrorItem(runId)
		return { ok: true, runId: checkpoint.runId }
	}
}

export type ReadPauseStateById = (runId: string) => PauseState | null

// Reads the pause a run's checkpoint carries: a parked ask (whose tool result the answer replaces) or a direct clarification finish (whose answer arrives as a note). A missing, corrupt, or misnamed checkpoint reads as absent.
export function createReadPauseStateById(readCheckpointById: ReadRunCheckpointById): ReadPauseStateById {
	return (runId) => {
		const checkpointText = readCheckpointById(runId)
		if (checkpointText === null) return null
		const parsed = safeJsonParse(checkpointText)
		if (!parsed.ok || !isRunCheckpoint(parsed.value)) return null
		if (parsed.value.runId !== runId) return null
		const parkedAsk = parsed.value.parkedAsk
		if (parkedAsk !== undefined) return { kind: 'parked_ask', ask: parkedAsk }
		const delivery = parsed.value.clarificationAnswer
		return {
			kind: 'clarification',
			...(delivery !== undefined ? { deliveredAnswerId: delivery.id } : {}),
			deliveredAnswerConsumed: delivery?.consumed === true,
		}
	}
}

export type ResumeParkedRunRejection = 'run_in_progress' | 'run_suspended' | 'checkpoint_missing' | 'not_parked'

export type ResumeParkedRunResult =
	| { ok: true; runId: string }
	| { ok: false; error: ResumeParkedRunRejection }

export type ResumeParkedRun = (runId: string, parkedAnswer: ParkedAnswer) => ResumeParkedRunResult

export interface ResumeParkedRunDependencies {
	runSubmission: RunSubmission
	readRunMetaById: ReadRunMetaById
	readCheckpointById: ReadRunCheckpointById
}

// The queue's same-run answer resume (docs/queueing.md "Ordering, answers, and failure semantics"): re-enters the parked run under its own id with the answer, restoring the queue-tracked mark so a later pre-write ask parks again instead of blocking. Every rejection is a value; the queue falls back to the briefed dispatch when the checkpoint is gone or no longer parked.
export function createResumeParkedRun(dependencies: ResumeParkedRunDependencies): ResumeParkedRun {
	return (runId, parkedAnswer) => {
		if (dependencies.runSubmission.activeRunId() !== undefined) return { ok: false, error: 'run_in_progress' }
		const metaText = dependencies.readRunMetaById(runId)
		if (metaText === null) return { ok: false, error: 'checkpoint_missing' }
		const parsedMeta = safeJsonParse(metaText)
		const meta = parsedMeta.ok && isRunMeta(parsedMeta.value) ? parsedMeta.value : null
		if (meta === null) return { ok: false, error: 'checkpoint_missing' }
		if (meta.status !== 'needs_clarification') return { ok: false, error: 'not_parked' }
		const checkpointText = dependencies.readCheckpointById(runId)
		if (checkpointText === null) return { ok: false, error: 'checkpoint_missing' }
		const parsedCheckpoint = safeJsonParse(checkpointText)
		const checkpoint = parsedCheckpoint.ok && isRunCheckpoint(parsedCheckpoint.value) ? parsedCheckpoint.value : null
		if (checkpoint === null || checkpoint.runId !== runId) return { ok: false, error: 'checkpoint_missing' }
		const parkedAsk = checkpoint.parkedAsk
		if (parkedAsk === undefined) return { ok: false, error: 'not_parked' }
		if (parkedAsk.question !== parkedAnswer.question || parkedAsk.toolCallId !== parkedAnswer.toolCallId) return { ok: false, error: 'not_parked' }
		const start = dependencies.runSubmission.resume(checkpoint, { parkedAnswer, queueTracked: true })
		if (!start.ok) return start
		return { ok: true, runId }
	}
}

export type ResumeClarificationRunRejection = 'run_in_progress' | 'run_suspended' | 'checkpoint_missing' | 'not_clarification'

export type ResumeClarificationRunResult =
	| { ok: true; runId: string }
	| { ok: false; error: ResumeClarificationRunRejection }

export type ResumeClarificationRun = (runId: string, clarificationAnswer: { id: string; question: string; answer: string }) => ResumeClarificationRunResult

export interface ResumeClarificationRunDependencies {
	runSubmission: RunSubmission
	readRunMetaById: ReadRunMetaById
	readCheckpointById: ReadRunCheckpointById
}

// The queue's same-run resume of a direct clarification finish (docs/queueing.md "Ordering, answers, and failure semantics"): there is no parked call to replace, so the answer re-enters the run under its own id as a framed operator note. A checkpoint carrying parkedAsk belongs to the parked-answer path and is rejected here. Every rejection is a value; the queue falls back to the briefed dispatch when the pause can no longer be resumed.
export function createResumeClarificationRun(dependencies: ResumeClarificationRunDependencies): ResumeClarificationRun {
	return (runId, clarificationAnswer) => {
		if (dependencies.runSubmission.activeRunId() !== undefined) return { ok: false, error: 'run_in_progress' }
		const metaText = dependencies.readRunMetaById(runId)
		if (metaText === null) return { ok: false, error: 'checkpoint_missing' }
		const parsedMeta = safeJsonParse(metaText)
		const meta = parsedMeta.ok && isRunMeta(parsedMeta.value) ? parsedMeta.value : null
		if (meta === null) return { ok: false, error: 'checkpoint_missing' }
		if (meta.status !== 'needs_clarification') return { ok: false, error: 'not_clarification' }
		const checkpointText = dependencies.readCheckpointById(runId)
		if (checkpointText === null) return { ok: false, error: 'checkpoint_missing' }
		const parsedCheckpoint = safeJsonParse(checkpointText)
		const checkpoint = parsedCheckpoint.ok && isRunCheckpoint(parsedCheckpoint.value) ? parsedCheckpoint.value : null
		if (checkpoint === null || checkpoint.runId !== runId) return { ok: false, error: 'checkpoint_missing' }
		if (checkpoint.parkedAsk !== undefined) return { ok: false, error: 'not_clarification' }
		const start = dependencies.runSubmission.resume(checkpoint, { clarificationAnswer, queueTracked: true })
		if (!start.ok) return start
		return { ok: true, runId }
	}
}

export type TerminatePausedRunRejection = 'not_found' | 'not_paused'

export type TerminatePausedRunResult =
	| { ok: true; runId: string }
	| { ok: false; error: TerminatePausedRunRejection }

export type TerminatePausedRun = (runId: string, reason?: string) => TerminatePausedRunResult

export interface TerminatePausedRunDependencies {
	readRunMetaById: ReadRunMetaById
	// Supplied by the service so termination can close open invocations.
	readRunLogEvents: ReadRunLogEvents
	writeMetaFor: (runId: string) => WriteMeta
	deleteCheckpointFor: (runId: string) => DeleteCheckpoint
	appendLogFor: (runId: string) => AppendLog
	// Clears the submission layer's suspended-run priority; termination of a suspended run must let the next tick dispatch waiting work.
	clearSuspendedRun: (runId: string) => void
}

function terminationLogEvent(timestamp: string, message: string): LogEvent {
	return {
		timestamp,
		type: 'run_terminated',
		payload: {
			reason: 'operator',
			message,
		},
	}
}

// Operator termination ends the run, so every invocation still open in its log — parked ask, paused roles, handler work — gets one interrupted terminal before the run_terminated event. The stale planner is the same idempotent pass resume uses; a missing or corrupt checkpoint simply leaves the log untouched.
function closeOpenInvocationsOnTermination(dependencies: TerminatePausedRunDependencies, runId: string, timestamp: string): void {
	const events = dependencies.readRunLogEvents(runId)
	const appendLog = dependencies.appendLogFor(runId)
	for (const terminal of planStaleInvocationTerminals(events, new Set(), new Set())) {
		appendLog({ timestamp, type: terminal.type, payload: terminal.payload })
	}
}

// The operator's termination path for a parked or suspended run (docs/queueing.md "Parking: the pre-write rule" and the suspended terminate): the run is only touched while its meta reads needs_clarification or suspended, so anything else is left untouched for the caller to report. It writes the same interrupted shape reconciliation writes — a terminal meta with no result card — preserving the parked end time where one exists (the termination time rides the log event) and removes the checkpoint so no answer or resume can re-enter the run. An already-interrupted meta means a previous attempt crashed between the meta write and the log append or the checkpoint delete, so this retry finishes that cleanup idempotently, accepting a duplicate log event; success/error metas keep their checkpoints.
export function createTerminatePausedRun(dependencies: TerminatePausedRunDependencies): TerminatePausedRun {
	return (runId, reason) => {
		const metaText = dependencies.readRunMetaById(runId)
		if (metaText === null) {
			dependencies.clearSuspendedRun(runId)
			return { ok: false, error: 'not_found' }
		}
		const parsedMeta = safeJsonParse(metaText)
		const meta = parsedMeta.ok && isRunMeta(parsedMeta.value) ? parsedMeta.value : null
		if (meta === null) {
			dependencies.clearSuspendedRun(runId)
			return { ok: false, error: 'not_found' }
		}
		if (meta.status === 'interrupted') {
			const retryTerminatedAt = new Date().toISOString()
			dependencies.clearSuspendedRun(runId)
			closeOpenInvocationsOnTermination(dependencies, runId, retryTerminatedAt)
			dependencies.appendLogFor(runId)(terminationLogEvent(retryTerminatedAt, 'Terminated by the operator while waiting for an answer.'))
			dependencies.deleteCheckpointFor(runId)()
			return { ok: false, error: 'not_paused' }
		}
		if (meta.status !== 'needs_clarification' && meta.status !== 'suspended') return { ok: false, error: 'not_paused' }
		const suspended = meta.status === 'suspended'
		const terminatedAt = new Date().toISOString()
		const endTime = meta.endTime ?? terminatedAt
		const errorMessage = reason ?? (suspended ? 'The operator terminated this suspended run.' : 'The operator terminated this run while it was waiting for an answer.')
		const logMessage = reason ?? (suspended ? 'Terminated by the operator while the run was suspended.' : 'Terminated by the operator while waiting for an answer.')
		dependencies.writeMetaFor(runId)({
			runId,
			...(meta.guildPath !== undefined ? { guildPath: meta.guildPath } : {}),
			...(meta.benchmarkPath !== undefined ? { benchmarkPath: meta.benchmarkPath } : {}),
			task: meta.task,
			...(meta.effort !== undefined ? { effort: meta.effort } : {}),
			...(meta.involvement !== undefined ? { involvement: meta.involvement } : {}),
			...(meta.logLevel !== undefined ? { logLevel: meta.logLevel } : {}),
			...(meta.continuesFrom !== undefined ? { continuesFrom: meta.continuesFrom } : {}),
			status: 'interrupted',
			startTime: meta.startTime,
			endTime,
			error: { kind: 'interrupted', message: errorMessage },
		})
		if (suspended) dependencies.clearSuspendedRun(runId)
		closeOpenInvocationsOnTermination(dependencies, runId, terminatedAt)
		dependencies.appendLogFor(runId)(terminationLogEvent(terminatedAt, logMessage))
		dependencies.deleteCheckpointFor(runId)()
		return { ok: true, runId }
	}
}
