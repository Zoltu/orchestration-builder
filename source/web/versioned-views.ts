// The per-resource version inputs and payload builders for the three polled endpoints. Each resource has exactly one gather function returning a typed inputs struct and one build function consuming exactly that struct (plus the snapshot leaf that resolves data identified by the struct), so the token derived from the struct covers every input the payload derives from and a field added to the struct forces both the gather and the hash to account for it.

import type { ListRunIds, ReadRunPlanById, ReadRunSnapshotStats, ReadRunSummaryStats, RunCheckpointExists } from '../executor/persistence.js'
import type { RunState } from '../executor/run-state.js'
import type { InteractionModel, InteractionOperationDetail } from './interaction-model-adapter.js'
import { deriveInteractionModel, deriveInteractionOperationDetail } from './interaction-model-adapter.js'
import { renderRunView, type RunSummary, type RunView } from './render.js'
import type { ReadRunListSummary } from './run-list-cache.js'
import type { ReadRunSnapshot } from './snapshot-cache.js'

// The run view's recent-log window: the polled payload carries only the tail, and the full log is reachable through the window endpoint.
export const MAX_LOG_LINES = 200

// Type aliases rather than the persistence interfaces: TypeScript gives a type alias an implicit string index signature, which is what makes the struct assignable to VersionInput's index-signature member, while an interface is not. The gather functions read the persistence types and assign them here, and stableSerialize walks the runtime object, so a field added to the persistence stat shape still flows into the token.
export type FileStat = { size: number; mtimeMs: number }
export type SnapshotStats = { meta: FileStat | null; log: FileStat | null }

export type RunViewInputs = {
	runId: string
	snapshotStats: SnapshotStats
	plan: string | null
	checkpointExists: boolean
	interruptPending: boolean
}

export interface RunViewWithInterrupt extends RunView {
	interruptPending: boolean
}

// The interrupt flag is part of the run view's payload, so it is part of its version: a pending interrupt on the active run changes the payload even though no file changed. activeRunId is consulted so a terminal run viewed while another run is active reports false rather than inheriting the active run's pending interrupt, exactly as the by-id handler has always done.
export function gatherRunViewInputs(
	dependencies: {
		readRunSnapshotStats: ReadRunSnapshotStats
		readRunPlanById: ReadRunPlanById
		runCheckpointExists: RunCheckpointExists
		runState: RunState
		activeRunId: () => string | undefined
	},
	runId: string,
): RunViewInputs | null {
	const snapshotStats = dependencies.readRunSnapshotStats(runId)
	// A run with neither meta nor log is unknown, so there is no payload to version and the caller serves a 404.
	if (snapshotStats.meta === null && snapshotStats.log === null) return null
	return {
		runId,
		snapshotStats,
		plan: dependencies.readRunPlanById(runId),
		checkpointExists: dependencies.runCheckpointExists(runId),
		interruptPending: dependencies.activeRunId() === runId && dependencies.runState.interruptPending(),
	}
}

export function buildRunView(inputs: RunViewInputs, dependencies: { readRunSnapshot: ReadRunSnapshot }): RunViewWithInterrupt {
	const view = renderRunView(dependencies.readRunSnapshot(inputs.runId), { maxLogLines: MAX_LOG_LINES, plan: inputs.plan, checkpointExists: inputs.checkpointExists })
	return { ...view, interruptPending: inputs.interruptPending }
}

// operationId is the URL discriminator: null for the whole model, the requested id for a detail request. It is part of the version because the base model and each operation detail are different representations of the same URL path, and an ETag must identify exactly one of them — otherwise a base token replayed on a ?operation= request could 304 a body the client never received.
export type FlowInputs = { runId: string; operationId: string | null; snapshotStats: SnapshotStats }

export function gatherFlowInputs(dependencies: { readRunSnapshotStats: ReadRunSnapshotStats }, runId: string, operationId: string | null): FlowInputs | null {
	const snapshotStats = dependencies.readRunSnapshotStats(runId)
	if (snapshotStats.meta === null && snapshotStats.log === null) return null
	return { runId, operationId, snapshotStats }
}

export function buildFlowModel(inputs: FlowInputs, dependencies: { readRunSnapshot: ReadRunSnapshot }): InteractionModel {
	return deriveInteractionModel(dependencies.readRunSnapshot(inputs.runId))
}

export function buildFlowOperationDetail(inputs: FlowInputs, dependencies: { readRunSnapshot: ReadRunSnapshot }): InteractionOperationDetail | null {
	if (inputs.operationId === null) return null
	return deriveInteractionOperationDetail(dependencies.readRunSnapshot(inputs.runId), inputs.operationId)
}

export type RunListInputs = {
	runs: Array<{ runId: string; metaStat: FileStat | null; summaryStat: FileStat | null }>
}

// The list payload depends on which runs exist, their newest-first order, and each run's meta and summary freshness. The run-list cache validates freshness on the same two stats, so the token and the cache agree by construction.
export function gatherRunListInputs(dependencies: { listRunIds: ListRunIds; readRunSummaryStats: ReadRunSummaryStats }): RunListInputs {
	const runIds = dependencies.listRunIds().slice().sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
	return {
		runs: runIds.map((runId) => {
			const stats = dependencies.readRunSummaryStats(runId)
			return { runId, metaStat: stats.meta, summaryStat: stats.summary }
		}),
	}
}

export function buildRunList(inputs: RunListInputs, dependencies: { readRunListSummary: ReadRunListSummary }): RunSummary[] {
	return inputs.runs.map((run) => dependencies.readRunListSummary(run.runId))
}
