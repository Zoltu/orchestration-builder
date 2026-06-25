import { DEFAULT_EFFORT } from './effort.js'
import type { EffortLevel, RunMeta } from './types.js'
import type { ReadProjectSettings } from './persistence.js'

// Leaf wrapper that starts a single run with the given id, task, and resolved effort, and resolves to its terminal meta.
// The implementation builds the per-run executor dependencies and calls runExecutor; it lives in the integration shell (main.ts), not here.
export type StartRun = (runId: string, task: string, effort: EffortLevel) => Promise<RunMeta>

export interface RunSubmissionDependencies {
	startRun: StartRun
	generateRunId: () => string
	// Reads the project-wide default effort, applied when a submit omits a per-run override.
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

// Enforces the one-task-at-a-time invariant for the service: at most one run is active, and a second submit while one is in flight is rejected.
// The decision "is a run active?" is a pure read of the active-run slot, so the invariant lives here rather than being scattered through the server.
// `lastRunId` is tracked separately so the active-run API alias can keep surfacing the most recent run after it completes.
// A fatal run error (startRun rejecting) clears the active slot, resolves awaitActive with undefined, and resolves awaitFatalError so the service can tear down non-zero instead of silently carrying a dead run.
// Effort is resolved once at submission: a per-run override wins, otherwise the project default is read, otherwise DEFAULT_EFFORT. It is threaded into the started run and not adjustable mid-run (a second submit is already rejected as run_in_progress).
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
