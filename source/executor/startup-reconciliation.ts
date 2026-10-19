import { isRunCheckpoint, type CheckpointFrame, type RunCheckpoint } from './checkpoint.js'
import { createResultCard } from './errors.js'
import { parkSummary } from './park-state.js'
import { isRunMeta } from './validation.js'
import type { ListRunIds, ReadRunCheckpointById, ReadRunMetaById, WriteMeta } from './persistence.js'
import type { RunMeta } from './types.js'

export interface StartupReconciliationDependencies {
	listRunIds: ListRunIds
	readRunMetaById: ReadRunMetaById
	readCheckpointById: ReadRunCheckpointById
	// A factory rather than a single leaf: reconciliation may need to write terminal metas for several abandoned runs.
	writeMetaFor: (runId: string) => WriteMeta
	resume: (checkpoint: RunCheckpoint) => void
}

export interface ReconciliationReport {
	resumedRunId?: string
	interruptedRunIds: string[]
	// Runs whose frozen checkpoint was parked: they are terminalized as needs_clarification and left on disk for the queue answer to re-enter.
	parkedRunIds: string[]
}

function parseJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

function readMeta(readRunMetaById: ReadRunMetaById, runId: string): RunMeta | null {
	const metaText = readRunMetaById(runId)
	if (metaText === null) return null
	const parsed = parseJson(metaText)
	return isRunMeta(parsed) ? parsed : null
}

function readCheckpoint(readCheckpointById: ReadRunCheckpointById, runId: string): RunCheckpoint | null {
	const checkpointText = readCheckpointById(runId)
	if (checkpointText === null) return null
	const parsed = parseJson(checkpointText)
	if (!isRunCheckpoint(parsed)) return null
	// The directory name is the run's identity; a checkpoint naming a different run id is treated as corrupt rather than resuming a run under the wrong directory.
	if (parsed.runId !== runId) return null
	return parsed
}

const ABANDONED_MESSAGE = 'The service stopped while this run was in progress and it could not be resumed (no valid checkpoint).'
const SUPERSEDED_MESSAGE = 'The service restarted with multiple resumable runs; only the most recent was resumed (one task at a time).'

// Marks an abandoned run terminal so the UI stops showing it as "in progress". Fields from the existing meta are preserved when present; a run that died before its running meta landed omits the absent optional fields rather than pinning empty-string sentinels — the run directory and log still identify it.
function markInterrupted(dependencies: StartupReconciliationDependencies, runId: string, meta: RunMeta | null, message: string): void {
	const endTime = new Date().toISOString()
	dependencies.writeMetaFor(runId)({
		runId,
		...(meta?.guildPath !== undefined ? { guildPath: meta.guildPath } : {}),
		...(meta?.benchmarkPath !== undefined ? { benchmarkPath: meta.benchmarkPath } : {}),
		task: meta?.task ?? '(task unknown — run metadata was lost)',
		...(meta?.effort !== undefined ? { effort: meta.effort } : {}),
		...(meta?.involvement !== undefined ? { involvement: meta.involvement } : {}),
		status: 'interrupted',
		startTime: meta?.startTime ?? endTime,
		endTime,
		error: { kind: 'interrupted', message },
	})
}

// A parked checkpoint is frozen exactly where the parked turn stopped, so it must not be auto-resumed (no answer exists) and must not be discarded: terminalizing it as needs_clarification with the same park summary keeps the run honest while leaving the checkpoint for the queue's answer resume. Identity comes from the running meta when it landed, else the checkpoint's entry frame.
function markParked(dependencies: StartupReconciliationDependencies, runId: string, meta: RunMeta | null, checkpoint: RunCheckpoint, question: string): void {
	const endTime = new Date().toISOString()
	const entryFrame: CheckpointFrame | undefined = checkpoint.frames[0]
	const effort = meta?.effort ?? entryFrame?.effort
	const involvement = meta?.involvement ?? entryFrame?.involvement
	const logLevel = meta?.logLevel ?? entryFrame?.logLevel
	const continuesFrom = meta?.continuesFrom ?? entryFrame?.continuesFrom
	dependencies.writeMetaFor(runId)({
		runId,
		...(meta?.guildPath !== undefined ? { guildPath: meta.guildPath } : {}),
		...(meta?.benchmarkPath !== undefined ? { benchmarkPath: meta.benchmarkPath } : {}),
		task: meta?.task ?? entryFrame?.task ?? '(task unknown — run metadata was lost)',
		...(effort !== undefined ? { effort } : {}),
		...(involvement !== undefined ? { involvement } : {}),
		...(logLevel !== undefined ? { logLevel } : {}),
		...(continuesFrom !== undefined ? { continuesFrom } : {}),
		status: 'needs_clarification',
		startTime: meta?.startTime ?? checkpoint.startTime,
		endTime,
		result: createResultCard('needs_clarification', parkSummary(question)),
	})
}

// Startup reconciliation: scans the runs directory for runs that never reached a terminal meta (no meta.json, or one still saying "running" — both mean the process died mid-run). A run with a valid, unparked checkpoint resumes; a parked checkpoint is terminalized as needs_clarification and left for the queue answer; anything else is marked interrupted so its meta reads honestly. The one-task-at-a-time invariant admits at most one resume: the most recent resumable run wins and the rest are marked interrupted.
export function reconcileRunsOnStartup(dependencies: StartupReconciliationDependencies): ReconciliationReport {
	const resumable: Array<{ runId: string; meta: RunMeta | null; checkpoint: RunCheckpoint }> = []
	const report: ReconciliationReport = { interruptedRunIds: [], parkedRunIds: [] }

	for (const runId of dependencies.listRunIds()) {
		const meta = readMeta(dependencies.readRunMetaById, runId)
		if (meta !== null && meta.status !== 'running') continue
		const checkpoint = readCheckpoint(dependencies.readCheckpointById, runId)
		if (checkpoint === null) {
			markInterrupted(dependencies, runId, meta, ABANDONED_MESSAGE)
			report.interruptedRunIds.push(runId)
			continue
		}
		if (checkpoint.parkedAsk !== undefined) {
			markParked(dependencies, runId, meta, checkpoint, checkpoint.parkedAsk.question)
			report.parkedRunIds.push(runId)
			continue
		}
		resumable.push({ runId, meta, checkpoint })
	}

	resumable.sort((a, b) => {
		const aTime = a.meta?.startTime ?? a.checkpoint.startTime
		const bTime = b.meta?.startTime ?? b.checkpoint.startTime
		return bTime.localeCompare(aTime)
	})
	for (const candidate of resumable.slice(1)) {
		markInterrupted(dependencies, candidate.runId, candidate.meta, SUPERSEDED_MESSAGE)
		report.interruptedRunIds.push(candidate.runId)
	}

	const winner = resumable[0]
	if (winner !== undefined) {
		dependencies.resume(winner.checkpoint)
		report.resumedRunId = winner.runId
	}
	return report
}
