import type { RunCheckpoint } from './checkpoint.js'
import { DEFAULT_EFFORT } from './effort.js'
import { DEFAULT_LOG_LEVEL } from './log-level.js'
import type { EffortLevel, LogLevel, RunContinuation, RunMeta } from './types.js'
import type { ReadProjectSettings } from './persistence.js'

export type StartRun = (runId: string, task: string, effort: EffortLevel, logLevel: LogLevel, continuation?: RunContinuation) => Promise<RunMeta>
export type ResumeRun = (checkpoint: RunCheckpoint) => Promise<RunMeta>

export interface RunSubmissionDependencies {
	startRun: StartRun
	resumeRun: ResumeRun
	generateRunId: () => string
	readProjectSettings: ReadProjectSettings
	// The deployment file's logging default (deployment.json "logging"."level"), resolved once at startup: the lowest-priority input of the log-level resolution chain, below the per-run override and the project setting.
	deploymentLogLevel?: LogLevel
}

export type SubmitResult =
	| { ok: true; runId: string }
	| { ok: false; error: 'run_in_progress' }

export interface RunSubmission {
	submit(task: string, effortOverride?: EffortLevel, logLevelOverride?: LogLevel, continuation?: RunContinuation): SubmitResult
	// The startup-reconciliation path: re-enters a checkpointed run under its original run id. The caller (startup, before the server accepts submissions) guarantees no run is active; a resume while active is a bug and fails fast.
	resume(checkpoint: RunCheckpoint): void
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

	// The log-level chain (docs/reference.md "Logging level"): per-run override, then the project default, then the deployment default, then "full".
	function resolveLogLevel(override: LogLevel | undefined): LogLevel {
		if (override !== undefined) return override
		const projectLogLevel = dependencies.readProjectSettings().logLevel
		if (projectLogLevel !== undefined) return projectLogLevel
		if (dependencies.deploymentLogLevel !== undefined) return dependencies.deploymentLogLevel
		return DEFAULT_LOG_LEVEL
	}

	// Puts a run promise in the active slot: the slot clears on settlement, a rejection clears it and surfaces through awaitFatalError so a failed run tears the service down non-zero instead of becoming an unhandled rejection.
	function track(runId: string, promise: Promise<RunMeta>): void {
		activeRunId = runId
		lastRunId = runId
		activePromise = promise.then(
			(meta) => {
				activeRunId = undefined
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
		submit(task, effortOverride, logLevelOverride, continuation) {
			if (activeRunId !== undefined) return { ok: false, error: 'run_in_progress' }
			const runId = dependencies.generateRunId()
			const effort = resolveEffort(effortOverride)
			const logLevel = resolveLogLevel(logLevelOverride)
			track(runId, dependencies.startRun(runId, task, effort, logLevel, continuation))
			return { ok: true, runId }
		},
		resume(checkpoint) {
			if (activeRunId !== undefined) throw new Error(`resume called while run ${activeRunId} is active`)
			track(checkpoint.runId, dependencies.resumeRun(checkpoint))
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
