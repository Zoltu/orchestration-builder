import { isRunCheckpoint, type RunCheckpoint } from './checkpoint.js'
import { DEFAULT_EFFORT } from './effort.js'
import { DEFAULT_INVOLVEMENT } from './involvement.js'
import { DEFAULT_LOG_LEVEL } from './log-level.js'
import { isRunMeta, safeJsonParse } from './validation.js'
import type { EffortLevel, InvolvementLevel, LogLevel, RunContinuation, RunMeta } from './types.js'
import type { ReadProjectSettings, ReadRunCheckpointById, ReadRunMetaById, RunDirectoryExists } from './persistence.js'

// Every fresh run is started through submit, and submit is called only by the scheduler's dispatch path (the queue is universal — docs/queueing.md "Dispatch and the scheduler"), so the submission layer marks every started run queue-tracked: the bit that gates the pre-write park (docs/queueing.md "Parking: the pre-write rule"). The mark does not survive a restart (it does not ride the checkpoint), so a boot-resumed run keeps today's blocking ask behavior.
export type StartRun = (runId: string, task: string, effort: EffortLevel, involvement: InvolvementLevel, logLevel: LogLevel, continuation: RunContinuation | undefined, queueTracked: boolean) => Promise<RunMeta>
export type ResumeRun = (checkpoint: RunCheckpoint, resumeNote?: string) => Promise<RunMeta>

export interface RunSubmissionDependencies {
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
	| { ok: false; error: 'run_in_progress' }
	| { ok: false; error: 'run_id_collision' }

export interface RunSubmission {
	submit(task: string, effortOverride?: EffortLevel, involvementOverride?: InvolvementLevel, logLevelOverride?: LogLevel, continuation?: RunContinuation): SubmitResult
	// The startup-reconciliation path: re-enters a checkpointed run under its original run id. The caller (startup, before the server accepts submissions) guarantees no run is active; a resume while active is a bug and fails fast. resumeNote is the framed operator note on an explicit error-resume and is absent for boot reconciliation.
	resume(checkpoint: RunCheckpoint, resumeNote?: string): void
	activeRunId(): string | undefined
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
			const runId = dependencies.generateRunId()
			// Regeneration cannot produce a different id until the second ticks over (one-second resolution), so a taken id refuses the submission outright; the caller can simply retry. The run-start backstop is createRunDirectory, which fails loudly on an existing directory.
			if (dependencies.runDirectoryExists(runId)) return { ok: false, error: 'run_id_collision' }
			const effort = resolveEffort(effortOverride)
			const involvement = resolveInvolvement(involvementOverride)
			const logLevel = resolveLogLevel(logLevelOverride)
			track(runId, dependencies.startRun(runId, task, effort, involvement, logLevel, continuation, true))
			return { ok: true, runId }
		},
		resume(checkpoint, resumeNote) {
			if (activeRunId !== undefined) throw new Error(`resume called while run ${activeRunId} is active`)
			track(checkpoint.runId, dependencies.resumeRun(checkpoint, resumeNote))
		},
		activeRunId() {
			return activeRunId
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

// The framing put around an operator's note when a run is resumed from its error checkpoint (docs/queueing.md "Resume of an errored run"): the resumed conversation is the failed run's own, so the note says who is speaking and why the run is continuing.
const RESUME_NOTE_PREFIX = 'The operator resumed this run after a failure. Message from the operator: '

export type ResumeErroredRunRejection =
	| 'run_not_found'
	| 'run_not_errored'
	| 'checkpoint_missing'
	| 'run_in_progress'

export type ResumeErroredRunResult =
	| { ok: true; runId: string }
	| { ok: false; error: ResumeErroredRunRejection }

export interface ResumeErroredRunQueue {
	reactivateErrorItem(runId: string): void
}

export interface ResumeErroredRunDependencies {
	// The same single-slot submission layer every other run goes through: the resumed run occupies the slot under its own id, and its settlement ticks the scheduler exactly as a submitted run's would.
	runSubmission: RunSubmission
	readRunMetaById: ReadRunMetaById
	readCheckpointById: ReadRunCheckpointById
	// The queue module's re-activation operation: the settled error item returns to the active slot under the resumed run id before the resume starts.
	taskQueue: ResumeErroredRunQueue
}

export type ResumeErroredRun = (runId: string, note: string | undefined) => ResumeErroredRunResult

// The explicit resume of an error-ended run from its checkpoint (docs/queueing.md "Resume of an errored run"): the only path that re-enters a terminal run, and strictly operator-driven — startup reconciliation never touches an error meta. The run keeps its own run id, start time, effort, involvement, and log level (they live in the checkpoint, and the resume path re-asserts the running meta from them); the optional note rides into the restored conversation; and the queue item settled to error for this run is re-activated so the panel tracks the live run. Every rejection is a value, so the HTTP layer maps codes to statuses.
export function createResumeErroredRun(dependencies: ResumeErroredRunDependencies): ResumeErroredRun {
	return (runId, note) => {
		if (dependencies.runSubmission.activeRunId() !== undefined) return { ok: false, error: 'run_in_progress' }
		const metaText = dependencies.readRunMetaById(runId)
		if (metaText === null) return { ok: false, error: 'run_not_found' }
		const parsedMeta = safeJsonParse(metaText)
		const meta = parsedMeta.ok && isRunMeta(parsedMeta.value) ? parsedMeta.value : null
		if (meta === null) return { ok: false, error: 'run_not_found' }
		if (meta.status !== 'error') return { ok: false, error: 'run_not_errored' }
		const checkpointText = dependencies.readCheckpointById(runId)
		if (checkpointText === null) return { ok: false, error: 'checkpoint_missing' }
		const parsedCheckpoint = safeJsonParse(checkpointText)
		const checkpoint = parsedCheckpoint.ok && isRunCheckpoint(parsedCheckpoint.value) ? parsedCheckpoint.value : null
		// The directory name is the run's identity; a checkpoint naming a different run id is treated as corrupt, exactly as startup reconciliation treats one (a corrupt checkpoint is no checkpoint — the briefed continuation is the fallback).
		if (checkpoint === null || checkpoint.runId !== runId) return { ok: false, error: 'checkpoint_missing' }
		// The settled item returns to the active slot before the resume starts, in the same marker-then-submit order the dispatch path uses: the slot is filled synchronously by resume, so no scheduler tick can observe the item active against a still-error meta. A run with no matching error item (its record was requeued or cancelled) resumes regardless — the queue record does not gate the run.
		dependencies.taskQueue.reactivateErrorItem(runId)
		dependencies.runSubmission.resume(checkpoint, note === undefined ? undefined : `${RESUME_NOTE_PREFIX}${note}`)
		return { ok: true, runId: checkpoint.runId }
	}
}
