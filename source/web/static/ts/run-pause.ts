// The shared run-pause vocabulary: whether a suspended run is an operator pause or a provider suspension, the label each surface shows, and the small decisions around requesting a pause. The server keeps both kinds under status 'suspended'; the optional `pause` record is the only way to tell them apart.

import { isObject } from './guards.js'
import { isSuspendedStatus, isTerminalStatus } from './interaction-model.js'
import type { OperatorPauseRecord } from './interaction-model.js'

export type RunPauseKind = 'none' | 'operator' | 'provider'

export function isOperatorPauseRecord(value: unknown): value is OperatorPauseRecord {
	if (!isObject(value)) return false
	if (typeof value['message'] !== 'string') return false
	return typeof value['pausedAt'] === 'string'
}

// A provider suspension is the only other cause of a suspended status, so a suspended run without a pause record keeps the existing Suspended copy.
export function deriveRunPauseKind(run: unknown): RunPauseKind {
	if (!isObject(run)) return 'none'
	const status = run['status']
	if (typeof status !== 'string' || !isSuspendedStatus(status)) return 'none'
	if (isOperatorPauseRecord(run['pause'])) return 'operator'
	return 'provider'
}

export function isOperatorPaused(run: unknown): boolean {
	return deriveRunPauseKind(run) === 'operator'
}

export function readOperatorPauseRecord(run: unknown): OperatorPauseRecord | null {
	if (!isObject(run)) return null
	const pause = run['pause']
	return isOperatorPauseRecord(pause) ? pause : null
}

export function hasOperatorPausedRun(runs: readonly unknown[]): boolean {
	return runs.some((run) => isOperatorPaused(run))
}

// The top bar and row status text for a suspended run; every other status keeps the caller's own label.
export function deriveSuspendedStatusLabel(status: unknown, pauseKind: RunPauseKind): string | null {
	if (status !== 'suspended') return null
	return pauseKind === 'operator' ? 'paused' : 'suspended'
}

// The run a Pause click should address: the one run that is genuinely running, never an unknown-status or paused run.
export function derivePauseTargetRunId(summaries: readonly unknown[], pendingRunId: string | null): string | null {
	if (pendingRunId !== null) return null
	for (const summary of summaries) {
		if (!isObject(summary)) continue
		if (summary['status'] !== 'running') continue
		const runId = summary['runId']
		if (typeof runId === 'string' && runId !== '') return runId
	}
	return null
}

// The pending pause lives until the run list proves the request landed (suspended) or the run is gone. An unknown status is still polled as potentially active, so it keeps the pending state.
export function resolvePausePendingRunId(pendingRunId: string | null, summaries: readonly unknown[]): string | null {
	if (pendingRunId === null) return null
	for (const summary of summaries) {
		if (!isObject(summary)) continue
		if (summary['runId'] !== pendingRunId) continue
		const status = summary['status']
		if (typeof status !== 'string') return null
		if (isSuspendedStatus(status) || isTerminalStatus(status)) return null
		return status === 'running' || status === 'unknown' ? pendingRunId : null
	}
	return null
}

export function pauseFailureCopy(body: unknown, status: number): string {
	if (status === 404) return 'The run could not be found, so the pause request was not applied.'
	if (status === 409) {
		const error = isObject(body) ? body['error'] : undefined
		if (error === 'run_paused') return 'The run is already paused.'
		return 'The run is no longer active, so it cannot be paused.'
	}
	if (status === 500) {
		const message = isObject(body) ? body['message'] : undefined
		return typeof message === 'string' && message !== '' ? message : 'The pause request could not be saved.'
	}
	return 'The pause request was rejected.'
}
