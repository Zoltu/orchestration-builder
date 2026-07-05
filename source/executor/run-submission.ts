import { DEFAULT_EFFORT } from './effort.js'
import type { EffortLevel, RunMeta } from './types.js'
import type { ReadProjectSettings } from './persistence.js'

export type StartRun = (runId: string, task: string, effort: EffortLevel) => Promise<RunMeta>

export interface RunSubmissionDependencies {
	startRun: StartRun
	generateRunId: () => string
	readProjectSettings: ReadProjectSettings
}

export type SubmitResult =
	| { ok: true; runId: string }
	| { ok: false; error: 'run_in_progress' }

export interface RunSubmission {
	submit(task: string, effortOverride?: EffortLevel): SubmitResult
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

	return {
		submit(task, effortOverride) {
			if (activeRunId !== undefined) return { ok: false, error: 'run_in_progress' }
			const runId = dependencies.generateRunId()
			const effort = resolveEffort(effortOverride)
			activeRunId = runId
			lastRunId = runId
			activePromise = dependencies.startRun(runId, task, effort).then(
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
			return { ok: true, runId }
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
