import { isRunCheckpoint, type CheckpointFrame, type RunCheckpoint } from './checkpoint.js'
import { createResultCard } from './errors.js'
import { parkSummary } from './park-state.js'
import { SUPERSEDED_SUSPENDED_RUN_MESSAGE } from './suspension.js'
import { isRunMeta } from './validation.js'
import type { ListRunIds, ReadRunCheckpointById, ReadRunFormat, ReadRunMetaTextById, WriteMeta } from './persistence.js'
import type { VersionStatus } from './orchestration-version.js'
import type { RunMeta } from './types.js'

export interface StartupReconciliationDependencies {
	listRunIds: ListRunIds
	readRunMetaTextById: ReadRunMetaTextById
	readCheckpointById: ReadRunCheckpointById
	readRunFormat: ReadRunFormat
	// A factory rather than a single leaf: reconciliation may need to write terminal metas for several abandoned runs.
	writeMetaFor: (runId: string) => WriteMeta
	resume: (checkpoint: RunCheckpoint) => void
}

export interface ReconciliationReport {
	resumedRunId?: string
	interruptedRunIds: string[]
	// Runs whose frozen checkpoint was parked: they are terminalized as needs_clarification and left on disk for the queue answer to re-enter.
	parkedRunIds: string[]
	// The suspended runs found at boot (durable suspended metas and checkpoint suspensions materialized from them); they are reported, never resumed or interrupted, except that all but the newest are superseded.
	suspendedRunIds: string[]
}

function parseJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

function readMeta(readRunMetaTextById: ReadRunMetaTextById, runId: string): RunMeta | null {
	const metaText = readRunMetaTextById(runId)
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

const SUSPENDED_UNRESUMABLE_MESSAGE = 'The run was suspended but its checkpoint is missing, unreadable, or incompatible, so it cannot be resumed.'
const ABANDONED_MESSAGE = 'The service stopped while this run was in progress and it could not be resumed (no valid checkpoint).'
const SUPERSEDED_MESSAGE = 'The service restarted with multiple resumable runs; only the most recent was resumed (one task at a time).'

function unsupportedFormatMessage(status: Exclude<VersionStatus, 'current'>): string {
	switch (status) {
		case 'malformed':
			return 'The service stopped while this run was in progress and its run manifest is malformed, so the run could not be resumed.'
		case 'missing':
			return 'The service stopped while this run was in progress and its run manifest is missing, so the run format is unsupported and it could not be resumed.'
		case 'old':
			return 'The service stopped while this run was in progress and its run manifest is older than this build supports, so it could not be resumed.'
		case 'newer':
			return 'The service stopped while this run was in progress and its run manifest is newer than this build supports, so it could not be resumed.'
		default: {
			const exhaustive: never = status
			return exhaustive
		}
	}
}

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
		...(meta?.logLevel !== undefined ? { logLevel: meta.logLevel } : {}),
		...(meta?.continuesFrom !== undefined ? { continuesFrom: meta.continuesFrom } : {}),
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

// A checkpoint suspension that outran its meta is materialized as a suspended meta. Every checkpoint suspension is materialized as a durable paused run, including a transient one; boot never re-issues the interrupted provider call. The health monitor owns any later automatic resume once the service wires it.
function markSuspended(dependencies: StartupReconciliationDependencies, runId: string, meta: RunMeta | null, checkpoint: RunCheckpoint): void {
	const suspension = checkpoint.suspension
	if (suspension === undefined) throw new Error(`markSuspended: run ${runId} has no checkpoint suspension`)
	const entryFrame = checkpoint.frames[0]
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
		status: 'suspended',
		suspension,
		startTime: meta?.startTime ?? checkpoint.startTime,
	})
}

// Startup reconciliation: scans the runs directory for runs that never reached a terminal meta (no meta.json, or one still saying "running" — both mean the process died mid-run). A durable suspended meta is reported and left alone; any checkpoint suspension is materialized as suspended (never auto-resumed at boot); a run with a valid, unparked checkpoint resumes when no suspended run has priority; a parked checkpoint is terminalized as needs_clarification and left for the queue answer; anything else is marked interrupted so its meta reads honestly. The one-task-at-a-time invariant admits at most one live run: the most recent suspended run wins, otherwise the most recent resumable run wins, and the rest are marked interrupted.
export function reconcileRunsOnStartup(dependencies: StartupReconciliationDependencies): ReconciliationReport {
	const resumable: Array<{ runId: string; meta: RunMeta | null; checkpoint: RunCheckpoint }> = []
	const report: ReconciliationReport = { interruptedRunIds: [], parkedRunIds: [], suspendedRunIds: [] }
	const suspended: Array<{ runId: string; meta: RunMeta | null; startTime: string }> = []

	for (const runId of dependencies.listRunIds()) {
		const meta = readMeta(dependencies.readRunMetaTextById, runId)
		const suspendedMeta = meta !== null && meta.status === 'suspended'
		// A suspended meta is a durable pause, not an abandoned run, but its checkpoint still has to be usable or it could block dispatch forever.
		if (meta !== null && meta.status !== 'running' && !suspendedMeta) continue
		const format = dependencies.readRunFormat(runId)
		if (format !== 'current') {
			markInterrupted(dependencies, runId, meta, suspendedMeta ? SUSPENDED_UNRESUMABLE_MESSAGE : unsupportedFormatMessage(format))
			report.interruptedRunIds.push(runId)
			continue
		}
		const checkpoint = readCheckpoint(dependencies.readCheckpointById, runId)
		if (checkpoint === null) {
			markInterrupted(dependencies, runId, meta, suspendedMeta ? SUSPENDED_UNRESUMABLE_MESSAGE : ABANDONED_MESSAGE)
			report.interruptedRunIds.push(runId)
			continue
		}
		if (suspendedMeta) {
			if (checkpoint.parkedAsk !== undefined) {
				markInterrupted(dependencies, runId, meta, SUSPENDED_UNRESUMABLE_MESSAGE)
				report.interruptedRunIds.push(runId)
				continue
			}
			suspended.push({ runId, meta, startTime: meta.startTime })
			continue
		}
		if (checkpoint.parkedAsk !== undefined) {
			markParked(dependencies, runId, meta, checkpoint, checkpoint.parkedAsk.question)
			report.parkedRunIds.push(runId)
			continue
		}
		// A checkpoint suspension is a durable pause regardless of whether its policy is auto or operator: boot must never re-issue the interrupted provider call itself. The health monitor honors autoResumeAfter once the service is wired.
		if (checkpoint.suspension !== undefined) {
			markSuspended(dependencies, runId, meta, checkpoint)
			suspended.push({ runId, meta, startTime: meta?.startTime ?? checkpoint.startTime })
			continue
		}
		resumable.push({ runId, meta, checkpoint })
	}

	// The workspace admits one live run, so multiple suspended runs can never be safely interleaved: keep the newest and terminalize the rest, exactly as multiple resumable runs are handled.
	suspended.sort((a, b) => b.startTime.localeCompare(a.startTime))
	for (const candidate of suspended.slice(1)) {
		markInterrupted(dependencies, candidate.runId, candidate.meta, SUPERSEDED_SUSPENDED_RUN_MESSAGE)
		report.interruptedRunIds.push(candidate.runId)
	}
	const suspendedWinner = suspended[0]
	if (suspendedWinner !== undefined) report.suspendedRunIds.push(suspendedWinner.runId)

	resumable.sort((a, b) => {
		const aTime = a.meta?.startTime ?? a.checkpoint.startTime
		const bTime = b.meta?.startTime ?? b.checkpoint.startTime
		return bTime.localeCompare(aTime)
	})
	// A suspended run retains priority through boot: auto-resuming transient work beside it would start a second run, so every resumable candidate is terminalized instead. With no suspended run the existing single-winner behavior is unchanged.
	const resumableToInterrupt = suspendedWinner !== undefined ? resumable : resumable.slice(1)
	for (const candidate of resumableToInterrupt) {
		markInterrupted(dependencies, candidate.runId, candidate.meta, SUPERSEDED_MESSAGE)
		report.interruptedRunIds.push(candidate.runId)
	}

	const winner = suspendedWinner === undefined ? resumable[0] : undefined
	if (winner !== undefined) {
		dependencies.resume(winner.checkpoint)
		report.resumedRunId = winner.runId
	}
	return report
}
